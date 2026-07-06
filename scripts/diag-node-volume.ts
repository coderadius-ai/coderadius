/**
 * Inventory: count nodes by label and edges by type, scoped to a repo.
 * Also reports per-label payload size estimate (key properties).
 *
 * Usage:
 *   bun run scripts/diag-node-volume.ts --repo <name>
 */

import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';

async function main() {
    const args = process.argv.slice(2);
    const repo = (() => {
        const i = args.findIndex(a => a === '--repo');
        return i >= 0 ? args[i + 1] : undefined;
    })();
    if (!repo) {
        console.error('Missing --repo <name>');
        process.exit(1);
    }

    const session = getNeo4jSession();
    try {
        const labelRes = await session.run(
            `MATCH (n)
             WHERE n.valid_to_commit IS NULL AND n.id CONTAINS $repo
             WITH labels(n) AS lbl
             UNWIND lbl AS l
             RETURN l AS label, count(*) AS count
             ORDER BY count DESC`,
            { repo }
        );

        console.log(`\n=== Node counts for repo "${repo}" (active only) ===\n`);
        let totalNodes = 0;
        for (const r of labelRes.records) {
            const c = r.get('count')?.toNumber?.() ?? r.get('count');
            const lbl = r.get('label');
            console.log(`  ${lbl.padEnd(40)} ${c}`);
            totalNodes += c;
        }
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(8)}`);
        console.log(`  ${'TOTAL'.padEnd(40)} ${totalNodes}`);

        const relRes = await session.run(
            `MATCH (a)-[r]->(b)
             WHERE r.valid_to_commit IS NULL
               AND (a.id CONTAINS $repo OR b.id CONTAINS $repo)
             RETURN type(r) AS rel, count(*) AS count
             ORDER BY count DESC`,
            { repo }
        );

        console.log(`\n=== Edge counts (touching repo) ===\n`);
        let totalEdges = 0;
        for (const r of relRes.records) {
            const c = r.get('count')?.toNumber?.() ?? r.get('count');
            console.log(`  ${r.get('rel').padEnd(40)} ${c}`);
            totalEdges += c;
        }
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(8)}`);
        console.log(`  ${'TOTAL'.padEnd(40)} ${totalEdges}`);

        const embeddingRes = await session.run(
            `MATCH (f:Function)
             WHERE f.valid_to_commit IS NULL AND f.id CONTAINS $repo
             RETURN count(f) AS total,
                    count(f.embedding) AS withEmb`,
            { repo }
        );
        const total = embeddingRes.records[0]?.get('total')?.toNumber?.() ?? 0;
        const withEmb = embeddingRes.records[0]?.get('withEmb')?.toNumber?.() ?? 0;

        console.log(`\n=== Embedding storage estimate ===\n`);
        console.log(`  Function nodes:                  ${total}`);
        console.log(`  ...with embedding vector:        ${withEmb}`);
        console.log(`  Embedding bytes (768f × 4 ≈ 3 KB each):   ~${(withEmb * 3072 / 1024).toFixed(0)} KB / ${(withEmb * 3072 / 1024 / 1024).toFixed(1)} MB`);

        const tombstonedRes = await session.run(
            `MATCH (n)
             WHERE n.valid_to_commit IS NOT NULL AND n.id CONTAINS $repo
             RETURN labels(n)[0] AS label, count(*) AS count
             ORDER BY count DESC
             LIMIT 10`,
            { repo }
        );
        if (tombstonedRes.records.length > 0) {
            console.log(`\n=== Tombstoned (soft-deleted, still in DB) ===\n`);
            for (const r of tombstonedRes.records) {
                const c = r.get('count')?.toNumber?.() ?? r.get('count');
                console.log(`  ${(r.get('label') ?? 'unknown').padEnd(40)} ${c}`);
            }
        }
        console.log();
    } finally {
        await closeNeo4j();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
