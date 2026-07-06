/**
 * Builder for the AgenticConfig semantic-duplicates Cypher query.
 *
 * Kept as a pure (query, params) constructor so the filter-injection branches
 * are unit-testable without spinning up Memgraph's vector_search module.
 */

import { VECTOR_INDEX } from '../vector-indexes.js';

export interface SemanticDuplicatesQueryOpts {
    /** Minimum cosine similarity (default 0.85). */
    threshold?: number;
    /** Top-K neighbours per anchor node (default 10). */
    topK?: number;
    /** When set, restricts both endpoints of the pair to this configType (e.g. 'skill'). */
    configType?: string;
    /** When true, drops same-repository pairs at Cypher level. A duplicate is the
     *  same skill in DIFFERENT repos, not merely different services within one
     *  repo: repo identity is the URN repo segment (`cr:agenticconfig:{repo}:...`),
     *  so copies across services/harness dirs of one repo never count. */
    crossRepoOnly?: boolean;
    /** Maximum rows returned (default 50, raise when narrowing by configType). */
    limit?: number;
    /** When true, allows pairs with identical contentFingerprint (skills installed
     *  in multiple services are content-identical but still semantically relevant twins). */
    skipFingerprintDedup?: boolean;
}

export function buildSemanticDuplicatesQuery(
    opts: SemanticDuplicatesQueryOpts,
): { query: string; params: Record<string, unknown> } {
    const threshold = opts.threshold ?? 0.85;
    const topK = opts.topK ?? 10;
    const limit = opts.limit ?? 50;

    const params: Record<string, unknown> = {
        indexName: VECTOR_INDEX.AGENTIC_CONFIG,
        threshold,
        topK,
    };

    const typeFilter = opts.configType
        ? 'AND a.configType = $configType AND b.configType = $configType'
        : '';
    if (opts.configType) params.configType = opts.configType;

    // Repo identity = URN repo segment (cr:agenticconfig:{repo}:{tool}:{path}).
    // Comparing the segment (not the resolved service) makes "duplicate" mean
    // cross-REPO, so intra-monorepo copies across services don't count.
    const crossRepoFilter = opts.crossRepoOnly
        ? `WHERE split(a.id, ':')[2] <> split(b.id, ':')[2]`
        : '';

    // Service resolution is multi-path because the ingestion graph can attach
    // AgenticConfig via three different routes:
    //   1. (Service)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)         (canonical)
    //   2. (Repository)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)      (direct repo fallback)
    //   3. (StructuralFile)-[:DEFINES]->(AgenticConfig)             (file-level path)
    //
    // When attachment is missing entirely (orphan AgenticConfig nodes from a
    // partial ingest), we fall back to the repo segment of the URN
    // `cr:agenticconfig:{repo}:{tool}:{path}` so cross-repo grouping still
    // works at the URN level. The final fallback is the literal 'unknown'.
    const query = `
        MATCH (a:AgenticConfig)
        WHERE a.embedding IS NOT NULL
        CALL vector_search.search($indexName, toInteger($topK), a.embedding)
          YIELD node AS b, similarity
        WITH a, b, similarity
        WHERE similarity >= $threshold
          AND id(a) < id(b)
          ${opts.skipFingerprintDedup ? '' : `AND (a.contentFingerprint IS NULL OR b.contentFingerprint IS NULL
               OR a.contentFingerprint <> b.contentFingerprint)`}
          ${typeFilter}
        OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(svcDirA:Service)
        OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(repoDirA:Repository)
        OPTIONAL MATCH (a)<-[:DEFINES]-(sfA)<-[:STORED_IN|HAS_CONFIG]-(svcStoredA:Service)
        OPTIONAL MATCH (b)<-[:HAS_AGENTIC_CONFIG]-(svcDirB:Service)
        OPTIONAL MATCH (b)<-[:HAS_AGENTIC_CONFIG]-(repoDirB:Repository)
        OPTIONAL MATCH (b)<-[:DEFINES]-(sfB)<-[:STORED_IN|HAS_CONFIG]-(svcStoredB:Service)
        WITH a, b, similarity,
             coalesce(svcDirA.name, svcStoredA.name, repoDirA.name, split(a.id, ':')[2], 'unknown') AS serviceA,
             coalesce(svcDirB.name, svcStoredB.name, repoDirB.name, split(b.id, ':')[2], 'unknown') AS serviceB
        ${crossRepoFilter}
        RETURN a.id AS configIdA, serviceA, a.name AS configA, a.configType AS configTypeA, a.filePath AS filePathA,
               b.id AS configIdB, serviceB, b.name AS configB, b.configType AS configTypeB, b.filePath AS filePathB,
               similarity,
               CASE WHEN serviceA = serviceB THEN 'same-service' ELSE 'cross-service' END AS scope
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return { query, params };
}
