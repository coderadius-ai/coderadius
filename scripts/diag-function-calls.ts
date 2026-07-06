/**
 * For a given function, list its outgoing CALLS edges (to other functions) and
 * indirect transitive I/O edges within 2 hops.
 *
 * Usage:
 *   bun run scripts/diag-function-calls.ts --file <path> --name <funcName>
 */

import { getNeo4jSession, closeNeo4j } from '../src/graph/neo4j.js';

async function main() {
    const args = process.argv.slice(2);
    const get = (k: string) => {
        const i = args.findIndex(a => a === `--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const file = get('file');
    const name = get('name');
    if (!file || !name) {
        console.error('Missing --file or --name');
        process.exit(1);
    }

    const session = getNeo4jSession();
    try {
        const directCalls = await session.run(
            `MATCH (f:Function {filepath: $file, name: $name})-[r:CALLS]->(t:Function)
             WHERE f.valid_to_commit IS NULL AND r.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             RETURN t.name AS targetName, t.filepath AS targetFile
             ORDER BY t.filepath, t.name
             LIMIT 50`,
            { file, name }
        );

        console.log(`\nDirect CALLS from ${name} (${file}):  ${directCalls.records.length}`);
        for (const r of directCalls.records) {
            console.log(`  -> ${r.get('targetName')}  (${r.get('targetFile')})`);
        }

        const transitive = await session.run(
            `MATCH (f:Function {filepath: $file, name: $name})-[:CALLS*1..3]->(reachable:Function)-[r2]->(infra)
             WHERE f.valid_to_commit IS NULL AND reachable.valid_to_commit IS NULL
               AND r2.valid_to_commit IS NULL
               AND type(r2) IN ['IMPLEMENTS_ENDPOINT','CALLS_API','READS','WRITES','MAPS_TO','PUBLISHES_TO','LISTENS_TO']
             RETURN DISTINCT type(r2) AS rel, labels(infra) AS lbl, coalesce(infra.name, infra.path, infra.id) AS target, reachable.name AS via
             ORDER BY rel, target
             LIMIT 50`,
            { file, name }
        );

        console.log(`\nTransitive I/O within 3 hops:  ${transitive.records.length}`);
        for (const r of transitive.records) {
            console.log(`  ${r.get('rel')} -> ${r.get('lbl').join(':')} ${r.get('target')}  (via ${r.get('via')})`);
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
