/**
 * C4 Skeleton (Backstage) — Graph Mutations
 *
 * System, Domain, Team, Service — the top-level organisational graph.
 */
import { createHash } from 'node:crypto';
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding, declaredGrounding, type GroundingFields } from '../grounding.js';
import { linkWrittenIn } from './technology.js';

const commitHash = "SYSTEM";

// ═══════════════════════════════════════════════════════════════════════════════
// C4 Skeleton (Backstage)
// ═══════════════════════════════════════════════════════════════════════════════

export async function mergeSystem(name: string, description: string | undefined, commitHash: string) {
    const urn = buildUrn('system', name);
    // System/Domain/Team come from Backstage catalog parsing — deterministic.
    const prov = astGrounding('backstage-catalog@v1');
    await run(
        `MERGE (s:System {id: $urn})
     ON CREATE SET s.valid_from_commit = $commitHash, s.valid_to_commit = null, s.name = $name, s.description = $description, s.createdAt = timestamp()
     ON MATCH SET s.valid_from_commit = coalesce(s.valid_from_commit, $commitHash), s.valid_to_commit = null, s.description = coalesce($description, s.description)
     ${groundingWriteClause('s')}`,
        { urn, name, description: description ?? null, commitHash, ...groundingParams(prov, commitHash) },
    );
}

export async function mergeDomain(name: string, description: string | undefined, commitHash: string) {
    const urn = buildUrn('domain', name);
    const prov = astGrounding('backstage-catalog@v1');
    await run(
        `MERGE (d:Domain {id: $urn})
     ON CREATE SET d.valid_from_commit = $commitHash, d.valid_to_commit = null, d.name = $name, d.description = $description, d.createdAt = timestamp()
     ON MATCH SET d.valid_from_commit = coalesce(d.valid_from_commit, $commitHash), d.valid_to_commit = null, d.description = coalesce($description, d.description)
     ${groundingWriteClause('d')}`,
        { urn, name, description: description ?? null, commitHash, ...groundingParams(prov, commitHash) },
    );
}

export async function mergeTeam(
    name: string,
    commitHash: string,
    options?: { teamType?: string }
) {
    const urn = buildUrn('team', name);
    const prov = astGrounding('backstage-catalog@v1');
    await run(
        `MERGE (t:Team {id: $urn})
         ON CREATE SET t.valid_from_commit = $commitHash,
                       t.valid_to_commit = null,
                       t.name = $name,
                       t.teamType = $teamType,
                       t.createdAt = timestamp()
         ON MATCH SET  t.valid_from_commit = coalesce(t.valid_from_commit, $commitHash),
                       t.valid_to_commit = null,
                       t.teamType = coalesce($teamType, t.teamType)
         ${groundingWriteClause('t')}`,
        { urn, name, commitHash, teamType: options?.teamType ?? null, ...groundingParams(prov, commitHash) },
    );
}

/**
 * Merge a Service node scoped to its qualified repository name.
 * URN: cr:service:{qualifiedRepoName}:{name}
 * This prevents global collisions when multiple repos define services with identical names.
 */
export async function mergeService(
    qualifiedRepoName: string,
    name: string,
    language: string | undefined,
    description: string | undefined,
    catalogName: string | undefined,
    catalogSource: string | undefined,
    branch: string | undefined,
    commit: string | undefined,
    commitHash: string,
    grounding?: GroundingFields,
) {
    const urn = buildUrn('service', qualifiedRepoName, name);
    const params: Record<string, unknown> = {
        urn, name, description, branch, commit, commitHash,
        catalogName: catalogName ?? null,
        catalogSource: catalogSource ?? null,
        ...groundingParams(grounding, commitHash),
    };

    let setClauses = [
        's.name = $name',
        's.valid_from_commit = coalesce(s.valid_from_commit, $commitHash)',
        's.valid_to_commit = null',
        's.createdAt = coalesce(s.createdAt, timestamp())',
    ];
    if (description !== undefined) setClauses.push('s.description = coalesce($description, s.description)');
    if (catalogName !== undefined) setClauses.push('s.catalogName = $catalogName');
    if (catalogSource !== undefined) setClauses.push('s.catalogSources = CASE WHEN $catalogSource IN coalesce(s.catalogSources, []) THEN s.catalogSources ELSE coalesce(s.catalogSources, []) + $catalogSource END');
    if (branch !== undefined) setClauses.push('s.branch = coalesce($branch, s.branch)');
    if (commit !== undefined) setClauses.push('s.commit = coalesce($commit, s.commit)');

    const query = `
    MERGE (s:Service {id: $urn})
    SET ${setClauses.join(', ')}
    ${groundingWriteClause('s')}
  `;
    await run(query, params);

    if (language && language !== 'unknown') {
        await linkWrittenIn(urn, language, commitHash);
    }
}

