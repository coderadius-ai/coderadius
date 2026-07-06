// Read-only diagnostic for DataStructure scoping / dedup state.
// Surfaces:
//   - emergent unscoped residues (should be 0 post-Phase-1A deploy)
//   - case-insensitive duplicates per scope bucket
//   - Frankenstein candidates (top-N field count)
//   - orphan candidates (gate identical to deleteOrphanDataStructures)
//   - cap signals (PRODUCES/CONSUMES with fieldsCapped=true)
//
// Usage: bun run scripts/diag-datastructure-dedup.ts
// Zero mutations.
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

async function main() {
    console.log('=== 1. DataStructure distribution by (scoped/global, source) ===');
    console.table(
        await q(`MATCH (ds:DataStructure) WHERE ds.valid_to_commit IS NULL
                 WITH ds,
                      CASE WHEN ds.scopeKey IS NULL THEN 'global' ELSE 'scoped' END AS bucket,
                      coalesce(ds.source, '<null>') AS src,
                      coalesce(ds.type, '<null>') AS dsType
                 RETURN bucket, src, dsType, count(ds) AS n
                 ORDER BY bucket, src, dsType`)
    );

    console.log('\n=== 2. Emergent unscoped residues (should be 0 post-deploy) ===');
    console.table(
        await q(`MATCH (ds:DataStructure {type: 'message_payload'})
                 WHERE ds.valid_to_commit IS NULL
                   AND ds.schemaFormat IS NULL
                   AND ds.scopeKey IS NULL
                 RETURN ds.name AS name, ds.id AS id
                 ORDER BY ds.name LIMIT 20`)
    );

    console.log('\n=== 3. Duplicate names per scope bucket (case-aware) ===');
    console.table(
        await q(`MATCH (ds:DataStructure) WHERE ds.valid_to_commit IS NULL
                 WITH coalesce(ds.scopeKey, '<global>') AS scope, ds.name AS name, count(ds) AS c
                 WHERE c > 1
                 RETURN scope, name, c ORDER BY c DESC, name LIMIT 20`)
    );

    console.log('\n=== 4. Top 10 DataStructures by field count (Frankenstein candidates) ===');
    console.table(
        await q(`MATCH (ds:DataStructure)-[hf:HAS_FIELD]->(df:DataField)
                 WHERE ds.valid_to_commit IS NULL
                   AND hf.valid_to_commit IS NULL
                   AND df.valid_to_commit IS NULL
                 WITH ds, count(df) AS fieldCount
                 RETURN ds.id AS id, ds.name AS name,
                        coalesce(ds.source, '<null>') AS src,
                        coalesce(ds.scopeKey, '<global>') AS scope,
                        fieldCount
                 ORDER BY fieldCount DESC LIMIT 10`)
    );

    console.log('\n=== 5. Orphan candidates (gate identical to deleteOrphanDataStructures) ===');
    console.table(
        await q(`MATCH (ds:DataStructure) WHERE ds.valid_to_commit IS NULL
                 OPTIONAL MATCH (f:Function)-[pc:PRODUCES|CONSUMES]->(ds)
                   WHERE pc.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
                 OPTIONAL MATCH (sf:SourceFile)-[def:DEFINES_SCHEMA]->(ds)
                   WHERE def.valid_to_commit IS NULL
                     AND (ds.type = 'database_table'
                          OR ds.source IN ['ast', 'declared', 'infra', 'composite']
                          OR ds.schemaFormat IS NOT NULL)
                 OPTIONAL MATCH (ch:MessageChannel)-[hs:HAS_SCHEMA]->(ds)
                   WHERE hs.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
                 OPTIONAL MATCH (dc:DataContainer)-[dchs:HAS_SCHEMA]->(ds)
                   WHERE dchs.valid_to_commit IS NULL AND dc.valid_to_commit IS NULL
                 OPTIONAL MATCH (ds)-[cb:CARRIED_BY]->(ch2:MessageChannel)
                   WHERE cb.valid_to_commit IS NULL AND ch2.valid_to_commit IS NULL
                 OPTIONAL MATCH (ep:APIEndpoint)-[rs:HAS_REQUEST_SCHEMA|HAS_RESPONSE_SCHEMA]->(ds)
                   WHERE rs.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
                 WITH ds, count(DISTINCT pc) + count(DISTINCT def) + count(DISTINCT hs)
                      + count(DISTINCT dchs) + count(DISTINCT cb) + count(DISTINCT rs) AS refs
                 WHERE refs = 0
                 RETURN ds.id AS id, ds.name AS name,
                        coalesce(ds.source, '<null>') AS src,
                        coalesce(ds.scopeKey, '<global>') AS scope
                 LIMIT 20`)
    );

    console.log('\n=== 6. Field-edge cap signals (PRODUCES/CONSUMES with fieldsCapped=true) ===');
    console.table(
        await q(`MATCH (f:Function)-[r:PRODUCES|CONSUMES]->(ds:DataStructure)
                 WHERE r.valid_to_commit IS NULL
                   AND ds.valid_to_commit IS NULL
                   AND r.fieldsCapped = true
                 RETURN type(r) AS rel, ds.name AS structureName,
                        coalesce(ds.scopeKey, '<global>') AS scope,
                        f.name AS functionName, f.id AS functionId
                 LIMIT 20`)
    );

    console.log('\n=== 7. PRODUCES_FIELD / CONSUMES_FIELD edge counts ===');
    console.table(
        await q(`MATCH (f:Function)-[r:PRODUCES_FIELD|CONSUMES_FIELD]->(df:DataField)
                 WHERE r.valid_to_commit IS NULL AND df.valid_to_commit IS NULL
                 RETURN type(r) AS rel, count(r) AS n`)
    );

    await closeNeo4j();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
