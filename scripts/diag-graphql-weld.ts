// One-shot diagnostic for the GraphQL emergent welding pipeline.
// Run after `bun run dev sync code` to verify Phases A/B/C/D landed.
// Usage: bun run scripts/diag-graphql-weld.ts
import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';

async function q(cypher: string, params: Record<string, any> = {}) {
    const s = getNeo4jSession();
    try {
        const r = await s.run(cypher, params);
        return r.records.map(rec => rec.toObject());
    } finally {
        await s.close();
    }
}

function num(v: any): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && '__isInteger__' in v && typeof (v as any).toNumber === 'function') return (v as any).toNumber();
    if (typeof v === 'string') return Number(v);
    return Number(v) || 0;
}

async function main() {
    console.log('\n=== 1. APIEndpoint counts by (source, protocol) ===');
    console.table(
        (await q(`MATCH (ep:APIEndpoint) WHERE ep.valid_to_commit IS NULL
                  RETURN coalesce(ep.source,'<NULL>') AS source,
                         coalesce(ep.protocol,'<NULL>') AS protocol,
                         count(ep) AS n
                  ORDER BY source, protocol`))
            .map(r => ({ ...r, n: num(r.n) })),
    );

    console.log('\n=== 2. emergent-graphql endpoints (count + sample) ===');
    const emergentGql = (await q(`MATCH (ep:APIEndpoint)
                                  WHERE ep.id STARTS WITH 'cr:endpoint:emergent-graphql'
                                    AND ep.valid_to_commit IS NULL
                                  RETURN ep.id AS id, ep.operation AS op, ep.operationName AS opName
                                  LIMIT 20`));
    console.log(`Total emergent-graphql nodes: ${emergentGql.length}`);
    console.table(emergentGql);

    console.log('\n=== 3. Cross-repo Service-DEPENDS_ON-Service edges by source ===');
    console.table(
        (await q(`MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service)
                  WHERE r.valid_to_commit IS NULL
                    AND a.id <> b.id
                  RETURN coalesce(r.source,'<NULL>') AS source,
                         count(r) AS n
                  ORDER BY source`))
            .map(r => ({ ...r, n: num(r.n) })),
    );

    console.log('\n=== 4. Sample env-var DEPENDS_ON edges (cross-repo) ===');
    console.table(
        await q(`MATCH (a:Service)-[r:DEPENDS_ON {source:'env-var'}]->(b:Service)
                 WHERE r.valid_to_commit IS NULL
                 RETURN a.name AS caller, b.name AS target,
                        r.package AS envVar, r.protocol AS protocol
                 ORDER BY caller, target
                 LIMIT 30`),
    );

    console.log('\n=== 5. GraphQL function→endpoint links by edge type and endpoint source ===');
    console.table(
        (await q(`MATCH (f:Function)-[r]->(ep:APIEndpoint)
                  WHERE ep.valid_to_commit IS NULL
                    AND ep.protocol = 'graphql'
                    AND type(r) IN ['CALLS','IMPLEMENTS_ENDPOINT']
                  RETURN type(r) AS rel, coalesce(ep.source,'<NULL>') AS endpointSource,
                         count(*) AS n
                  ORDER BY rel, endpointSource`))
            .map(r => ({ ...r, n: num(r.n) })),
    );

    console.log('\n=== 6. Unwelded emergent-graphql endpoints (no RESOLVES_TO / CALLS to canonical) ===');
    console.table(
        await q(`MATCH (ep:APIEndpoint)
                 WHERE ep.id STARTS WITH 'cr:endpoint:emergent-graphql'
                   AND ep.valid_to_commit IS NULL
                 OPTIONAL MATCH (ep)-[r]->(canonical:APIEndpoint)
                   WHERE canonical.source = 'sdl'
                 WITH ep, count(canonical) AS welds
                 WHERE welds = 0
                 RETURN ep.id AS id, ep.operation AS op, ep.operationName AS opName
                 LIMIT 20`),
    );

    console.log('\n=== 7. Orphan plain-HTTP emergent endpoints with GraphQL-suspicious callers ===');
    // Anything posting to /graphql or /api whose CALLS-source contains a gql operation literal
    // is a candidate the sanitizer should have reclassified. Surfaces phase-C false negatives.
    console.table(
        await q(`MATCH (ep:APIEndpoint)
                 WHERE ep.source = 'emergent'
                   AND coalesce(ep.protocol,'<NULL>') = '<NULL>'
                   AND ep.valid_to_commit IS NULL
                   AND (toLower(ep.path) ENDS WITH '/graphql' OR toLower(ep.path) ENDS WITH '/api')
                 OPTIONAL MATCH (f:Function)-[:CALLS]->(ep)
                 RETURN ep.method AS method, ep.path AS path,
                        toString(count(DISTINCT f)) AS callers, ep.id AS id
                 ORDER BY path
                 LIMIT 20`),
    );

    console.log('\n=== 8. SDL endpoint counts per provider service ===');
    console.table(
        (await q(`MATCH (s:Service)-[:EXPOSES_API]->(api:APIInterface {source:'sdl'})
                  -[:HAS_ENDPOINT]->(ep:APIEndpoint)
                  WHERE ep.valid_to_commit IS NULL
                  RETURN s.name AS service, count(ep) AS endpoints
                  ORDER BY endpoints DESC`))
            .map(r => ({ ...r, endpoints: num(r.endpoints) })),
    );

    await closeNeo4j();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
