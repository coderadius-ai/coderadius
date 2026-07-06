// ═══════════════════════════════════════════════════════════════════════════════
// Extraction Harness — the DB-free numeric oracle
//
// For every tests/eval/extraction/<name>/ fixture that carries an
// expected.graph.yaml, run the full ephemeral pipeline in-memory and score
// precision / recall / regressions against the golden. Gate at 90%. Covers
// languages, frameworks, and technologies (routes, ORM, brokers, config).
//
// This is the fitness function a coverage-expansion loop optimizes against:
//   - add coverage → drop <name>/fixture/ micro-repo + <name>/expected.graph.yaml
//   - the loop reads pass/fail from the gate and the numbers from stdout
//
// Replay cache (EVAL_LLM_MODE=replay, default) keeps LLM-bearing fixtures
// deterministic; purely-static fixtures (routing, config) make zero LLM calls.
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { extractEphemeralTopology } from '../../../src/eval/ephemeral-extractor.js';
import { SymbolRegistry } from '../../../src/ingestion/core/symbol-registry.js';
import { getAllPlugins } from '../../../src/ingestion/core/languages/registry.js';
import { loadManifest } from '../types/eval-manifest.js';
import {
    scoreNodes,
    scoreSymbols,
    checkNegatives,
    assembleReport,
    printReport,
    type EvalReport,
} from '../scorers/eval-scorer.js';
import {
    snapshotsToGraphSnapshot,
    collectEdges,
    scoreEdgesInMemory,
} from '../scorers/ephemeral-snapshot.js';
import { runStructuralPluginsInMemory } from '../scorers/structural-in-memory.js';
import type { GraphSnapshot } from '../scorers/eval-scorer.js';
import type { GraphEdgeSnapshot } from '../../../src/eval/types.js';
import type { NodeLabel } from '../../../src/graph/domain.js';
import { wireUnifiedAnalyzerReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';

const EXTRACTION_DIR = path.resolve(import.meta.dirname);
const GATE = 0.9;

/** Repo-relative source files under a fixture's repo root (known languages only). */
function listSourceFiles(root: string): string[] {
    const exts = new Set(getAllPlugins().flatMap(p => [...p.extensions]));
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (e.name !== 'node_modules' && e.name !== 'vendor') walk(path.join(dir, e.name));
            } else if (exts.has(path.extname(e.name))) {
                out.push(path.relative(root, path.join(dir, e.name)));
            }
        }
    };
    walk(root);
    return out;
}

/** Every repo-relative file under a fixture's repo root (for the structural pass). */
function listAllFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (e.name !== 'node_modules' && e.name !== 'vendor' && e.name !== '.git') {
                    walk(path.join(dir, e.name));
                }
            } else {
                out.push(path.relative(root, path.join(dir, e.name)));
            }
        }
    };
    walk(root);
    return out;
}

/**
 * Run the structural FILE_PLUGINS in-memory over the fixture's config files
 * (messenger.yaml, rabbitmq-definitions.json, Doctrine migrations, ...) and
 * merge the emitted nodes/edges into the ephemeral snapshot BEFORE scoring.
 * Purely additive: config-declared infrastructure the ephemeral pipeline never
 * sees (it only walks source files) becomes measurable in the same golden.
 */
function mergeStructural(
    repoRoot: string,
    repoName: string,
    graphSnapshot: GraphSnapshot,
    edges: GraphEdgeSnapshot[],
): { graphSnapshot: GraphSnapshot; edges: GraphEdgeSnapshot[] } {
    const files = listAllFiles(repoRoot).map(p => ({
        path: p,
        content: fs.readFileSync(path.join(repoRoot, p), 'utf-8'),
    }));
    const { nodes, edges: structEdges } = runStructuralPluginsInMemory(files, repoName);
    for (const node of nodes) {
        const label = node.type as NodeLabel;
        const names = graphSnapshot.get(label) ?? [];
        if (!names.includes(node.name)) names.push(node.name);
        graphSnapshot.set(label, names);
    }
    return { graphSnapshot, edges: [...edges, ...structEdges] };
}

async function runCoverageFixture(fixtureDir: string): Promise<EvalReport> {
    const manifest = loadManifest(path.join(fixtureDir, 'expected.graph.yaml'));
    const repoRoot = path.join(fixtureDir, 'fixture');
    const repoName = manifest.target?.repo ?? 'acme/acme';
    const { snapshots } = await extractEphemeralTopology({
        repoRoot,
        repoName,
        changedFiles: listSourceFiles(repoRoot),
        symbolRegistry: new SymbolRegistry(),
    });
    const { graphSnapshot, edges } = mergeStructural(
        repoRoot,
        repoName,
        snapshotsToGraphSnapshot(snapshots),
        collectEdges(snapshots),
    );
    return assembleReport({
        fixture: manifest.fixture,
        cliVersion: process.env.npm_package_version ?? 'dev',
        llmModel: EVAL_LLM_MODE,
        nodeScores: scoreNodes(manifest, graphSnapshot),
        edgeResult: scoreEdgesInMemory(manifest, edges),
        symbolScore: scoreSymbols(manifest, new Set(graphSnapshot.get('MessageChannel') ?? [])),
        negativeViolations: checkNegatives(manifest, graphSnapshot),
    });
}

const fixtures = fs.readdirSync(EXTRACTION_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(EXTRACTION_DIR, e.name, 'expected.graph.yaml')))
    .map(e => e.name);

describe('extraction coverage', () => {
    beforeAll(async () => { await wireUnifiedAnalyzerReplay(); });

    it.each(fixtures)('%s meets the precision/recall gate', async (name) => {
        const report = await runCoverageFixture(path.join(EXTRACTION_DIR, name));
        printReport(report);
        expect(report.criticalRegressionCount,
            `negative violations: ${JSON.stringify(report.negativeViolations)}`).toBe(0);
        expect(report.aggregateRecall,
            `missing nodes: ${JSON.stringify(report.nodeScores.flatMap(s => s.falseNegatives))}`,
        ).toBeGreaterThanOrEqual(GATE);
        expect(report.aggregatePrecision).toBeGreaterThanOrEqual(GATE);
    });
});
