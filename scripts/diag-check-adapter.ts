/**
 * For a given source file (the concrete adapter), report whether its Function
 * nodes in the graph have any I/O edges, and what those edges target.
 *
 * Usage:
 *   bun run scripts/diag-check-adapter.ts --file <relativePath>
 */

import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string) => {
        const i = args.findIndex(a => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const file = get('file');
    if (!file) {
        console.error('Missing --file <relativePath>');
        process.exit(1);
    }

    const session = getNeo4jSession();
    try {
        const res = await session.run(
            `MATCH (f:Function)
             WHERE f.valid_to_commit IS NULL AND f.filepath = $file
             OPTIONAL MATCH (f)-[r]->(t)
             WHERE r.valid_to_commit IS NULL
               AND type(r) IN ['IMPLEMENTS_ENDPOINT','CALLS_API','READS','WRITES','MAPS_TO','PUBLISHES_TO','LISTENS_TO']
             WITH f, collect({ rel: type(r), targetLabels: labels(t), targetName: coalesce(t.name, t.path, t.id) }) AS edges
             RETURN f.name AS name, f.startLine AS start, f.endLine AS end, f.capabilities AS caps, edges
             ORDER BY f.startLine`,
            { file }
        );

        console.log(`\nFile: ${file}`);
        console.log(`Function nodes: ${res.records.length}\n`);

        for (const r of res.records) {
            const name = r.get('name');
            const start = r.get('start')?.toNumber?.() ?? r.get('start');
            const end = r.get('end')?.toNumber?.() ?? r.get('end');
            const caps = r.get('caps') ?? [];
            const edges = r.get('edges').filter((e: any) => e.rel != null);

            console.log(`${name}  L${start}-${end}`);
            if (Array.isArray(caps) && caps.length > 0) console.log(`  capabilities: ${caps.join(', ')}`);
            if (edges.length === 0) {
                console.log(`  edges: NONE`);
            } else {
                for (const e of edges) {
                    console.log(`  ${e.rel} -> ${e.targetLabels.join(':')} ${e.targetName ?? '(no name)'}`);
                }
            }
            console.log();
        }
    } finally {
        await closeNeo4j();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
