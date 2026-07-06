// One-shot diagnostic for APIEndpoint duplication state.
// Usage: bun run scripts/diag-endpoint-dedup.ts --path-filter <substring>
// The path filter is required: sections that look for caller↔implementer
// drift run a CONTAINS match against ep.path, so we need the operator to
// point us at the routes they want to investigate.
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

function parsePathFilter(): string {
    const flagIdx = process.argv.indexOf('--path-filter');
    const value = flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined;
    if (!value) {
        console.error('Missing required arg: --path-filter <substring>');
        console.error('  Example: bun run scripts/diag-endpoint-dedup.ts --path-filter orders');
        process.exit(2);
    }
    return value.toLowerCase();
}

async function main() {
    const pathFilter = parsePathFilter();
    console.log(`Using --path-filter "${pathFilter}" for caller/implementer probes.\n`);
    console.log('\n=== 1. Active APIInterface nodes by source ===');
    console.table(
        await q(`MATCH (api:APIInterface) WHERE api.valid_to_commit IS NULL
                 RETURN coalesce(api.source,'<NULL>') AS source, toString(count(api)) AS n
                 ORDER BY source`)
    );

    console.log('\n=== 2. Active APIEndpoint nodes by source ===');
    console.table(
        await q(`MATCH (ep:APIEndpoint) WHERE ep.valid_to_commit IS NULL
                 RETURN coalesce(ep.source,'<NULL>') AS source, toString(count(ep)) AS n
                 ORDER BY source`)
    );

    console.log('\n=== 3. Tombstoned APIEndpoint nodes by source ===');
    console.table(
        await q(`MATCH (ep:APIEndpoint) WHERE ep.valid_to_commit IS NOT NULL
                 RETURN coalesce(ep.source,'<NULL>') AS source, toString(count(ep)) AS n
                 ORDER BY source`)
    );

    console.log(`\n=== 4. Search-result reproduction (path contains "${pathFilter}") ===`);
    console.table(
        await q(`MATCH (ep:APIEndpoint)
                 WHERE toLower(ep.path) CONTAINS $pathFilter
                 OPTIONAL MATCH (s:Service)-[:EXPOSES_API]->(:APIInterface)-[:HAS_ENDPOINT]->(ep)
                 RETURN ep.method AS method, ep.path AS path,
                        ep.source AS source,
                        ep.valid_to_commit IS NOT NULL AS tombstoned,
                        collect(DISTINCT s.name)[0] AS service,
                        ep.id AS id
                 ORDER BY path, source`, { pathFilter })
    );

    console.log('\n=== 5. Cross-source path drift: same logical route, different stored path ===');
    console.table(
        await q(`MATCH (a:APIEndpoint), (b:APIEndpoint)
                 WHERE a.id < b.id
                   AND a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL
                   AND toUpper(a.method) = toUpper(b.method)
                   AND a.path <> b.path
                   AND replace(replace(toLower(a.path),'{saveid}','{p}'),'{param}','{p}')
                       = replace(replace(toLower(b.path),'{saveid}','{p}'),'{param}','{p}')
                 RETURN a.method AS method, a.source AS a_src, a.path AS a_path,
                        b.source AS b_src, b.path AS b_path
                 ORDER BY method, a_path
                 LIMIT 20`)
    );

    console.log('\n=== 6. Emergent endpoints not yet welded ===');
    console.table(
        await q(`MATCH (ep:APIEndpoint {source: 'emergent'})
                 WHERE ep.valid_to_commit IS NULL
                 OPTIONAL MATCH (f:Function)-[:CALLS]->(ep)
                 RETURN ep.method AS method, ep.path AS path,
                        toString(count(DISTINCT f)) AS callers,
                        collect(DISTINCT f.id)[0..2] AS sampleCallers,
                        ep.id AS id
                 ORDER BY path
                 LIMIT 20`)
    );

    console.log('\n=== 7. APIInterface.source NULL nodes (Bug A backfill candidates) ===');
    console.table(
        await q(`MATCH (api:APIInterface)
                 WHERE api.valid_to_commit IS NULL AND api.source IS NULL
                 RETURN api.title AS title, api.version AS version, api.id AS id
                 LIMIT 20`)
    );

    console.log('\n=== 7b. Cross-spec OpenAPI duplicates (same path, multiple specs) ===');
    console.table(
        await q(`MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint {source:'openapi'})
                 WHERE ep.valid_to_commit IS NULL
                 OPTIONAL MATCH (s:Service)-[:EXPOSES_API|CONSUMES_API]->(api)
                 WITH ep.method AS method, ep.path AS path,
                      collect(DISTINCT s.name + ':' + coalesce(api.id,'?')) AS specs,
                      count(DISTINCT api) AS numSpecs
                 WHERE numSpecs > 1
                 RETURN method, path, toString(numSpecs) AS specsCount, specs[0..3] AS sampleSpecs
                 ORDER BY numSpecs DESC, path
                 LIMIT 15`)
    );

    console.log('\n=== 7c. EXPOSES vs CONSUMES per APIInterface ===');
    console.table(
        await q(`MATCH (api:APIInterface) WHERE api.valid_to_commit IS NULL
                 OPTIONAL MATCH (s1:Service)-[:EXPOSES_API]->(api)
                 OPTIONAL MATCH (s2:Service)-[:CONSUMES_API]->(api)
                 RETURN api.id AS id, api.source AS src,
                        collect(DISTINCT s1.name) AS exposes,
                        collect(DISTINCT s2.name) AS consumes
                 ORDER BY id LIMIT 20`)
    );

    console.log('\n=== 8. Caller↔implementer reachability for the duplicated routes ===');
    console.table(
        await q(`MATCH (caller:Function)-[:CALLS]->(ep:APIEndpoint)<-[:IMPLEMENTS_ENDPOINT]-(impl:Function)
                 WHERE toLower(ep.path) CONTAINS $pathFilter
                 RETURN ep.method AS method, ep.path AS path, ep.source AS ep_src,
                        caller.id AS caller, impl.id AS impl
                 LIMIT 10`, { pathFilter })
    );

    console.log(`\n=== 9. Any Function-[:CALLS]-(APIEndpoint) for "${pathFilter}"? ===`);
    console.table(
        await q(`MATCH (caller:Function)-[:CALLS]->(ep:APIEndpoint)
                 WHERE toLower(ep.path) CONTAINS $pathFilter
                 RETURN ep.method AS m, ep.path AS p, ep.source AS src,
                        caller.id AS caller LIMIT 10`, { pathFilter })
    );

    console.log('\n=== 9b. Which APIEndpoint URN does the consumer CALL? ===');
    console.table(
        await q(`MATCH (caller:Function)-[:CALLS]->(ep:APIEndpoint)
                 WHERE toLower(ep.path) CONTAINS $pathFilter
                 RETURN ep.path AS p, ep.method AS m, ep.id AS calledNode, caller.id AS caller LIMIT 10`, { pathFilter })
    );

    console.log('\n=== 9c. Cross-URN join (same logical route, different node ids) ===');
    console.table(
        await q(`MATCH (caller:Function)-[:CALLS]->(ep1:APIEndpoint)
                 MATCH (impl:Function)-[:IMPLEMENTS_ENDPOINT]->(ep2:APIEndpoint)
                 WHERE toLower(ep1.path) CONTAINS $pathFilter
                   AND toUpper(ep1.method) = toUpper(ep2.method)
                   AND ep1.path = ep2.path
                   AND ep1.id <> ep2.id
                 RETURN ep1.path AS p, ep1.method AS m,
                        ep1.id AS callerSide, ep2.id AS implSide LIMIT 10`, { pathFilter })
    );

    console.log(`\n=== 10. Any Function-[:IMPLEMENTS_ENDPOINT]-(APIEndpoint) for "${pathFilter}"? ===`);
    console.table(
        await q(`MATCH (impl:Function)-[:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
                 WHERE toLower(ep.path) CONTAINS $pathFilter
                 RETURN ep.method AS m, ep.path AS p, ep.source AS src, ep.id AS epId,
                        impl.id AS impl LIMIT 10`, { pathFilter })
    );
}

main()
    .then(async () => { await closeNeo4j(); process.exit(0); })
    .catch(async (e) => { console.error(e); await closeNeo4j(); process.exit(1); });
