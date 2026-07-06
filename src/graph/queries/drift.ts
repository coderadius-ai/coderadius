import { run } from '../mutations/_run.js';
import {
    classifyDependencyDrift,
    classifyOwnerFacts,
    computeDriftScore,
    computeVerifiableCoverage,
    type OwnerFact,
    type ResolvedRef,
    type ObservedTarget,
} from './drift-classify.js';

// Node labels a Backstage/Cortex `dependsOn` ref can point at. Resolution and
// the observed-edge scan both use this set; keep them in sync.
const DEP_LABELS = ['Service', 'Library', 'Datastore', 'Cache', 'MessageBroker', 'MessageChannel'];
const DEP_LABEL_PREDICATE = (alias: string) => DEP_LABELS.map(l => `${alias}:${l}`).join(' OR ');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GhostService {
    name: string;
    catalogSource: string;
    entityRef: string;
    type: string | null;
    owner: string | null;
    system: string | null;
    repositoryName: string | null;
}

export interface OrphanService {
    name: string;
    urn: string;
    language: string | null;
    codeOwner: string | null;
    repositoryName: string | null;
}

/** Off-score: a catalog-vs-CODEOWNERS owner name mismatch we cannot ground to a
 *  single identity. Surfaced for review, never a score-lowering fabricated drift. */
export interface OwnerReviewItem {
    serviceName: string;
    serviceUrn: string;
    catalogOwner: string;
    codeOwner: string;
}

/** Off-score: the catalog declares a system for a service but no `:System`
 *  membership was built. System membership is catalog-only (no independent code
 *  signal), so this is an ingestion-completeness gap, not catalog-vs-code drift. */
export interface SystemCompletenessItem {
    serviceName: string;
    serviceUrn: string;
    declaredSystem: string;
}

/** Grounded dependency drift: declared facts that resolve to a real node but
 *  disagree with the observed edges (catalog claims it / code does more). */
export interface DependencyDrift {
    serviceName: string;
    serviceUrn: string;
    groundedMissing: string[];
    observedUndeclared: string[];
}

/** Declared facts that resolve to no node in scope (cross-repo, spec-less),
 *  plus the ambiguous observed edges they make unverifiable. Off-score. */
export interface UnverifiableFact {
    serviceName: string;
    serviceUrn: string;
    refs: string[];
}

export interface CatalogDriftReport {
    ghostServices: GhostService[];
    orphanServices: OrphanService[];
    /** Off-score: owner name mismatches we cannot ground (review queue). */
    ownerReview: OwnerReviewItem[];
    /** Off-score: declared-but-unbuilt System memberships (completeness). */
    systemCompleteness: SystemCompletenessItem[];
    dependencyDrift: DependencyDrift[];
    unverifiable: UnverifiableFact[];
    summary: {
        totalCatalogEntities: number;
        totalServices: number;
        totalGhosts: number;
        totalOrphans: number;
        /** Owner mismatches reconciled to one identity (same Team / approved alias). */
        ownerReconciledCount: number;
        /** Owner mismatches we cannot ground — off-score review. */
        ownerReviewCount: number;
        /** Declared-but-unbuilt System memberships — off-score completeness. */
        systemCompletenessCount: number;
        totalDependencyDrift: number;
        entitiesWithGroundedDrift: number;
        unverifiableCount: number;
        driftDenominator: number;
        driftScore: number;
        verifiableCoverage: number;
    };
    meta: {
        sourceFilter: string | null;
        generatedAt: string;
    };
}

// ─── Individual Queries ─────────────────────────────────────────────────────

export async function getGhostServices(sourceFilter?: string): Promise<GhostService[]> {
    const sourceClause = sourceFilter ? 'AND c.catalogSource = $sourceFilter' : '';
    const result = await run(
        `MATCH (c:CatalogEntity)
         WHERE c.valid_to_commit IS NULL
           AND c.kind = 'Component'
           AND NOT (c)-[:DESCRIBES]->(:Service)
           AND NOT (c)-[:DESCRIBES]->(:Repository)
           ${sourceClause}
         OPTIONAL MATCH (c)-[:DESCRIBES]->(r:Repository)
         RETURN c.name AS name, c.catalogSource AS catalogSource, c.entityRef AS entityRef,
                c.type AS type, c.owner AS owner, c.system AS system,
                r.name AS repositoryName`,
        { sourceFilter: sourceFilter ?? null },
    );
    return result.records.map(r => ({
        name: r.get('name'),
        catalogSource: r.get('catalogSource'),
        entityRef: r.get('entityRef'),
        type: r.get('type'),
        owner: r.get('owner'),
        system: r.get('system'),
        repositoryName: r.get('repositoryName'),
    }));
}

