// Diagnostic for the Skill Twins view.
// Reports counts that drive whether the tab appears in Agentic Radar:
//   - total AgenticConfig nodes (any configType)
//   - skills (configType='skill')
//   - skills with an embedding vector
//   - skills spanning >1 distinct Service (cross-repo candidates)
//   - top-K cross-repo pair similarities at thresholds 0.85 / 0.90 / 0.92
//
// Usage: bun run scripts/diag-skill-twins.ts
import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';
import { VECTOR_INDEX } from '../src/graph/vector-indexes.js';

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
    console.log('Skill Twins diagnostic\n');

    const [totals] = await q(`
        MATCH (a:AgenticConfig)
        RETURN
            count(a) AS total,
            sum(CASE WHEN a.configType = 'skill' THEN 1 ELSE 0 END) AS skills,
            sum(CASE WHEN a.configType = 'skill' AND a.embedding IS NOT NULL THEN 1 ELSE 0 END) AS skillsWithEmbedding
    `);
    console.log(`AgenticConfig total:           ${Number(totals.total)}`);
    console.log(`  configType='skill':          ${Number(totals.skills)}`);
    console.log(`  skills with embedding:       ${Number(totals.skillsWithEmbedding)}`);

    const skillsByService = await q(`
        MATCH (a:AgenticConfig) WHERE a.configType = 'skill'
        OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(svcDir:Service)
        OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(repoDir:Repository)
        OPTIONAL MATCH (a)<-[:DEFINES]-(sf)<-[:STORED_IN|HAS_CONFIG]-(svcStored:Service)
        WITH coalesce(svcDir.name, svcStored.name, repoDir.name, split(a.id, ':')[2], 'unknown') AS service,
             count(a) AS skillCount
        RETURN service, skillCount ORDER BY skillCount DESC
    `);
    console.log(`\nSkills per service:`);
    if (skillsByService.length === 0) {
        console.log('  (none)');
    } else {
        for (const r of skillsByService) {
            console.log(`  ${r.service.padEnd(40)} ${Number(r.skillCount)}`);
        }
    }

    // If skills with embeddings exist in >1 service, query vector index for nearest pairs.
    const eligibleServices = skillsByService.filter(r => Number(r.skillCount) > 0).length;
    if (eligibleServices < 2) {
        console.log(`\nFewer than 2 services own at least one skill — no cross-repo pairs possible.`);
        return;
    }

    console.log(`\nTop cross-service skill pairs by similarity:`);
    try {
        const pairs = await q(
            `MATCH (a:AgenticConfig) WHERE a.configType = 'skill' AND a.embedding IS NOT NULL
             CALL vector_search.search($indexName, 20, a.embedding) YIELD node AS b, similarity
             WITH a, b, similarity
             WHERE id(a) < id(b)
               AND b.configType = 'skill'
               AND (a.contentFingerprint IS NULL OR b.contentFingerprint IS NULL
                    OR a.contentFingerprint <> b.contentFingerprint)
             OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(svcDirA:Service)
             OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(repoDirA:Repository)
             OPTIONAL MATCH (a)<-[:DEFINES]-(sfA)<-[:STORED_IN|HAS_CONFIG]-(svcStoredA:Service)
             OPTIONAL MATCH (b)<-[:HAS_AGENTIC_CONFIG]-(svcDirB:Service)
             OPTIONAL MATCH (b)<-[:HAS_AGENTIC_CONFIG]-(repoDirB:Repository)
             OPTIONAL MATCH (b)<-[:DEFINES]-(sfB)<-[:STORED_IN|HAS_CONFIG]-(svcStoredB:Service)
             WITH a, b, similarity,
                  coalesce(svcDirA.name, svcStoredA.name, repoDirA.name, split(a.id, ':')[2], '?') AS sA,
                  coalesce(svcDirB.name, svcStoredB.name, repoDirB.name, split(b.id, ':')[2], '?') AS sB
             WHERE sA <> sB
             RETURN sA, a.name AS nA, sB, b.name AS nB, similarity
             ORDER BY similarity DESC
             LIMIT 20`,
            { indexName: VECTOR_INDEX.AGENTIC_CONFIG },
        );
        if (pairs.length === 0) {
            console.log('  (no cross-service skill pairs found — vector_search.search may not be available or no neighbours above 0)');
        } else {
            console.log(`  similarity | service A → skill A   ↔   service B → skill B`);
            for (const p of pairs) {
                const sim = Number(p.similarity).toFixed(3);
                console.log(`  ${sim}      | ${p.sA}/${p.nA}   ↔   ${p.sB}/${p.nB}`);
            }

            const counts = [0.85, 0.90, 0.92].map(t =>
                ({ threshold: t, n: pairs.filter(p => Number(p.similarity) >= t).length })
            );
            console.log(`\nPair counts by threshold:`);
            for (const c of counts) console.log(`  >= ${c.threshold.toFixed(2)}: ${c.n}`);
        }
    } catch (err) {
        console.error('\nvector_search.search failed — Memgraph vector index may be unavailable:');
        console.error(`  ${(err as Error).message}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
}).finally(closeNeo4j);
