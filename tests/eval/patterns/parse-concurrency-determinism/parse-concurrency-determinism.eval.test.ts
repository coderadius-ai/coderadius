/**
 * Pattern Eval — parse-concurrency-determinism
 *
 * Pins the behavior-preserving guarantee of the parallel parse phase:
 * running Stage 2 (`analyzeFiles`) with PARSE_CONCURRENCY=1 (degenerate
 * single-worker pool) and PARSE_CONCURRENCY=4 must produce IDENTICAL
 * analysis output — same tasks, same gates, same static bypasses, same
 * import/taint context, same schema gates — on real multi-file fixtures
 * (imports, taint propagation, framework signals, PSR-4 namespaces).
 *
 * Deterministic: zero LLM calls (Stage 2 only), zero DB access.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFiles } from '../../../../src/ingestion/processors/code-pipeline/static-analyzer.js';
import type { DiscoveryResult, FileContext } from '../../../../src/ingestion/processors/code-pipeline/types.js';
import { computeFileHash } from '../../../../src/ingestion/core/merkle.js';
import { getAllPlugins } from '../../../../src/ingestion/core/languages/registry.js';
import type { ResolvedRepo } from '../../../../src/graph/types.js';

const PATTERNS_DIR = path.join(import.meta.dirname, '..');
const FIXTURES = [
    'php-graphql-same-namespace',
    'ts-taint-propagation',
    'php-psr18-taint-propagation',
    'php-symfony-messenger',
];
const MANIFEST_BASENAMES = new Set(['package.json', 'composer.json']);

function walkFiles(dir: string, root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== 'vendor') walkFiles(full, root, out);
        } else {
            out.push(full);
        }
    }
    return out;
}

/** Stage-1 stand-in: fresh-scan DiscoveryResult over a pattern fixture. */
function discoverFixture(name: string): DiscoveryResult {
    const fixturePath = path.join(PATTERNS_DIR, name, 'fixture');
    const repo: ResolvedRepo = { name: `acme-${name}`, path: fixturePath, origin: 'local' };
    const absolutePaths = walkFiles(fixturePath, fixturePath);
    const files: FileContext[] = absolutePaths.map(absolutePath => {
        const relativePath = path.relative(fixturePath, absolutePath).replace(/\\/g, '/');
        return {
            absolutePath,
            relativePath,
            repo,
            routing: { type: 'repository', name: repo.name, urn: `urn:repository:${repo.name}` },
            fileHash: computeFileHash(absolutePath, '8'),
            ownerService: null,
            isManifest: MANIFEST_BASENAMES.has(path.posix.basename(relativePath)),
        };
    });
    return {
        repo,
        files,
        merkleIndex: { repoHash: null, repoScanMode: null, files: new Map() },
        repoHash: 'fixture-hash',
        skippedCount: 0,
        allFilePaths: new Set(files.map(f => f.relativePath)),
        dependencyMappings: getAllPlugins().flatMap(p => p.loadDependencyMappings?.(fixturePath) ?? []),
    };
}

async function runStage2(fixture: string, parseConcurrency: string) {
    process.env.PARSE_CONCURRENCY = parseConcurrency;
    const { analysisResults, cacheHitResults } = await analyzeFiles(discoverFixture(fixture), undefined, 'semantic');
    return { analysisResults, cacheHitResults };
}

const previousEnv = process.env.PARSE_CONCURRENCY;
afterAll(() => {
    if (previousEnv === undefined) delete process.env.PARSE_CONCURRENCY;
    else process.env.PARSE_CONCURRENCY = previousEnv;
});

describe('Pattern Eval — parse-concurrency-determinism', () => {
    for (const fixture of FIXTURES) {
        it(`${fixture}: PARSE_CONCURRENCY=1 and =4 produce identical Stage-2 output`, async () => {
            const serial = await runStage2(fixture, '1');
            const parallel = await runStage2(fixture, '4');

            // Meaningful corpus guard: the fixture must actually produce work.
            expect(serial.analysisResults.length).toBeGreaterThan(0);
            const taskCount = serial.analysisResults.reduce((n, r) => n + r.analysisTasks.length, 0);
            expect(taskCount).toBeGreaterThan(0);

            // Full structural identity: per-file results in the same order,
            // tasks with identical gates/contexts/static bypasses.
            expect(parallel.analysisResults).toEqual(serial.analysisResults);
            expect(parallel.cacheHitResults).toEqual(serial.cacheHitResults);
        }, 120_000);
    }
});
