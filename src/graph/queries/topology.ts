/**
 * Topology Skeleton Query
 *
 * Extracts the full architectural adjacency map from Memgraph in a single query.
 * This skeleton is injected into the dashboard HTML and used for client-side
 * 1-hop blast radius lookup (O(1) per node via pre-built in/out indexes).
 *
 * Key insight: architectural relationships (CALLS, READS, WRITES, etc.) live
 * on Function nodes, not directly between Services. The query resolves each
 * edge endpoint to its parent architectural node via CONTAINS relationships,
 * mirroring the logic in blast.ts's analyzeBlast().
 *
 * Design constraints:
 *   - NO LIMIT — truncating a security/impact graph is unacceptable.
 *   - Resolves Function → parent Service/Package via CONTAINS.
 *   - Joins Team ownership and Repository in the same query pass.
 */

import { getMemgraphSession } from '../neo4j.js';
import { labelCaseExpr } from '../domain.js';
import {
    ARCH_RELS, BLAST_ARCH_LABELS,
    EMISSION_DIRECTION_RELS, PASSTHROUGH_TYPES, IMPL_EP_DISCOUNT,
} from '../constants.js';
import type { TopologyMap, TopologyNode, TopologyEdge, TopologySchema } from '@coderadius/shared-types';

const SRC_LABEL_FILTER = BLAST_ARCH_LABELS.map(l => `src:${l}`).join(' OR ');
const DST_LABEL_FILTER = BLAST_ARCH_LABELS.map(l => `dst:${l}`).join(' OR ');

/**
 * Accumulate a datastore onto a node, deduped by name. The query fans a
 * DataContainer with N STORED_IN edges into N rows (one per datastore); this
 * collects them all instead of keeping only the first row's datastore. The
 * first name seen becomes the primary ([0]); co-candidates of an ambiguous
 * bind follow. Idempotent on repeated rows for the same (node, datastore).
 */
function addDatastore(node: TopologyNode, name: unknown, host: unknown): void {
    if (typeof name !== 'string' || name.length === 0) return;
    if (!node.datastore) node.datastore = [];
    if (node.datastore.some(d => d.name === name)) return;
    node.datastore.push({ name, host: typeof host === 'string' ? host : null });
}


/**
 * Fetches the full architecture topology from Memgraph.
 *
 * The query finds ALL architectural relationships (including those between
 * Function nodes), then resolves each endpoint UP to its parent architectural
 * node (Service, Package, etc.) via the CONTAINS relationship.
 *
 * Returns a pre-indexed adjacency map with:
 *   - nodes: Record<urn, TopologyNode>
 *   - out[urn]:  edges leaving urn  (upstream providers for urn)
 *   - in[urn]:   edges entering urn (downstream consumers of urn)
 */