export async function updateServiceLanguage(qualifiedRepoName: string, serviceName: string, language: string, commitHash: string) {
    const urn = buildUrn('service', qualifiedRepoName, serviceName);
    if (language && language !== 'unknown') {
        await linkWrittenIn(urn, language, commitHash);
    }
}

export async function linkSystemContainsService(systemName: string, qualifiedRepoName: string, serviceName: string, commitHash: string, source?: string) {
    const sysUrn = buildUrn('system', systemName);
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (sys:System {id: $sysUrn}), (svc:Service {id: $sUrn})
     MERGE (sys)-[rel:CONTAINS]->(svc)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null, rel.source = $source
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null, rel.source = coalesce($source, rel.source)`,
        { sysUrn, sUrn, commitHash, source: source ?? null },
    );
}

export async function linkSystemPartOfDomain(systemName: string, domainName: string, commitHash: string) {
    const sysUrn = buildUrn('system', systemName);
    const dUrn = buildUrn('domain', domainName);
    await run(
        `MATCH (sys:System {id: $sysUrn}), (dom:Domain {id: $dUrn})
     MERGE (sys)-[rel:PART_OF]->(dom)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sysUrn, dUrn , commitHash },
    );
}

export async function linkTeamOwnsService(
    teamName: string,
    qualifiedRepoName: string,
    serviceName: string,
    commitHash: string,
    source: string = 'backstage'
) {
    const tUrn = buildUrn('team', teamName);
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (t:Team {id: $tUrn}), (svc:Service {id: $sUrn})
         MERGE (t)-[rel:OWNS]->(svc)
         ON CREATE SET rel.valid_from_commit = $commitHash,
                       rel.valid_to_commit = null,
                       rel.source = $source
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null,
                       rel.source = $source`,
        { tUrn, sUrn, source, commitHash },
    );
}

export async function linkTeamOwnsRepository(
    teamName: string, 
    qualifiedRepoName: string, 
    source: string, 
    commitHash: string
) {
    const tUrn = buildUrn('team', teamName);
    const rUrn = buildUrn('repository', qualifiedRepoName);
    await run(
        `MATCH (t:Team {id: $tUrn}), (r:Repository {id: $rUrn})
         MERGE (t)-[rel:OWNS]->(r)
         ON CREATE SET rel.valid_from_commit = $commitHash,
                       rel.valid_to_commit = null,
                       rel.source = $source
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null,
                       rel.source = $source`,
        { tUrn, rUrn, source, commitHash },
    );
}

export function catalogEntityUrn(
    qualifiedRepoName: string,
    catalogSource: string,
    kind: string,
    namespace: string,
    name: string,
): string {
    return buildUrn('catalogentity', qualifiedRepoName, catalogSource, kind.toLowerCase(), namespace, name);
}

export interface CatalogEntityParams {
    qualifiedRepoName: string;
    name: string;
    catalogSource: string;
    kind: string;
    namespace: string;
    entityRef: string;
    type?: string;
    owner?: string;
    system?: string;
    description?: string;
    lifecycle?: string;
    dependsOnJson?: string;
    partOfJson?: string;
    providesApisJson?: string;
    consumesApisJson?: string;
    labelsJson?: string;
    tagsJson?: string;
    linksJson?: string;
    specJson?: string;
    commitHash: string;
}

export async function mergeCatalogEntity(params: CatalogEntityParams) {
    const urn = catalogEntityUrn(
        params.qualifiedRepoName, params.catalogSource,
        params.kind, params.namespace, params.name,
    );
    const prov = astGrounding(`${params.catalogSource}-catalog@v1`);
    await run(
        `MERGE (c:CatalogEntity {id: $urn})
         ON CREATE SET c.valid_from_commit = $commitHash,
                       c.valid_to_commit = null,
                       c.name = $name,
                       c.catalogSource = $catalogSource,
                       c.kind = $kind,
                       c.namespace = $namespace,
                       c.entityRef = $entityRef,
                       c.type = $type,
                       c.owner = $owner,
                       c.system = $system,
                       c.description = $description,
                       c.lifecycle = $lifecycle,
                       c.dependsOnJson = $dependsOnJson,
                       c.partOfJson = $partOfJson,
                       c.providesApisJson = $providesApisJson,
                       c.consumesApisJson = $consumesApisJson,
                       c.labelsJson = $labelsJson,
                       c.tagsJson = $tagsJson,
                       c.linksJson = $linksJson,
                       c.specJson = $specJson,
                       c.createdAt = timestamp()
         ON MATCH SET  c.valid_from_commit = coalesce(c.valid_from_commit, $commitHash),
                       c.valid_to_commit = null,
                       c.catalogSource = $catalogSource,
                       c.kind = $kind,
                       c.namespace = $namespace,
                       c.entityRef = $entityRef,
                       c.type = coalesce($type, c.type),
                       c.owner = coalesce($owner, c.owner),
                       c.system = coalesce($system, c.system),
                       c.description = coalesce($description, c.description),
                       c.lifecycle = coalesce($lifecycle, c.lifecycle),
                       c.dependsOnJson = coalesce($dependsOnJson, c.dependsOnJson),
                       c.partOfJson = coalesce($partOfJson, c.partOfJson),
                       c.providesApisJson = coalesce($providesApisJson, c.providesApisJson),
                       c.consumesApisJson = coalesce($consumesApisJson, c.consumesApisJson),
                       c.labelsJson = coalesce($labelsJson, c.labelsJson),
                       c.tagsJson = coalesce($tagsJson, c.tagsJson),
                       c.linksJson = coalesce($linksJson, c.linksJson),
                       c.specJson = coalesce($specJson, c.specJson)
         ${groundingWriteClause('c')}`,
        {
            urn,
            name: params.name,
            catalogSource: params.catalogSource,
            kind: params.kind,
            namespace: params.namespace,
            entityRef: params.entityRef,
            type: params.type ?? null,
            owner: params.owner ?? null,
            system: params.system ?? null,
            description: params.description ?? null,
            lifecycle: params.lifecycle ?? null,
            dependsOnJson: params.dependsOnJson ?? null,
            partOfJson: params.partOfJson ?? null,
            providesApisJson: params.providesApisJson ?? null,
            consumesApisJson: params.consumesApisJson ?? null,
            labelsJson: params.labelsJson ?? null,
            tagsJson: params.tagsJson ?? null,
            linksJson: params.linksJson ?? null,
            specJson: params.specJson ?? null,
            commitHash: params.commitHash,
            ...groundingParams(prov, params.commitHash),
        },
    );
}

export async function linkCatalogEntityToRepository(
    qualifiedRepoName: string,
    catalogSource: string,
    kind: string,
    namespace: string,
    catalogEntityName: string,
    commitHash: string,
) {
    const cUrn = catalogEntityUrn(qualifiedRepoName, catalogSource, kind, namespace, catalogEntityName);
    const rUrn = buildUrn('repository', qualifiedRepoName);
    // The Service and Repository anchors are mutually exclusive (the writer
    // resolves one or the other); drop the opposite anchor so re-ingests heal
    // stale edges left by an earlier resolution.
    await run(
        `MATCH (c:CatalogEntity {id: $cUrn}), (r:Repository {id: $rUrn})
         MERGE (c)-[rel:DESCRIBES]->(r)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null
         WITH c
         OPTIONAL MATCH (c)-[stale:DESCRIBES]->(:Service)
         DELETE stale`,
        { cUrn, rUrn, commitHash },
    );
}

export async function linkCatalogEntityToService(
    qualifiedRepoName: string,
    catalogSource: string,
    kind: string,
    namespace: string,
    catalogEntityName: string,
    serviceName: string,
    commitHash: string,
    matchedBy: 'identity' | 'partOf',
) {
    const cUrn = catalogEntityUrn(qualifiedRepoName, catalogSource, kind, namespace, catalogEntityName);
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    // Mirror of linkCatalogEntityToRepository: once the entity resolves to a
    // Service, any stale Repository fallback anchor from a previous ingest
    // must go — the two anchors are mutually exclusive.
    await run(
        `MATCH (c:CatalogEntity {id: $cUrn}), (s:Service {id: $sUrn})
         MERGE (c)-[rel:DESCRIBES]->(s)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null, rel.matchedBy = $matchedBy
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null, rel.matchedBy = $matchedBy
         WITH c
         OPTIONAL MATCH (c)-[stale:DESCRIBES]->(:Repository)
         DELETE stale`,
        { cUrn, sUrn, commitHash, matchedBy },
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-Repo `DEPENDS_ON` Late Binding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pure tie-breaker for late-binding candidates. Returns a single Service
 * URN if exactly one candidate exists, or one is preferred by `catalogName`
 * over `name`-only matches; returns null on ambiguity or absence.
 *
 * Exported for unit testing.
 */
export type BindCandidate = { id: string; matchedBy: 'catalogName' | 'name' };

export function selectBindTarget(candidates: BindCandidate[]): string | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].id;
    const byCatalog = candidates.filter(c => c.matchedBy === 'catalogName');
    if (byCatalog.length === 1) return byCatalog[0].id;
    return null;
}

/**
 * Create a placeholder for a catalog dependency whose target Service has
 * not been ingested yet. URN is global so multiple consumers collapse onto
 * one node.
 */
export async function mergeUnresolvedDependency(
    name: string,
    commitHash: string,
    grounding?: GroundingFields,
) {
    const urn = buildUrn('unresolveddep', name);
    await run(
        `MERGE (u:UnresolvedDependency {id: $urn})
         ON CREATE SET u.valid_from_commit = $commitHash, u.valid_to_commit = null, u.name = $name, u.createdAt = timestamp()
         ON MATCH  SET u.valid_from_commit = coalesce(u.valid_from_commit, $commitHash), u.valid_to_commit = null
         ${groundingWriteClause('u')}`,
        { urn, name, commitHash, ...groundingParams(grounding, commitHash) },
    );
    return urn;
}

/**
 * Link a Service to an UnresolvedDependency. Same edge shape as
 * `linkServiceDependsOnService` so downstream queries (and the late-binding
 * step) can rewire it transparently.
 */
export async function linkServiceDependsOnUnresolved(
    fromQualifiedRepo: string,
    fromService: string,
    targetName: string,
    commitHash: string,
    metadata?: { source?: string; package?: string; protocol?: string },
    grounding?: GroundingFields,
) {
    const fromUrn = buildUrn('service', fromQualifiedRepo, fromService);
    const toUrn = await mergeUnresolvedDependency(targetName, commitHash, grounding);
    await run(
        `MATCH (s:Service {id: $fromUrn}), (u:UnresolvedDependency {id: $toUrn})
         MERGE (s)-[rel:DEPENDS_ON]->(u)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                       rel.depSources = CASE WHEN $depSource IS NOT NULL THEN [$depSource] ELSE [] END,
                       rel.package = $package, rel.protocol = $protocol
         ON MATCH  SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null,
                       rel.depSources = CASE
                           WHEN $depSource IS NULL THEN coalesce(rel.depSources, [])
                           WHEN $depSource IN coalesce(rel.depSources, []) THEN rel.depSources
                           ELSE coalesce(rel.depSources, []) + $depSource
                       END,
                       rel.package = coalesce($package, rel.package),
                       rel.protocol = coalesce($protocol, rel.protocol)
         ${groundingWriteClause('rel')}`,
        {
            fromUrn, toUrn, commitHash,
            depSource: metadata?.source ?? null,
            package: metadata?.package ?? null,
            protocol: metadata?.protocol ?? null,
            ...groundingParams(grounding, commitHash),
        },
    );
}

export interface BindUnresolvedResult {
    boundEdges: number;
    boundUnresolvedNodes: number;
    ambiguous: Array<{ name: string; candidates: number }>;
}

/**
 * Reconcile every :UnresolvedDependency to a real :Service.
 *
 * Match order (deterministic):
 *   1. exact catalogName match
 *   2. fallback to name match (when no catalogName candidate exists)
 *
 * Skips ambiguous cases (>1 candidates) — the node stays for governance
 * visibility. The caller is expected to log the `ambiguous` array.
 */
export async function bindUnresolvedDependencies(
    commitHash: string,
): Promise<BindUnresolvedResult> {
    // Step 1: collect candidates per UnresolvedDependency. Cap at 2 to detect
    // ambiguity without scanning the full Service set.
    const collectResult = await run(
        `MATCH (u:UnresolvedDependency)
         OPTIONAL MATCH (s:Service)
         WHERE s.catalogName = u.name OR s.name = u.name
         WITH u, s
         ORDER BY (CASE WHEN s.catalogName = u.name THEN 0 ELSE 1 END), s.id
         WITH u, collect({id: s.id, matchedBy: CASE WHEN s.catalogName = u.name THEN 'catalogName' ELSE 'name' END})[0..2] AS cands
         RETURN u.id AS uid, u.name AS uname, cands`,
        {},
    );

    const ambiguous: BindUnresolvedResult['ambiguous'] = [];
    const bindings: Array<{ uid: string; targetId: string; matchedBy: 'catalogName' | 'name' }> = [];
    const unmatchedUids: string[] = [];

    for (const record of collectResult.records) {
        const rawCands = (record.get('cands') ?? []) as Array<BindCandidate | { id: null }>;
        const cands = rawCands.filter((c): c is BindCandidate => !!c?.id) as BindCandidate[];

        if (cands.length === 0) {
            // No :Service match in the entire graph — never bindable. Drop.
            unmatchedUids.push(record.get('uid'));
            continue;
        }

        const target = selectBindTarget(cands);
        if (target === null) {
            // Multiple candidates, none uniquely preferred. Keep for governance.
            ambiguous.push({ name: record.get('uname'), candidates: cands.length });
            continue;
        }
        const matchedBy = cands.find(c => c.id === target)?.matchedBy ?? 'name';
        bindings.push({ uid: record.get('uid'), targetId: target, matchedBy });
    }

    let deletedNodes = 0;
    let boundEdges = 0;

    // Rewire each binding's edges, then DETACH DELETE the bound node.
    for (const b of bindings) {
        const rewireResult = await run(
            `MATCH (u:UnresolvedDependency {id: $uid})
             MATCH (target:Service {id: $targetId})
             MATCH (consumer:Service)-[r:DEPENDS_ON]->(u)
             MERGE (consumer)-[newR:DEPENDS_ON]->(target)
             ON CREATE SET newR.valid_from_commit = $commitHash, newR.valid_to_commit = null,
                           newR.depSources = coalesce(r.depSources, []), newR.package = r.package, newR.protocol = r.protocol,
                           newR.matchedBy = $matchedBy
             ON MATCH  SET newR.valid_to_commit = null,
                           newR.depSources = reduce(acc = coalesce(newR.depSources, []), s IN coalesce(r.depSources, []) | CASE WHEN s IN acc THEN acc ELSE acc + s END),
                           newR.package = coalesce(r.package, newR.package),
                           newR.protocol = coalesce(r.protocol, newR.protocol),
                           newR.matchedBy = $matchedBy
             ${groundingWriteClause('newR')}
             DELETE r
             RETURN count(newR) AS rewired`,
            { uid: b.uid, targetId: b.targetId, matchedBy: b.matchedBy, commitHash,
              ...groundingParams(declaredGrounding('catalog-dependson@v1'), commitHash) },
        );
        boundEdges += Number(rewireResult.records[0]?.get('rewired') ?? 0);

        const deleteResult = await run(
            `MATCH (u:UnresolvedDependency {id: $uid})
             DETACH DELETE u
             RETURN count(u) AS deleted`,
            { uid: b.uid },
        );
        deletedNodes += Number(deleteResult.records[0]?.get('deleted') ?? 0);
    }

    // DETACH DELETE unbindable placeholders (no :Service candidate in the graph).
    // These are typically `resource:*` references (mysql, rabbitmq, …) that the
    // Backstage extractor leaves to code analysis to materialise as :Datastore /
    // :MessageChannel — they will never resolve to a :Service.
    if (unmatchedUids.length > 0) {
        const dropResult = await run(
            `UNWIND $uids AS uid
             MATCH (u:UnresolvedDependency {id: uid})
             DETACH DELETE u
             RETURN count(u) AS deleted`,
            { uids: unmatchedUids },
        );
        deletedNodes += Number(dropResult.records[0]?.get('deleted') ?? 0);
    }

    return { boundEdges, boundUnresolvedNodes: deletedNodes, ambiguous };
}

/**
 * Hard-delete :UnresolvedDependency nodes with no incoming DEPENDS_ON edge.
 * POC mode: re-running ingestion regenerates them if still referenced.
 */
export async function gcOrphanUnresolvedDependencies(): Promise<number> {
    const result = await run(
        `MATCH (u:UnresolvedDependency)
         WHERE NOT (:Service)-[:DEPENDS_ON]->(u)
         WITH u, u.id AS uid
         DETACH DELETE u
         RETURN count(uid) AS removed`,
        {},
    );
    return Number(result.records[0]?.get('removed') ?? 0);
}

/**
 * Link a service dependency between two scoped services.
 * Both fromService and toService are qualified as {repoName}:{name}
 * to prevent cross-repo collisions.
 */
export async function linkServiceDependsOnService(
    fromQualifiedRepo: string,
    fromService: string,
    toQualifiedRepo: string,
    toService: string,
    commitHash: string,
    metadata?: { source?: string; package?: string; protocol?: string },
    grounding?: GroundingFields,
) {
    const fromUrn = buildUrn('service', fromQualifiedRepo, fromService);
    const toUrn = buildUrn('service', toQualifiedRepo, toService);
    await run(
        `MATCH (s1:Service {id: $fromUrn})
     MERGE (s2:Service {id: $toUrn})
     ON CREATE SET s2.valid_from_commit = $commitHash, s2.valid_to_commit = null, s2.name = $toService, s2.createdAt = timestamp()
     ON MATCH SET s2.valid_from_commit = coalesce(s2.valid_from_commit, $commitHash), s2.valid_to_commit = null
     MERGE (s1)-[rel:DEPENDS_ON]->(s2)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                   rel.depSources = CASE WHEN $depSource IS NOT NULL THEN [$depSource] ELSE [] END,
                   rel.package = $package, rel.protocol = $protocol
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null,
                  rel.depSources = CASE
                      WHEN $depSource IS NULL THEN coalesce(rel.depSources, [])
                      WHEN $depSource IN coalesce(rel.depSources, []) THEN rel.depSources
                      ELSE coalesce(rel.depSources, []) + $depSource
                  END,
                  rel.package = coalesce($package, rel.package), rel.protocol = coalesce($protocol, rel.protocol)
     ${groundingWriteClause('rel')}`,
        {
            fromUrn, toUrn, toService, commitHash,
            depSource: metadata?.source ?? null,
            package: metadata?.package ?? null,
            protocol: metadata?.protocol ?? null,
            ...groundingParams(grounding, commitHash),
        },
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Backstage metadata.links — Link nodes + HAS_LINK edges
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a Link URN from URL hash, scoped under the qualified repo so that
 * two services in the same repo declaring the same URL share one Link node.
 */
export function linkUrn(qualifiedRepoName: string, url: string): string {
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    return buildUrn('link', qualifiedRepoName, hash);
}

export async function mergeLink(
    qualifiedRepoName: string,
    url: string,
    title: string | undefined,
    icon: string | undefined,
    type: string | undefined,
    commitHash: string,
) {
    const urn = linkUrn(qualifiedRepoName, url);
    const prov = astGrounding('backstage-catalog-links@v1');
    await run(
        `MERGE (l:Link {id: $urn})
         ON CREATE SET l.valid_from_commit = $commitHash, l.valid_to_commit = null,
                       l.url = $url, l.title = $title, l.icon = $icon, l.type = $type,
                       l.createdAt = timestamp()
         ON MATCH SET  l.valid_from_commit = coalesce(l.valid_from_commit, $commitHash),
                       l.valid_to_commit = null,
                       l.title = coalesce($title, l.title),
                       l.icon = coalesce($icon, l.icon),
                       l.type = coalesce($type, l.type)
         ${groundingWriteClause('l')}`,
        {
            urn, url,
            title: title ?? null,
            icon: icon ?? null,
            type: type ?? null,
            commitHash,
            ...groundingParams(prov, commitHash),
        },
    );
    return urn;
}

export async function linkServiceHasLink(
    qualifiedRepoName: string,
    serviceName: string,
    linkId: string,
    commitHash: string,
) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (s:Service {id: $sUrn}), (l:Link {id: $linkId})
         MERGE (s)-[rel:HAS_LINK]->(l)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null`,
        { sUrn, linkId, commitHash },
    );
}
