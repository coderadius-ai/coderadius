/**
 * Assess a live graph against an expected.graph.yaml manifest. Read-only.
 *
 * Same manifest schema and scorer as the eval-patterns suite
 * (tests/eval/types/eval-manifest.ts + tests/eval/scorers/eval-scorer.ts);
 * this entrypoint just runs them OUTSIDE vitest, against any Memgraph.
 *
 * Usage:
 *   bun run scripts/assess-graph.ts --manifest <expected.graph.yaml>
 *                                   [--uri bolt://localhost:7687]
 *                                   [--repo <scope>]          # e.g. acme/acme
 *                                   [--mode field|fixture]    # default: field
 *                                   [--json <report.json>]
 *                                   [--min-recall 0.8] [--min-precision 0.8]
 *                                   [--no-fail-on-negatives]
 *
 * Semantics (inherited from the scorer):
 *   - A label is scored ONLY if present in expected_nodes, and its expected
 *     list is treated as EXHAUSTIVE there (graph − expected = FP).
 *     For partially-asserted classes use negative_nodes / negative_patterns.
 *   - 'field' mode canonicalizes both sides: endpoints as 'METHOD /path' with
 *     params → {}, names lowercased. Author the manifest in that form
 *     (generate it with canonicalNodeName to stay symmetric).
 *   - Only live nodes count (valid_to_commit IS NULL).
 *
 * Exit code: 1 when a provided threshold is breached or (by default) when any
 * negative assertion is violated; 0 otherwise.
 */

import { loadManifest } from '../tests/eval/types/eval-manifest.js';
import {
    scoreNodes,
    scoreEdges,
    scoreSymbols,
    checkNegatives,
    assembleReport,
    writeReportJSON,
} from '../tests/eval/scorers/eval-scorer.js';
import { renderFieldReport } from '../tests/eval/scorers/report-render.js';
import {
    buildGraphSnapshot,
    type SnapshotMode,
} from '../tests/eval/scorers/graph-snapshot.js';

function getFlag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
    const manifestPath = getFlag('manifest');
    if (!manifestPath) {
        console.error('Missing required --manifest <expected.graph.yaml>');
        process.exit(2);
    }
    const uri = getFlag('uri');
    if (uri) process.env.MEMGRAPH_URI = uri;

    const mode = (getFlag('mode') ?? 'field') as SnapshotMode;
    if (mode !== 'field' && mode !== 'fixture') {
        console.error(`Unknown --mode ${mode}. Pick: field | fixture`);
        process.exit(2);
    }
    const minRecall = getFlag('min-recall') ? Number(getFlag('min-recall')) : undefined;
    const minPrecision = getFlag('min-precision') ? Number(getFlag('min-precision')) : undefined;

    // Lazy import AFTER --uri lands in the env (the driver reads it per session).
    const { getNeo4jSession, closeNeo4j } = await import('../src/graph/neo4j.js');

    const manifest = loadManifest(manifestPath);
    // --repo wins; otherwise the manifest's own target keeps the measurement
    // scoped even when the local graph accumulates other repositories.
    const repoScope = getFlag('repo') ?? manifest.target?.repo;
    const labels = [...new Set([
        ...Object.keys(manifest.expected_nodes),
        ...Object.keys(manifest.negative_nodes),
        ...Object.keys(manifest.negative_patterns),
    ])];

    const cypher = async <T = Record<string, unknown>>(
        query: string,
        params: Record<string, unknown> = {},
    ): Promise<T[]> => {
        const session = getNeo4jSession();
        try {
            const result = await session.run(query, params);
            return result.records.map((r) => r.toObject() as T);
        } finally {
            await session.close();
        }
    };

    try {
        if (!repoScope) {
            const repoCount = (await cypher<{ c: number }>(
                'MATCH (r:Repository) WHERE r.valid_to_commit IS NULL RETURN count(r) AS c',
            ))[0]?.c ?? 0;
            if (Number(repoCount) > 1) {
                console.error(`  ⚠ graph holds ${repoCount} repositories and no scope is set: global labels (MessageChannel, …) will mix repos. Pass --repo or add target.repo to the manifest.`);
            }
        }

        const snapshot = await buildGraphSnapshot(labels, { mode, repoScope });

        const nodeScores = scoreNodes(manifest, snapshot);
        const negativeViolations = checkNegatives(manifest, snapshot);
        const edgeResult = await scoreEdges(manifest, cypher);
        const channelNames = snapshot.get('MessageChannel')
            ?? (await buildGraphSnapshot(['MessageChannel'], { mode, repoScope })).get('MessageChannel')
            ?? [];
        const symbolScore = scoreSymbols(manifest, new Set(channelNames));

        const report = assembleReport({
            fixture: manifest.fixture,
            cliVersion: process.env.npm_package_version ?? 'dev',
            llmModel: 'live-graph',
            nodeScores,
            edgeResult,
            symbolScore,
            negativeViolations,
        });

        console.log(renderFieldReport(report, {
            uri: process.env.MEMGRAPH_URI ?? 'bolt://localhost:7687',
            width: process.stdout.columns,
        }));

        const jsonOut = getFlag('json');
        if (jsonOut) {
            writeReportJSON(report, jsonOut);
            console.log(`  Report JSON → ${jsonOut}\n`);
        }

        const failures: string[] = [];
        for (const s of nodeScores) {
            if (minRecall !== undefined && s.recall < minRecall) {
                failures.push(`${s.category} recall ${(s.recall * 100).toFixed(1)}% < ${minRecall * 100}%`);
            }
            if (minPrecision !== undefined && s.precision < minPrecision) {
                failures.push(`${s.category} precision ${(s.precision * 100).toFixed(1)}% < ${minPrecision * 100}%`);
            }
        }
        if (negativeViolations.length > 0 && !hasFlag('no-fail-on-negatives')) {
            failures.push(`${negativeViolations.length} negative assertion violation(s)`);
        }
        if (failures.length > 0) {
            for (const f of failures) console.error(`  ✗ ${f}`);
            console.error('');
            process.exit(1);
        }
        console.log('  ✓ PASS\n');
        process.exit(0);
    } finally {
        await closeNeo4j();
    }
}

main().catch((e) => { console.error(e); process.exit(2); });