export async function getTopologyMap(): Promise<TopologyMap> {
    const session = getMemgraphSession();
    try {
        const srcCaseExpr = labelCaseExpr('src');
        const dstCaseExpr = labelCaseExpr('dst');

        // Tier-3 guard set: URNs of Services whose Repository hosts exactly ONE
        // Service. Only these are eligible for the Repository-ancestor fallback
        // below, so a genuine monorepo (≥2 services on one repo) never inherits
        // a loose Function. Computed up front as a simple list to keep the main
        // query's planner happy (correlated NOT EXISTS inside OPTIONAL MATCH
        // trips Memgraph's "Expected to generate all filters!" planner bug).
        const soleServiceResult = await session.run(
            `MATCH (r:Repository)<-[si:STORED_IN]-(s:Service)
             WHERE si.valid_to_commit IS NULL
               AND s.valid_to_commit IS NULL
               AND r.valid_to_commit IS NULL
             WITH r, collect(DISTINCT s.id) AS svcIds
             WHERE size(svcIds) = 1
             RETURN svcIds[0] AS soleServiceUrn`,
        );
        const soleServiceUrns = soleServiceResult.records
            .map(rec => rec.get('soleServiceUrn') as string)
            .filter(Boolean);

        const result = await session.run(
            `MATCH (a)-[r]->(b)
             WHERE type(r) IN $rels
               AND r.valid_to_commit IS NULL
               AND a.valid_to_commit IS NULL
               AND b.valid_to_commit IS NULL
             // Tier 1: direct CONTAINS parent (Service / Library / Package).
             // Post-fix common case once the pipeline writes the link correctly.
             OPTIONAL MATCH (a)<-[rcaDirect:CONTAINS]-(srcDirect)
               WHERE rcaDirect.valid_to_commit IS NULL
                 AND srcDirect.valid_to_commit IS NULL
                 AND a:Function
                 AND (srcDirect:Service OR srcDirect:Library OR srcDirect:Package)
             OPTIONAL MATCH (b)<-[rcbDirect:CONTAINS]-(tgtDirect)
               WHERE rcbDirect.valid_to_commit IS NULL
                 AND tgtDirect.valid_to_commit IS NULL
                 AND b:Function
                 AND (tgtDirect:Service OR tgtDirect:Library OR tgtDirect:Package)
             // Tier 2: ancestor via SourceFile-OWNS-Service.
             // Salvages topology coverage when the pipeline only wrote the
             // OWNS half of the chain (partial scan or library workspace).
             OPTIONAL MATCH (a)<-[rcaSF:CONTAINS]-(:SourceFile)<-[rcaOwn:OWNS]-(srcAncestor:Service)
               WHERE rcaSF.valid_to_commit IS NULL
                 AND rcaOwn.valid_to_commit IS NULL
                 AND srcAncestor.valid_to_commit IS NULL
                 AND a:Function
             OPTIONAL MATCH (b)<-[rcbSF:CONTAINS]-(:SourceFile)<-[rcbOwn:OWNS]-(tgtAncestor:Service)
               WHERE rcbSF.valid_to_commit IS NULL
                 AND rcbOwn.valid_to_commit IS NULL
                 AND tgtAncestor.valid_to_commit IS NULL
                 AND b:Function
             // Tier 3: ancestor via Repository STORED_IN, ONLY for repos that
             // host exactly one Service (see $soleServiceUrns). Salvages the
             // single-service / non-monorepo case (e.g. a PHP monolith whose
             // Service is catalog-declared and never claims the code files), so
             // its Function IO still surfaces under that Service. Split into two
             // OPTIONAL MATCHes (Function→Repository, then Repository→Service)
             // to keep the chain short and Memgraph-plannable.
             OPTIONAL MATCH (a)<-[rcaRepoSF:CONTAINS]-(:SourceFile)<-[rcaRepoC:CONTAINS]-(repoA:Repository)
               WHERE rcaRepoSF.valid_to_commit IS NULL
                 AND rcaRepoC.valid_to_commit IS NULL
                 AND repoA.valid_to_commit IS NULL
                 AND a:Function
             OPTIONAL MATCH (repoA)<-[rcaRepoSI:STORED_IN]-(srcRepoAncestor:Service)
               WHERE rcaRepoSI.valid_to_commit IS NULL
                 AND srcRepoAncestor.valid_to_commit IS NULL
                 AND srcRepoAncestor.id IN $soleServiceUrns
             OPTIONAL MATCH (b)<-[rcbRepoSF:CONTAINS]-(:SourceFile)<-[rcbRepoC:CONTAINS]-(repoB:Repository)
               WHERE rcbRepoSF.valid_to_commit IS NULL
                 AND rcbRepoC.valid_to_commit IS NULL
                 AND repoB.valid_to_commit IS NULL
                 AND b:Function
             OPTIONAL MATCH (repoB)<-[rcbRepoSI:STORED_IN]-(tgtRepoAncestor:Service)
               WHERE rcbRepoSI.valid_to_commit IS NULL
                 AND tgtRepoAncestor.valid_to_commit IS NULL
                 AND tgtRepoAncestor.id IN $soleServiceUrns
             WITH
                  COALESCE(
                      srcDirect,
                      srcAncestor,
                      srcRepoAncestor,
                      CASE WHEN a:Service OR a:Library OR a:Package OR a:DataContainer OR a:Datastore OR a:MessageChannel OR a:APIEndpoint OR a:SystemProcess THEN a END
                  ) AS src,
                  COALESCE(
                      tgtDirect,
                      tgtAncestor,
                      tgtRepoAncestor,
                      CASE WHEN b:Service OR b:Library OR b:Package OR b:DataContainer OR b:Datastore OR b:MessageChannel OR b:APIEndpoint OR b:SystemProcess THEN b END
                  ) AS dst,
                  type(r) AS relType,
                  r.confidence AS edgeConfidence,
                  a, b
             WHERE src IS NOT NULL
               AND dst IS NOT NULL
               AND src.id <> dst.id
               AND (${SRC_LABEL_FILTER} OR src:Library)
               AND (${DST_LABEL_FILTER} OR dst:Library)
             WITH src, dst, relType, edgeConfidence,
                  collect(DISTINCT CASE WHEN a:Function THEN {name: a.name, file: a.filepath, startLine: a.startLine} ELSE NULL END) AS srcFuncs,
                  collect(DISTINCT CASE WHEN b:Function THEN {name: b.name, file: b.filepath, startLine: b.startLine} ELSE NULL END) AS dstFuncs
             WITH src, dst, relType, edgeConfidence,
                  [f IN (srcFuncs + dstFuncs) WHERE f IS NOT NULL] AS funcs
             OPTIONAL MATCH (srcTeam:Team)-[rst:OWNS]->(src)
               WHERE rst.valid_to_commit IS NULL AND srcTeam.valid_to_commit IS NULL
             OPTIONAL MATCH (dstTeam:Team)-[rdt:OWNS]->(dst)
               WHERE rdt.valid_to_commit IS NULL AND dstTeam.valid_to_commit IS NULL
             OPTIONAL MATCH (src)-[rsr:STORED_IN]->(srcRepo:Repository)
               WHERE rsr.valid_to_commit IS NULL AND srcRepo.valid_to_commit IS NULL
             OPTIONAL MATCH (dst)-[rdr:STORED_IN]->(dstRepo:Repository)
               WHERE rdr.valid_to_commit IS NULL AND dstRepo.valid_to_commit IS NULL
             OPTIONAL MATCH (src:DataContainer)-[srcDsRel:STORED_IN]->(srcDs:Datastore)
               WHERE srcDsRel.valid_to_commit IS NULL AND srcDs.valid_to_commit IS NULL
             OPTIONAL MATCH (srcDs)-[srcEpRel:SERVED_BY]->(srcEp:DatabaseEndpoint)
               WHERE srcEpRel.valid_to_commit IS NULL AND srcEp.valid_to_commit IS NULL
             OPTIONAL MATCH (dst:DataContainer)-[dstDsRel:STORED_IN]->(dstDs:Datastore)
               WHERE dstDsRel.valid_to_commit IS NULL AND dstDs.valid_to_commit IS NULL
             OPTIONAL MATCH (dstDs)-[dstEpRel:SERVED_BY]->(dstEp:DatabaseEndpoint)
               WHERE dstEpRel.valid_to_commit IS NULL AND dstEp.valid_to_commit IS NULL
             OPTIONAL MATCH (src)-[:WRITTEN_IN]->(srcLang:Technology)
             OPTIONAL MATCH (dst)-[:WRITTEN_IN]->(dstLang:Technology)
              RETURN
               src.id AS srcUrn,
               CASE
                 WHEN src.apiKind = 'rest' AND src.method IS NOT NULL
                   THEN src.method + ' ' + COALESCE(src.name, src.path)
                 ELSE COALESCE(src.name, src.path, src.title)
               END AS srcName,
               CASE ${srcCaseExpr} END AS srcType,
               srcTeam.name           AS srcTeam,
               srcRepo.name           AS srcRepoName,
               srcRepo.url            AS srcRepoUrl,
               srcRepo.branch         AS srcRepoBranch,
               src.channelKind        AS srcChannelKind,
               src.tags               AS srcTags,
               src.discoverySource    AS srcDiscoverySource,
               src.technology         AS srcTechnology,
               srcLang.slug           AS srcLanguage,
               src.ecosystem          AS srcEcosystem,
               src.apiKind           AS srcApiKind,
               src.apiSource          AS srcApiSource,
               src.operation          AS srcOperation,
               src.description        AS srcDescription,
               src.title              AS srcTitle,
               src.lastSeenCommit AS srcLastSeenCommit,
               srcDs.name             AS srcDatastoreName,
               srcEp.host             AS srcEndpointHost,
               src.confidence         AS srcConfidence,
               src.source             AS srcProvSource,
               src.quality            AS srcQuality,
               src.needsReview        AS srcNeedsReview,
               dst.id AS tgtUrn,
               CASE
                 WHEN dst.apiKind = 'rest' AND dst.method IS NOT NULL
                   THEN dst.method + ' ' + COALESCE(dst.name, dst.path)
                 ELSE COALESCE(dst.name, dst.path, dst.title)
               END AS tgtName,
               CASE ${dstCaseExpr} END AS tgtType,
               dstTeam.name           AS tgtTeam,
               dstRepo.name           AS tgtRepoName,
               dstRepo.url            AS tgtRepoUrl,
               dstRepo.branch         AS tgtRepoBranch,
               dst.channelKind        AS tgtChannelKind,
               dst.tags               AS tgtTags,
               dst.discoverySource    AS tgtDiscoverySource,
               dst.technology         AS tgtTechnology,
               dstLang.slug           AS tgtLanguage,
               dst.ecosystem          AS tgtEcosystem,
               dst.apiKind           AS tgtApiKind,
               dst.apiSource          AS tgtApiSource,
               dst.operation          AS tgtOperation,
               dst.description        AS tgtDescription,
               dst.title              AS tgtTitle,
               dst.lastSeenCommit AS tgtLastVerifiedCommit,
               dstDs.name             AS tgtDatastoreName,
               dstEp.host             AS tgtEndpointHost,
               dst.confidence         AS tgtConfidence,
               dst.source             AS tgtProvSource,
               dst.quality            AS tgtQuality,
               dst.needsReview        AS tgtNeedsReview,
               relType                AS rel,
               edgeConfidence         AS edgeConfidence,
               funcs                  AS funcs`,
            { rels: [...ARCH_RELS], soleServiceUrns },
        );

        const nodes: Record<string, TopologyNode> = {};
        const out: Record<string, TopologyEdge[]> = {};
        const inMap: Record<string, TopologyEdge[]> = {};

        for (const record of result.records) {
            const srcUrn: string = record.get('srcUrn');
            const tgtUrn: string = record.get('tgtUrn');
            const rel: string = record.get('rel');
            const funcsRaw = record.get('funcs') || [];
            
            // Deduplicate functions (Memgraph list concatenation might duplicate or we want to ensure uniqueness)
            const funcsMap = new Map();
            for (const f of funcsRaw) {
                funcsMap.set(`${f.name}::${f.file}`, f);
            }
            const functions = Array.from(funcsMap.values());

            // Upsert source node — write on first sight, then patch repo/team if they were missing
            const srcRepoRaw = record.get('srcRepoName')
                ? { name: record.get('srcRepoName'), url: record.get('srcRepoUrl') ?? null, mainBranch: record.get('srcRepoBranch') ?? null }
                : null;
            const srcConfidenceRaw = record.get('srcConfidence');
            const srcConfidence = typeof srcConfidenceRaw === 'number' ? srcConfidenceRaw : srcConfidenceRaw ? Number(srcConfidenceRaw) : undefined;
            if (!nodes[srcUrn]) {
                nodes[srcUrn] = {
                    name: record.get('srcName') ?? srcUrn,
                    type: record.get('srcType') ?? 'Unknown',
                    teamOwner: record.get('srcTeam') ?? null,
                    repository: srcRepoRaw,
                    channelKind: record.get('srcChannelKind') ?? null,
                    tags: record.get('srcTags') ?? null,
                    discoverySource: record.get('srcDiscoverySource') ?? null,
                    technology: record.get('srcTechnology') ?? null,
                    language: record.get('srcLanguage') ?? null,
                    ecosystem: record.get('srcEcosystem') ?? null,
                    datastore: null,
                    apiKind: record.get('srcApiKind') ?? null,
                    apiSource: record.get('srcApiSource') ?? null,
                    operation: record.get('srcOperation') ?? null,
                    confidence: Number.isFinite(srcConfidence) ? srcConfidence : undefined,
                    groundingSource: record.get('srcProvSource') ?? null,
                    quality: record.get('srcQuality') ?? null,
                    needsReview: record.get('srcNeedsReview') ?? null,
                    description: record.get('srcDescription') ?? null,
                    title: record.get('srcTitle') ?? null,
                    lastSeenCommit: record.get('srcLastSeenCommit') ?? null,
                };
            } else {
                // Patch missing fields if this record has richer data
                if (!nodes[srcUrn].repository && srcRepoRaw) nodes[srcUrn].repository = srcRepoRaw;
                if (!nodes[srcUrn].teamOwner && record.get('srcTeam')) nodes[srcUrn].teamOwner = record.get('srcTeam');
                if (!nodes[srcUrn].channelKind && record.get('srcChannelKind')) nodes[srcUrn].channelKind = record.get('srcChannelKind');
                if (!nodes[srcUrn].tags && record.get('srcTags')) nodes[srcUrn].tags = record.get('srcTags');
                if (!nodes[srcUrn].discoverySource && record.get('srcDiscoverySource')) nodes[srcUrn].discoverySource = record.get('srcDiscoverySource');
                if (!nodes[srcUrn].technology && record.get('srcTechnology')) nodes[srcUrn].technology = record.get('srcTechnology');
                if (!nodes[srcUrn].language && record.get('srcLanguage')) nodes[srcUrn].language = record.get('srcLanguage');
                if (!nodes[srcUrn].ecosystem && record.get('srcEcosystem')) nodes[srcUrn].ecosystem = record.get('srcEcosystem');
                if (!nodes[srcUrn].apiKind && record.get('srcApiKind')) nodes[srcUrn].apiKind = record.get('srcApiKind');
                if (!nodes[srcUrn].apiSource && record.get('srcApiSource')) nodes[srcUrn].apiSource = record.get('srcApiSource');
                if (!nodes[srcUrn].operation && record.get('srcOperation')) nodes[srcUrn].operation = record.get('srcOperation');
                if (nodes[srcUrn].confidence === undefined && Number.isFinite(srcConfidence)) nodes[srcUrn].confidence = srcConfidence;
                if (!nodes[srcUrn].description && record.get('srcDescription')) nodes[srcUrn].description = record.get('srcDescription');
                if (!nodes[srcUrn].title && record.get('srcTitle')) nodes[srcUrn].title = record.get('srcTitle');
                if (!nodes[srcUrn].lastSeenCommit && record.get('srcLastSeenCommit')) nodes[srcUrn].lastSeenCommit = record.get('srcLastSeenCommit');
            }
            addDatastore(nodes[srcUrn], record.get('srcDatastoreName'), record.get('srcEndpointHost'));

            // Upsert target node — write on first sight, then patch repo/team if they were missing
            const tgtRepoRaw = record.get('tgtRepoName')
                ? { name: record.get('tgtRepoName'), url: record.get('tgtRepoUrl') ?? null, mainBranch: record.get('tgtRepoBranch') ?? null }
                : null;
            const tgtConfidenceRaw = record.get('tgtConfidence');
            const tgtConfidence = typeof tgtConfidenceRaw === 'number' ? tgtConfidenceRaw : tgtConfidenceRaw ? Number(tgtConfidenceRaw) : undefined;
            if (!nodes[tgtUrn]) {
                nodes[tgtUrn] = {
                    name: record.get('tgtName') ?? tgtUrn,
                    type: record.get('tgtType') ?? 'Unknown',
                    teamOwner: record.get('tgtTeam') ?? null,
                    repository: tgtRepoRaw,
                    channelKind: record.get('tgtChannelKind') ?? null,
                    tags: record.get('tgtTags') ?? null,
                    discoverySource: record.get('tgtDiscoverySource') ?? null,
                    technology: record.get('tgtTechnology') ?? null,
                    language: record.get('tgtLanguage') ?? null,
                    ecosystem: record.get('tgtEcosystem') ?? null,
                    datastore: null,
                    apiKind: record.get('tgtApiKind') ?? null,
                    apiSource: record.get('tgtApiSource') ?? null,
                    operation: record.get('tgtOperation') ?? null,
                    confidence: Number.isFinite(tgtConfidence) ? tgtConfidence : undefined,
                    groundingSource: record.get('tgtProvSource') ?? null,
                    quality: record.get('tgtQuality') ?? null,
                    needsReview: record.get('tgtNeedsReview') ?? null,
                    description: record.get('tgtDescription') ?? null,
                    title: record.get('tgtTitle') ?? null,
                    lastSeenCommit: record.get('tgtLastVerifiedCommit') ?? null,
                };
            } else {
                // Patch missing fields if this record has richer data
                if (!nodes[tgtUrn].repository && tgtRepoRaw) nodes[tgtUrn].repository = tgtRepoRaw;
                if (!nodes[tgtUrn].teamOwner && record.get('tgtTeam')) nodes[tgtUrn].teamOwner = record.get('tgtTeam');
                if (!nodes[tgtUrn].channelKind && record.get('tgtChannelKind')) nodes[tgtUrn].channelKind = record.get('tgtChannelKind');
                if (!nodes[tgtUrn].tags && record.get('tgtTags')) nodes[tgtUrn].tags = record.get('tgtTags');
                if (!nodes[tgtUrn].discoverySource && record.get('tgtDiscoverySource')) nodes[tgtUrn].discoverySource = record.get('tgtDiscoverySource');
                if (!nodes[tgtUrn].technology && record.get('tgtTechnology')) nodes[tgtUrn].technology = record.get('tgtTechnology');
                if (!nodes[tgtUrn].language && record.get('tgtLanguage')) nodes[tgtUrn].language = record.get('tgtLanguage');
                if (!nodes[tgtUrn].ecosystem && record.get('tgtEcosystem')) nodes[tgtUrn].ecosystem = record.get('tgtEcosystem');
                if (!nodes[tgtUrn].apiKind && record.get('tgtApiKind')) nodes[tgtUrn].apiKind = record.get('tgtApiKind');
                if (!nodes[tgtUrn].apiSource && record.get('tgtApiSource')) nodes[tgtUrn].apiSource = record.get('tgtApiSource');
                if (!nodes[tgtUrn].operation && record.get('tgtOperation')) nodes[tgtUrn].operation = record.get('tgtOperation');
                if (nodes[tgtUrn].confidence === undefined && Number.isFinite(tgtConfidence)) nodes[tgtUrn].confidence = tgtConfidence;
                if (!nodes[tgtUrn].description && record.get('tgtDescription')) nodes[tgtUrn].description = record.get('tgtDescription');
                if (!nodes[tgtUrn].title && record.get('tgtTitle')) nodes[tgtUrn].title = record.get('tgtTitle');
                if (!nodes[tgtUrn].lastSeenCommit && record.get('tgtLastVerifiedCommit')) nodes[tgtUrn].lastSeenCommit = record.get('tgtLastVerifiedCommit');
            }
            addDatastore(nodes[tgtUrn], record.get('tgtDatastoreName'), record.get('tgtEndpointHost'));

            const edgeConfidenceRaw = record.get('edgeConfidence');
            const edgeConfidence = typeof edgeConfidenceRaw === 'number' ? edgeConfidenceRaw : edgeConfidenceRaw ? Number(edgeConfidenceRaw) : undefined;
            const edge: TopologyEdge = {
                source: srcUrn,
                target: tgtUrn,
                rel,
                functions: functions.length > 0 ? functions : undefined,
                confidence: Number.isFinite(edgeConfidence) ? edgeConfidence : undefined,
            };

            // Build outgoing index (src → deps) with deduplication
            out[srcUrn] ??= [];
            if (!out[srcUrn].some(e => e.target === tgtUrn && e.rel === rel)) {
                out[srcUrn].push(edge);
            }

            // Build incoming index (tgt ← consumers) with deduplication
            inMap[tgtUrn] ??= [];
            if (!inMap[tgtUrn].some(e => e.source === srcUrn && e.rel === rel)) {
                inMap[tgtUrn].push(edge);
            }
        }

        // ── Supplementary: hydrate DataStructures for nodes that can carry one ───
        // MessageChannel: via HAS_SCHEMA (canonical edge).
        // DataContainer:  via name-match on DataStructure {type:'database_table'}
        //                 (no canonical edge today — see service-topology docs).
        // APIEndpoint:    via the implementing Function's PRODUCES/CONSUMES.
        const schemaUrns = Object.keys(nodes).filter(urn => {
            const t = nodes[urn].type;
            return t === 'MessageChannel' || t === 'DataContainer' || t === 'APIEndpoint';
        });
        const schemas = schemaUrns.length > 0 ? await getNodeSchemas(schemaUrns) : undefined;

        // ── Pre-compute Downstream Gravity Score for every node ──────────
        // This eliminates client-side scoring and ensures the frontend only
        // reads `node.gravityScore` to classify Blast Tiers (T0–T4).
        // See docs/architecture/impact-scoring.md for the formula.
        computeGravityScores(nodes, out, inMap);

        // ── Graph coverage signal ───────────────────────────────────────
        // Count how many repos have been scanned vs. total known repos.
        // Surfaced in the blast radius banner as a confidence annotation
        // (e.g. "based on 12/40 repos") so operators know when gravity
        // scores are lower bounds due to incomplete graph coverage.
        let coverage: TopologyMap['coverage'];
        try {
            const coverageResult = await session.run(
                `MATCH (r:Repository) WHERE r.valid_to_commit IS NULL
                 OPTIONAL MATCH (r)-[c:CONTAINS]->(sf:SourceFile)
                   WHERE c.valid_to_commit IS NULL
                     AND sf.valid_to_commit IS NULL
                 WITH r, count(sf) AS sfCount
                 RETURN count(r) AS total,
                        count(CASE WHEN sfCount > 0 THEN 1 END) AS scanned`
            );
            const rec = coverageResult.records[0];
            if (rec) {
                const scanned = typeof rec.get('scanned')?.toNumber === 'function'
                    ? rec.get('scanned').toNumber() : Number(rec.get('scanned')) || 0;
                const total = typeof rec.get('total')?.toNumber === 'function'
                    ? rec.get('total').toNumber() : Number(rec.get('total')) || 0;
                if (total > 0) {
                    coverage = { scannedRepos: scanned, totalKnownRepos: total };
                }
            }
        } catch {
            // Non-fatal: coverage is a UX hint, not a critical computation.
        }

        return { nodes, out, in: inMap, schemas, coverage };
    } finally {
        await session.close();
    }
}

