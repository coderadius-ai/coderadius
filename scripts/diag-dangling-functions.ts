/**
 * Sample Function nodes in the graph that have NO infrastructure edges,
 * so the operator can spot-check whether the source code really does no I/O.
 *
 * Definition of "no infra edges": the function has zero outgoing edges of any
 * of these types — IMPLEMENTS_ENDPOINT, CALLS_API, READS, WRITES, MAPS_TO,
 * PUBLISHES_TO, LISTENS_TO. Internal Function→Function CALLS edges DO NOT count.
 *
 * Usage:
 *   bun run scripts/diag-dangling-functions.ts --repo <name> [--limit 30]
 */

import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string) => {
        const i = args.findIndex(a => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const repo = get('repo');
    const limit = parseInt(get('limit') ?? '30', 10);

    if (!repo) {
        console.error('Missing --repo <name>');
        process.exit(1);
    }

    const session = getNeo4jSession();
    try {
        const totalRes = await session.run(
            `MATCH (f:Function)
             WHERE f.valid_to_commit IS NULL AND f.id CONTAINS $repo
             RETURN count(f) AS total`,
            { repo }
        );
        const total = totalRes.records[0]?.get('total')?.toNumber?.() ?? totalRes.records[0]?.get('total') ?? 0;

        const danglingCountRes = await session.run(
            `MATCH (f:Function)
             WHERE f.valid_to_commit IS NULL AND f.id CONTAINS $repo
               AND NOT EXISTS {
                 MATCH (f)-[r:IMPLEMENTS_ENDPOINT|CALLS_API|READS|WRITES|MAPS_TO|PUBLISHES_TO|LISTENS_TO]->()
                 WHERE r.valid_to_commit IS NULL
               }
             RETURN count(f) AS dangling`,
            { repo }
        );
        const dangling = danglingCountRes.records[0]?.get('dangling')?.toNumber?.() ?? danglingCountRes.records[0]?.get('dangling') ?? 0;

        console.log(`\nRepo filter: id CONTAINS "${repo}"`);
        console.log(`Total Function nodes (active):    ${total}`);
        console.log(`Dangling (no infra edges):        ${dangling}  (${total > 0 ? ((dangling / total) * 100).toFixed(1) : 0}%)`);
        console.log(`Connected (≥1 infra edge):        ${total - dangling}\n`);

        const sampleRes = await session.run(
            `MATCH (f:Function)
             WHERE f.valid_to_commit IS NULL AND f.id CONTAINS $repo
               AND NOT EXISTS {
                 MATCH (f)-[r:IMPLEMENTS_ENDPOINT|CALLS_API|READS|WRITES|MAPS_TO|PUBLISHES_TO|LISTENS_TO]->()
                 WHERE r.valid_to_commit IS NULL
               }
             RETURN f.name AS name, f.filepath AS filepath, f.startLine AS startLine,
                    f.endLine AS endLine, f.intent AS intent, f.capabilities AS capabilities,
                    f.source AS groundingSource, f.quality AS groundingQuality
             ORDER BY f.filepath, f.startLine
             LIMIT ${limit}`,
            { repo }
        );

        console.log(`Sample of ${sampleRes.records.length} dangling functions (sorted by file):`);
        console.log('─'.repeat(120));
        for (const r of sampleRes.records) {
            const name = r.get('name');
            const filepath = r.get('filepath');
            const start = r.get('startLine')?.toNumber?.() ?? r.get('startLine');
            const end = r.get('endLine')?.toNumber?.() ?? r.get('endLine');
            const intent = r.get('intent') ?? '';
            const caps = r.get('capabilities') ?? [];
            const src = r.get('groundingSource');
            const qual = r.get('groundingQuality');
            console.log(`\n${filepath}:${start}-${end}  ${name}`);
            console.log(`  grounding: ${src}/${qual}`);
            if (intent) console.log(`  intent: ${intent}`);
            if (Array.isArray(caps) && caps.length > 0) console.log(`  capabilities: ${caps.join(', ')}`);
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