export async function getOrphanServices(sourceFilter?: string): Promise<OrphanService[]> {
    const whereClause = sourceFilter
        ? `WHERE s.valid_to_commit IS NULL
           AND NOT (:CatalogEntity {catalogSource: $sourceFilter})-[:DESCRIBES]->(s)
           AND NOT (s)-[:STORED_IN]->(:Repository)<-[:DESCRIBES]-(:CatalogEntity {catalogSource: $sourceFilter})`
        : `WHERE s.valid_to_commit IS NULL
           AND NOT (:CatalogEntity)-[:DESCRIBES]->(s)
           AND NOT (s)-[:STORED_IN]->(:Repository)<-[:DESCRIBES]-(:CatalogEntity)`;

    const result = await run(
        `MATCH (s:Service)
         ${whereClause}
         OPTIONAL MATCH (t:Team)-[o:OWNS]->(s) WHERE o.source = 'codeowners'
         OPTIONAL MATCH (s)-[:STORED_IN]->(r:Repository)
         OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
         RETURN s.name AS name, s.id AS urn, slang.slug AS language,
                t.name AS codeOwner, r.name AS repositoryName`,
        { sourceFilter: sourceFilter ?? null },
    );
    return result.records.map(r => ({
        name: r.get('name'),
        urn: r.get('urn'),
        language: r.get('language'),
        codeOwner: r.get('codeOwner'),
        repositoryName: r.get('repositoryName'),
    }));
}

export interface OwnerReconciliationResult {
    reconciledCount: number;
    review: OwnerReviewItem[];
}

/**
 * Grounded-or-unverifiable owner reconciliation.
 *
 * Catalog owner and CODEOWNERS owner are separate, name-keyed Team nodes. We only
 * surface a mismatch when the two are genuinely different identities, then ask
 * whether they are reconciled (same Team is excluded by the id guard; an approved
 * `:TeamAlias` bridging the two names counts as reconciled). Reconciled mismatches
 * are aligned; the rest are off-score review. A name spelling never fabricates drift.
 */
export async function getOwnerReconciliation(): Promise<OwnerReconciliationResult> {
    // An approved :TeamAlias bridging the two team names counts as reconciled.
    // OPTIONAL MATCH (+ count) rather than EXISTS{}: Memgraph only allows EXISTS
    // in a WHERE clause, not as a returned value.
    const result = await run(
        `MATCH (catalogTeam:Team)-[ownsCat:OWNS]->(s:Service)<-[ownsCode:OWNS]-(codeTeam:Team)
         WHERE s.valid_to_commit IS NULL
           AND ownsCat.source IN ['backstage', 'cortex']
           AND ownsCode.source IN ['codeowners', 'git-blame']
           AND catalogTeam.id <> codeTeam.id
         OPTIONAL MATCH (a:TeamAlias {status: 'approved'})-[:PROPOSED_ALIAS_OF]->(canon:Team)
           WHERE (canon.id = catalogTeam.id AND a.phantomName = codeTeam.name)
              OR (canon.id = codeTeam.id AND a.phantomName = catalogTeam.name)
         WITH s, catalogTeam, codeTeam, count(a) AS aliasCount
         RETURN s.name AS serviceName, s.id AS serviceUrn,
                catalogTeam.name AS catalogOwner, codeTeam.name AS codeOwner, aliasCount`,
        {},
    );
    const facts: OwnerFact[] = result.records.map(r => ({
        serviceName: r.get('serviceName'),
        serviceUrn: r.get('serviceUrn'),
        catalogOwner: r.get('catalogOwner'),
        codeOwner: r.get('codeOwner'),
        reconciled: Number(r.get('aliasCount') ?? 0) > 0,
    }));
    const { reconciled, unverifiable } = classifyOwnerFacts(facts);
    return {
        reconciledCount: reconciled.length,
        review: unverifiable.map(f => ({
            serviceName: f.serviceName,
            serviceUrn: f.serviceUrn,
            catalogOwner: f.catalogOwner,
            codeOwner: f.codeOwner,
        })),
    };
}