// ─── Downstream Gravity Score Engine ────────────────────────────────────────
//
// Pre-computes a "danger" score for every node in the topology.
// The score measures "what breaks if this node dies", weighted by the
// connectivity (degree) of each downstream dependency. The scoring follows
// the damage direction: downstream only. Upstream dependencies make you
// fragile, not dangerous.
//
// Algorithm — O(N × degree²), no recursion, cycle-safe via visited set:
//
//   gravityScore(n) = Σ (coefficient × gravityWeight(d))
//                     for each d ∈ downstream(n, 2-hop)
//
//   coefficient      = 2.0 (Tier 1 / direct)  |  1.5 (Tier 2 / transitive)
//   gravityWeight(d) = 1 + log₁₀(max(1, degree(d)))
//   degree(d)        = |out[d]| + |in[d]|
//
// Relationship direction semantics (EMISSION_DIRECTION_RELS = EMISSION + API
// rels from the shared vocabulary, packages/shared-types/topology-rels.ts):
//   out-edge with an emission-direction rel = target is downstream
//   in-edge  with a dependency rel          = source is downstream
//   MAPS_TO is a dependency (the ORM mapper depends on the table).
//
// Alongside the score, every node gets a `gravityEvidence` block recording
// whether at least one REAL dependent was observed (in-edge dependent,
// Tier-2 transitive node, or consumed endpoint). Without observed evidence
// the score is the node's own write/publish footprint and the UI demotes
// the tier chip to "T? Unverified".
//
// See tests/unit/graph/gravity-score.test.ts for the calibrated scenarios.
// ────────────────────────────────────────────────────────────────────────────

/** Gravity weight: 1 + log₁₀(max(1, degree)). Smooths hub influence. */
export function gravityWeight(degree: number): number {
    return 1 + Math.log10(Math.max(1, degree));
}

/**
 * Compute and assign `gravityScore` + `gravityEvidence` to every node in the
 * topology map. Mutates `nodes` in place for zero-allocation performance.
 * Exported so unit tests exercise the production engine, not a mirror.
 */
export function computeGravityScores(
    nodes: Record<string, TopologyNode>,
    outMap: Record<string, TopologyEdge[]>,
    inMap: Record<string, TopologyEdge[]>,
): void {
    // Pre-compute degree for all nodes (O(N))
    const degree: Record<string, number> = {};
    for (const urn of Object.keys(nodes)) {
        degree[urn] = (outMap[urn]?.length ?? 0) + (inMap[urn]?.length ?? 0);
    }

    for (const urn of Object.keys(nodes)) {
        const seen = new Set<string>([urn]);
        let score = 0;
        let directFromInEdges = 0;
        let consumedEndpoints = 0;
        let transitiveCount = 0;

        // ── Tier 1: direct downstream ──────────────────────────────────
        const tier1Downstream: string[] = [];

        // Out-edges: I am the source. Emission-direction rel → target is downstream.
        for (const edge of (outMap[urn] ?? [])) {
            if (!nodes[edge.target] || nodes[edge.target].type === 'Package') continue;
            if (EMISSION_DIRECTION_RELS.has(edge.rel) && !seen.has(edge.target)) {
                seen.add(edge.target);
                // IMPLEMENTS_ENDPOINT: discount if no observed consumers.
                // In an incomplete graph, 0 observed CALLS ≠ 0 real consumers,
                // so we use a reduced coefficient (not zero) for safety.
                let coeff = 2.0;
                if (edge.rel === 'IMPLEMENTS_ENDPOINT') {
                    const hasObservedConsumers = (inMap[edge.target] ?? []).some(
                        e => !EMISSION_DIRECTION_RELS.has(e.rel) && e.source !== urn
                    );
                    if (hasObservedConsumers) consumedEndpoints++;
                    else coeff = IMPL_EP_DISCOUNT;
                }
                score += coeff * gravityWeight(degree[edge.target] ?? 0);
                tier1Downstream.push(edge.target);
            }
        }

        // In-edges: I am the target. Dependency rel → source is downstream of me.
        for (const edge of (inMap[urn] ?? [])) {
            if (!nodes[edge.source] || nodes[edge.source].type === 'Package') continue;
            if (!EMISSION_DIRECTION_RELS.has(edge.rel) && !seen.has(edge.source)) {
                seen.add(edge.source);
                score += 2.0 * gravityWeight(degree[edge.source] ?? 0);
                tier1Downstream.push(edge.source);
                directFromInEdges++;
            }
        }

        // ── Tier 2: follow through passthrough resources ───────────────
        for (const ptUrn of tier1Downstream) {
            if (!PASSTHROUGH_TYPES.has(nodes[ptUrn].type)) continue;

            for (const edge of (outMap[ptUrn] ?? [])) {
                if (!nodes[edge.target] || nodes[edge.target].type === 'Package') continue;
                if (EMISSION_DIRECTION_RELS.has(edge.rel) && !seen.has(edge.target)) {
                    seen.add(edge.target);
                    score += 1.5 * gravityWeight(degree[edge.target] ?? 0);
                    transitiveCount++;
                }
            }

            for (const edge of (inMap[ptUrn] ?? [])) {
                if (!nodes[edge.source] || nodes[edge.source].type === 'Package') continue;
                if (!EMISSION_DIRECTION_RELS.has(edge.rel) && !seen.has(edge.source)) {
                    seen.add(edge.source);
                    score += 1.5 * gravityWeight(degree[edge.source] ?? 0);
                    transitiveCount++;
                }
            }
        }

        nodes[urn].gravityScore = Math.round(score);
        nodes[urn].gravityEvidence = {
            observed: directFromInEdges > 0 || transitiveCount > 0 || consumedEndpoints > 0,
            inDegree: inMap[urn]?.length ?? 0,
            directFromInEdges,
            transitiveCount,
            consumedEndpoints,
        };
    }
}