/**
 * System completeness (off-score). System membership is derived ONLY from the
 * catalog (the `c.system` property and the `:System` node both come from
 * Backstage), so there is no independent code signal to reconcile against. We
 * report only the completeness gap: the catalog declares a system but no
 * `:System`-[:CONTAINS]->service edge was built. This is an ingestion gap, not
 * catalog-vs-code drift, and never lowers the alignment score.
 */
export async function getSystemCompleteness(): Promise<SystemCompletenessItem[]> {
    // OPTIONAL MATCH + `WHERE sys IS NULL` (proven idiom) rather than NOT EXISTS{},
    // for Memgraph compatibility and parity with the dependency-path style.
    const result = await run(
        `MATCH (c:CatalogEntity)-[:DESCRIBES]->(s:Service)
         WHERE c.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
           AND c.system IS NOT NULL AND c.kind = 'Component'
         OPTIONAL MATCH (sys:System)-[:CONTAINS]->(s) WHERE sys.valid_to_commit IS NULL
         WITH s, c, sys
         WHERE sys IS NULL
         RETURN s.name AS serviceName, s.id AS serviceUrn, c.system AS declaredSystem`,
        {},
    );
    return result.records.map(r => ({
        serviceName: r.get('serviceName'),
        serviceUrn: r.get('serviceUrn'),
        declaredSystem: r.get('declaredSystem'),
    }));
}

export interface DependencyReconciliation {
    drift: DependencyDrift[];
    unverifiable: UnverifiableFact[];
    verifiedFacts: number;
    unverifiedFacts: number;
}

/**
 * Grounded reconciliation of declared `dependsOn` vs observed dependency edges.
 *
 * A declared ref is resolved to a real node by EXACT identity (a single node
 * whose `catalogName` or `name` equals the ref, among the dependency labels).
 * Refs that resolve to no node (or ambiguously to several) are unverifiable.
 * `classifyDependencyDrift` then decides aligned / grounded-drift / unverifiable.
 * No string normalization, no fuzzy matching.
 */
export async function getDependencyReconciliation(): Promise<DependencyReconciliation> {
    const catResult = await run(
        `MATCH (c:CatalogEntity)-[:DESCRIBES]->(s:Service)
         WHERE c.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
           AND c.dependsOnJson IS NOT NULL AND c.kind = 'Component'
         RETURN s.name AS serviceName, s.id AS serviceUrn,
                c.dependsOnJson AS dependsOnJson`,
        {},
    );

    // Parse declared refs per service (already syntax-parsed to bare names at
    // ingestion) and gather the distinct set to resolve in one query.
    const perService = catResult.records.map(r => ({
        serviceName: r.get('serviceName') as string,
        serviceUrn: r.get('serviceUrn') as string,
        declared: dedupe(
            (JSON.parse(r.get('dependsOnJson')) as string[]).map(d => d?.trim()).filter(Boolean),
        ),
    }));
    const allNames = dedupe(perService.flatMap(p => p.declared));

    // Exact-identity resolution: a name is grounded only when it matches exactly
    // one node (ambiguous multi-matches stay unverifiable, like the dep binder).
    const resolved = new Map<string, string>();
    if (allNames.length > 0) {
        const resResult = await run(
            `UNWIND $names AS nm
             OPTIONAL MATCH (n)
             WHERE (${DEP_LABEL_PREDICATE('n')})
               AND n.valid_to_commit IS NULL
               AND (n.catalogName = nm OR n.name = nm)
             RETURN nm AS name, collect(DISTINCT n.id) AS urns`,
            { names: allNames },
        );
        for (const r of resResult.records) {
            const urns: string[] = r.get('urns') ?? [];
            if (urns.length === 1) resolved.set(r.get('name'), urns[0]);
        }
    }

    // Observed dependency edges per service (Service/Library/Datastore/Cache/Broker/Channel).
    // Name-based reconciliation can only see named targets; a nameless node (e.g. a
    // broker identified by host) is not part of declared-ref matching.
    const obsResult = await run(
        `MATCH (s:Service)-[:DEPENDS_ON|CONNECTS_TO]->(t)
         WHERE s.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
           AND (${DEP_LABEL_PREDICATE('t')})
           AND t.name IS NOT NULL AND t.name <> ''
         RETURN s.id AS serviceUrn, collect(DISTINCT {urn: t.id, name: t.name}) AS observed`,
        {},
    );
    const observedMap = new Map<string, ObservedTarget[]>();
    for (const r of obsResult.records) {
        observedMap.set(r.get('serviceUrn'), (r.get('observed') ?? []) as ObservedTarget[]);
    }

    const drift: DependencyDrift[] = [];
    const unverifiable: UnverifiableFact[] = [];
    let verifiedFacts = 0;
    let unverifiedFacts = 0;

    for (const p of perService) {
        const declaredResolved: ResolvedRef[] = [];
        const declaredUnresolved: string[] = [];
        for (const ref of p.declared) {
            const urn = resolved.get(ref);
            if (urn) declaredResolved.push({ ref, urn });
            else declaredUnresolved.push(ref);
        }
        verifiedFacts += declaredResolved.length;
        unverifiedFacts += declaredUnresolved.length;

        const c = classifyDependencyDrift(
            declaredResolved,
            declaredUnresolved,
            observedMap.get(p.serviceUrn) ?? [],
        );

        if (c.groundedMissing.length > 0 || c.observedUndeclared.length > 0) {
            drift.push({
                serviceName: p.serviceName,
                serviceUrn: p.serviceUrn,
                groundedMissing: c.groundedMissing,
                observedUndeclared: c.observedUndeclared,
            });
        }
        if (c.unverifiable.length > 0) {
            unverifiable.push({
                serviceName: p.serviceName,
                serviceUrn: p.serviceUrn,
                refs: c.unverifiable,
            });
        }
    }

    return { drift, unverifiable, verifiedFacts, unverifiedFacts };
}