/**
 * Fetch DataStructure(s) attached to a set of node URNs **via canonical edges
 * only**. We deliberately do not fall back to heuristics (name-match,
 * function-PRODUCES/CONSUMES) because the side drawer renders these as
 * authoritative request/response/table schemas; a wrong schema is strictly
 * worse than no schema. Producers of the canonical edges:
 *
 *   - `(:MessageChannel)-[:HAS_SCHEMA]->(:DataStructure)`
 *       written by `linkChannelToSchema` / `inferAndLinkChannelSchemas`
 *       (avro/JSON-Schema source files + LLM channel-to-payload binding).
 *   - `(:DataContainer)-[:HAS_SCHEMA]->(:DataStructure)`
 *       written by `linkDataContainerSchemas` (post-pass: name-match restricted
 *       to same-repo provenance to avoid cross-repo collisions).
 *   - `(:APIEndpoint)-[:HAS_REQUEST_SCHEMA|:HAS_RESPONSE_SCHEMA]->(:DataStructure)`
 *       *not yet populated* — requires OpenAPI/GraphQL request-body / response
 *       parsing. Until then, APIEndpoints render no schema panel.
 *
 * URNs without any matching canonical edge are simply absent from the result.
 */
async function getNodeSchemas(nodeUrns: string[]): Promise<Record<string, TopologySchema[]> | undefined> {
    const session = getMemgraphSession();
    const out: Record<string, TopologySchema[]> = {};

    const push = (urn: string, schema: TopologySchema) => {
        (out[urn] ??= []).push(schema);
    };

    const buildFields = (rows: Array<{ name: string | null; type: string | null; required?: boolean | null }>) =>
        (rows || [])
            .filter(f => f && f.name != null)
            .map(f => ({ name: f.name!, type: f.type ?? null, required: f.required ?? null }));

    type Bundle = {
        relType: 'HAS_SCHEMA' | 'HAS_REQUEST_SCHEMA' | 'HAS_RESPONSE_SCHEMA';
        anchorLabel: 'MessageChannel' | 'DataContainer' | 'APIEndpoint';
        role: TopologySchema['role'];
    };

    const bundles: Bundle[] = [
        { relType: 'HAS_SCHEMA',          anchorLabel: 'MessageChannel', role: 'event' },
        { relType: 'HAS_SCHEMA',          anchorLabel: 'DataContainer',  role: 'table' },
        { relType: 'HAS_REQUEST_SCHEMA',  anchorLabel: 'APIEndpoint',    role: 'request' },
        { relType: 'HAS_RESPONSE_SCHEMA', anchorLabel: 'APIEndpoint',    role: 'response' },
    ];

    try {
        for (const b of bundles) {
            const res = await session.run(
                `MATCH (anchor:${b.anchorLabel})-[link:${b.relType}]->(ds:DataStructure)
                 WHERE anchor.id IN $urns
                   AND anchor.valid_to_commit IS NULL
                   AND link.valid_to_commit IS NULL
                   AND ds.valid_to_commit IS NULL
                 OPTIONAL MATCH (ds)-[hf:HAS_FIELD]->(f:DataField)
                 WHERE hf.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
                 OPTIONAL MATCH (sf:SourceFile)-[def:DEFINES_SCHEMA]->(ds)
                 WHERE def.valid_to_commit IS NULL
                 OPTIONAL MATCH (sf)-[rs:STORED_IN]->(repo:Repository)
                 WHERE rs.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL
                 RETURN anchor.id AS urn,
                        ds.id     AS dsId,
                        ds.name   AS schemaName,
                        coalesce(ds.schemaFormat, anchor.schemaFormat) AS schemaFormat,
                        collect(DISTINCT {name: f.name, type: f.type, required: f.required}) AS fields,
                        collect(DISTINCT sf.path)         AS sourcePaths,
                        collect(DISTINCT repo.url)[0]     AS repoUrl,
                        collect(DISTINCT repo.branch)[0]  AS repoBranch`,
                { urns: nodeUrns },
            );

            // Dedup by (urn, dsId) — multiple SourceFiles can DEFINES_SCHEMA the same DataStructure.
            const seen = new Set<string>();
            for (const r of res.records) {
                const urn = r.get('urn') as string;
                const dsId = r.get('dsId') as string;
                const key = `${urn}::${dsId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                push(urn, {
                    name: r.get('schemaName') as string,
                    format: r.get('schemaFormat') as string | null,
                    sourcePaths: r.get('sourcePaths') as string[],
                    repoUrl: r.get('repoUrl') as string | null,
                    mainBranch: r.get('repoBranch') as string | null,
                    fields: buildFields(r.get('fields')),
                    role: b.role,
                });
            }
        }

        return Object.keys(out).length > 0 ? out : undefined;
    } finally {
        await session.close();
    }
}