function dedupe(xs: string[]): string[] {
    return [...new Set(xs)];
}

// ─── Aggregated Report ──────────────────────────────────────────────────────

export async function getCatalogDriftReport(sourceFilter?: string): Promise<CatalogDriftReport> {
    const [ghosts, orphans, ownerRecon, systemCompleteness, depReconciliation] =
        await Promise.all([
            getGhostServices(sourceFilter),
            getOrphanServices(sourceFilter),
            getOwnerReconciliation(),
            getSystemCompleteness(),
            getDependencyReconciliation(),
        ]);
    const { drift: depDrift, unverifiable, verifiedFacts, unverifiedFacts } = depReconciliation;

    const totalCatResult = await run(
        `MATCH (c:CatalogEntity) WHERE c.valid_to_commit IS NULL AND c.kind = 'Component'
         RETURN count(c) AS total`,
        {},
    );
    const totalCatalogEntities = Number(totalCatResult.records[0]?.get('total') ?? 0);

    const totalSvcResult = await run(
        `MATCH (s:Service) WHERE s.valid_to_commit IS NULL RETURN count(s) AS total`,
        {},
    );
    const totalServices = Number(totalSvcResult.records[0]?.get('total') ?? 0);

    // Only GROUNDED mismatches lower the score; unverifiable facts are off-score.
    // Owner reconciliation (name mismatch, no grounded identity) and system
    // completeness (catalog-only, no code signal) are deliberately NOT scored.
    const groundedDriftUrns = new Set<string>();
    for (const g of ghosts) groundedDriftUrns.add(g.entityRef);
    for (const o of orphans) groundedDriftUrns.add(o.urn);
    for (const d of depDrift) groundedDriftUrns.add(d.serviceUrn);

    const driftDenominator = totalCatalogEntities + orphans.length;
    const entitiesWithGroundedDrift = groundedDriftUrns.size;
    const driftScore = computeDriftScore(totalCatalogEntities, orphans.length, entitiesWithGroundedDrift);
    const verifiableCoverage = computeVerifiableCoverage(verifiedFacts, unverifiedFacts);

    return {
        ghostServices: ghosts,
        orphanServices: orphans,
        ownerReview: ownerRecon.review,
        systemCompleteness,
        dependencyDrift: depDrift,
        unverifiable,
        summary: {
            totalCatalogEntities,
            totalServices,
            totalGhosts: ghosts.length,
            totalOrphans: orphans.length,
            ownerReconciledCount: ownerRecon.reconciledCount,
            ownerReviewCount: ownerRecon.review.length,
            systemCompletenessCount: systemCompleteness.length,
            totalDependencyDrift: depDrift.length,
            entitiesWithGroundedDrift,
            unverifiableCount: unverifiable.length,
            driftDenominator,
            driftScore,
            verifiableCoverage,
        },
        meta: {
            sourceFilter: sourceFilter ?? null,
            generatedAt: new Date().toISOString(),
        },
    };
}
