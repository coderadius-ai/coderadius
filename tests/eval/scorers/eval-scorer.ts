// ═══════════════════════════════════════════════════════════════════════════════
// EvalScorer — Precision/Recall Scoring Engine
//
// Compares the actual Neo4j graph state against an EvalManifest and produces
// per-category precision/recall scores, symbol resolution verification, and
// negative violation detection.
//
// Zero LLM calls. Deterministic comparison.
// ═══════════════════════════════════════════════════════════════════════════════

import type {
    EvalManifest,
    ExpectedEdge,
    ExpectedSymbol,
} from '../types/eval-manifest.js';
import {
    isNodeEdge,
    isFunctionEdge,
    isServiceResourceEdge,
} from '../types/eval-manifest.js';
import fs from 'node:fs';
import path from 'node:path';

// ─── Domain Types ────────────────────────────────────────────────────────────

import type { NodeLabel } from '../../../src/graph/domain.js';

/** DI container key before resolution (e.g., "notredeemable.publisher") */
export type DiKey = string;

/** Physical infrastructure name after resolution (e.g., "loyalty.not_redeemable") */
export type PhysicalName = string;

/** Human-readable edge description for reporting (e.g., "order-service -[DEPENDS_ON]-> users") */
export type EdgeDescription = string;

/** Regex pattern string for negative matching */
export type NegativePattern = string;

/** Label → node names snapshot from the live graph */
export type GraphSnapshot = Map<NodeLabel, string[]>;

// ─── Score Types ─────────────────────────────────────────────────────────────

export interface NodeScore {
    category: NodeLabel;
    expectedCount: number;
    actualCount: number;
    truePositives: string[];
    falsePositives: string[];
    falseNegatives: string[];
    precision: number;
    recall: number;
}

export interface EdgeResult {
    expectedCount: number;
    foundCount: number;
    missingEdges: EdgeDescription[];
}

export interface NegativeViolation {
    category: NodeLabel;
    violatingName: string;
    matchType: 'exact' | 'pattern';
    matchedPattern?: NegativePattern;
}

export interface SymbolScore {
    expectedCount: number;
    resolvedCount: number;
    unresolvedDiKeys: DiKey[];
    missingPhysicalNames: PhysicalName[];
}

export interface EvalReport {
    fixture: string;
    timestamp: string;
    cliVersion: string;
    llmModel: string;
    nodeScores: NodeScore[];
    edgeResult: EdgeResult;
    symbolScore: SymbolScore;
    negativeViolations: NegativeViolation[];
    aggregatePrecision: number;
    aggregateRecall: number;
    criticalRegressionCount: number;
    advisorySkippedCount: number;
}

// ─── Scoring Functions ───────────────────────────────────────────────────────

/** Callback that executes a Cypher query and returns raw records. */
export type CypherRunner = (
    query: string,
    params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

export function scoreNodes(
    manifest: EvalManifest,
    graphSnapshot: GraphSnapshot,
): NodeScore[] {
    const scores: NodeScore[] = [];

    for (const [label, expectedNames] of Object.entries(manifest.expected_nodes)) {
        if (expectedNames.length === 0) continue;

        const actualNames = graphSnapshot.get(label) ?? [];
        const actualSet = new Set(actualNames);
        const expectedSet = new Set(expectedNames);

        const truePositives = expectedNames.filter(n => actualSet.has(n));
        const falseNegatives = expectedNames.filter(n => !actualSet.has(n));
        const falsePositives = actualNames.filter(n => !expectedSet.has(n));

        const tp = truePositives.length;
        const fp = falsePositives.length;
        const fn = falseNegatives.length;

        scores.push({
            category: label,
            expectedCount: expectedNames.length,
            actualCount: actualNames.length,
            truePositives,
            falsePositives,
            falseNegatives,
            precision: tp + fp > 0 ? tp / (tp + fp) : 1.0,
            recall: tp + fn > 0 ? tp / (tp + fn) : 1.0,
        });
    }

    return scores;
}

export function checkNegatives(
    manifest: EvalManifest,
    graphSnapshot: GraphSnapshot,
): NegativeViolation[] {
    const violations: NegativeViolation[] = [];

    for (const [label, forbiddenNames] of Object.entries(manifest.negative_nodes)) {
        const actualNames = graphSnapshot.get(label) ?? [];
        const actualSet = new Set(actualNames.map(n => n.toLowerCase()));

        for (const forbidden of forbiddenNames) {
            if (actualSet.has(forbidden.toLowerCase())) {
                violations.push({ category: label, violatingName: forbidden, matchType: 'exact' });
            }
        }
    }

    for (const [label, patterns] of Object.entries(manifest.negative_patterns)) {
        const actualNames = graphSnapshot.get(label) ?? [];

        for (const pattern of patterns) {
            const regex = new RegExp(pattern);
            for (const name of actualNames) {
                if (regex.test(name)) {
                    violations.push({ category: label, violatingName: name, matchType: 'pattern', matchedPattern: pattern });
                }
            }
        }
    }

    return violations;
}

// ─── Edge Scoring ────────────────────────────────────────────────────────────

/**
 * Build the appropriate Cypher query for an expected edge assertion.
 * Returns { query, params, description }.
 */
function buildEdgeQuery(edge: ExpectedEdge): {
    query: string;
    params: Record<string, unknown>;
    description: string;
} {
    if (isNodeEdge(edge)) {
        // Pipe in rel means OR (e.g., "READS|WRITES")
        const rels = edge.rel.split('|');
        const relClause = rels.map(r => `type(rel) = '${r}'`).join(' OR ');
        return {
            query: `MATCH (a)-[rel]->(b)
                    WHERE a.name = $from AND b.name = $to AND (${relClause})
                    RETURN count(rel) AS cnt`,
            params: { from: edge.from, to: edge.to },
            description: `${edge.from} -[${edge.rel}]-> ${edge.to}`,
        };
    }

    if (isFunctionEdge(edge)) {
        const rels = edge.rel.split('|');
        const relClause = rels.map(r => `type(rel) = '${r}'`).join(' OR ');
        // from_function is "ClassName.methodName" — match via CONTAINS on the function name
        // This uses exact string match on the function's name property
        return {
            query: `MATCH (f:Function)-[rel]->(target)
                    WHERE f.name = $fnName AND target.name = $to AND (${relClause})
                    RETURN count(rel) AS cnt`,
            params: { fnName: edge.from_function, to: edge.to },
            description: `fn:${edge.from_function} -[${edge.rel}]-> ${edge.to}`,
        };
    }

    if (isServiceResourceEdge(edge)) {
        const rels = edge.rel.split('|');
        const relClause = rels.map(r => `type(rel) = '${r}'`).join(' OR ');
        return {
            query: `MATCH (s:Service {name: $svc})-[:CONTAINS]->(f:Function)-[rel]->(target {name: $to})
                    WHERE ${relClause}
                    RETURN count(rel) AS cnt`,
            params: { svc: edge.from_service, to: edge.to },
            description: `svc:${edge.from_service} -[${edge.rel}]-> ${edge.to}`,
        };
    }

    throw new Error(`Unknown edge type: ${JSON.stringify(edge)}`);
}

export async function scoreEdges(
    manifest: EvalManifest,
    runCypher: CypherRunner,
): Promise<EdgeResult> {
    const missingEdges: EdgeDescription[] = [];
    let foundCount = 0;

    for (const edge of manifest.expected_edges) {
        const { query, params, description } = buildEdgeQuery(edge);
        try {
            const rows = await runCypher(query, params);
            const cnt = Number((rows[0] as any)?.cnt ?? 0);
            if (cnt > 0) {
                foundCount++;
            } else {
                missingEdges.push(description);
            }
        } catch (err) {
            missingEdges.push(`${description} (query error: ${(err as Error).message})`);
        }
    }

    return {
        expectedCount: manifest.expected_edges.length,
        foundCount,
        missingEdges,
    };
}

// ─── Symbol Scoring ──────────────────────────────────────────────────────────

export function scoreSymbols(
    manifest: EvalManifest,
    messageChannelNames: Set<PhysicalName>,
): SymbolScore {
    const unresolvedDiKeys: DiKey[] = [];
    const missingPhysicalNames: PhysicalName[] = [];
    let resolvedCount = 0;

    for (const sym of manifest.expected_symbols) {
        if (messageChannelNames.has(sym.resolvedTo)) {
            resolvedCount++;
        } else {
            missingPhysicalNames.push(`${sym.diKey} → ${sym.resolvedTo}`);
        }

        if (messageChannelNames.has(sym.diKey)) {
            unresolvedDiKeys.push(sym.diKey);
        }
    }

    return {
        expectedCount: manifest.expected_symbols.length,
        resolvedCount,
        unresolvedDiKeys,
        missingPhysicalNames,
    };
}

// ─── Report Generation ───────────────────────────────────────────────────────

function computeAggregates(scores: NodeScore[]): { precision: number; recall: number } {
    let totalTP = 0;
    let totalFP = 0;
    let totalFN = 0;

    // We only penalize precision (count False Positives) for critical I/O nodes.
    // For volatile AST nodes like Function/Package/APIEndpoint, we only track Recall.
    const CRITICAL_IO_LABELS = new Set(['MessageChannel', 'DataContainer', 'DatabaseEndpoint']);

    for (const s of scores) {
        totalTP += s.truePositives.length;
        totalFN += s.falseNegatives.length;

        if (CRITICAL_IO_LABELS.has(s.category)) {
            totalFP += s.falsePositives.length;
        }
    }

    return {
        precision: totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1.0,
        recall: totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1.0,
    };
}

export function assembleReport(opts: {
    fixture: string;
    cliVersion: string;
    llmModel: string;
    nodeScores: NodeScore[];
    edgeResult: EdgeResult;
    symbolScore: SymbolScore;
    negativeViolations: NegativeViolation[];
    advisorySkippedCount?: number;
}): EvalReport {
    const aggregates = computeAggregates(opts.nodeScores);
    return {
        fixture: opts.fixture,
        timestamp: new Date().toISOString(),
        cliVersion: opts.cliVersion,
        llmModel: opts.llmModel,
        nodeScores: opts.nodeScores,
        edgeResult: opts.edgeResult,
        symbolScore: opts.symbolScore,
        negativeViolations: opts.negativeViolations,
        aggregatePrecision: aggregates.precision,
        aggregateRecall: aggregates.recall,
        criticalRegressionCount: opts.negativeViolations.length,
        advisorySkippedCount: opts.advisorySkippedCount ?? 0,
    };
}

// ─── Console Report Printer ──────────────────────────────────────────────────

export function printReport(report: EvalReport): void {
    const SEP = '═'.repeat(59);
    const line = (s: string) => console.log(s);

    line('');
    line(SEP);
    line(`  CodeRadius Extraction Report — ${report.fixture}`);
    line(`  ${report.timestamp.split('T')[0]} │ v${report.cliVersion} │ ${report.llmModel}`);
    line(SEP);
    line('');

    for (const s of report.nodeScores) {
        const pct = (n: number) => (n * 100).toFixed(1).padStart(5) + '%';
        const ratio = `(${s.truePositives.length}/${s.expectedCount})`;
        line(`  ${s.category.padEnd(18)} precision: ${pct(s.precision)}   recall: ${pct(s.recall)}   ${ratio}`);
        if (s.falsePositives.length > 0 && s.falsePositives.length <= 5) {
            line(`    FP: [${s.falsePositives.join(', ')}]`);
        } else if (s.falsePositives.length > 5) {
            line(`    FP: ${s.falsePositives.length} items (omitted)`);
        }
        if (s.falseNegatives.length > 0) {
            line(`    FN: [${s.falseNegatives.join(', ')}]`);
        }
    }

    line('');
    line('  ─── Edges ──────────────────────────────────────────────');
    line(`  Verified: ${report.edgeResult.foundCount}/${report.edgeResult.expectedCount}`);
    if (report.edgeResult.missingEdges.length > 0) {
        for (const m of report.edgeResult.missingEdges) {
            line(`    MISSING: ${m}`);
        }
    }

    if (report.symbolScore.expectedCount > 0) {
        line('');
        line('  ─── Symbol Resolution ──────────────────────────────────');
        line(`  DI Symbols: ${report.symbolScore.resolvedCount}/${report.symbolScore.expectedCount} resolved`);
        if (report.symbolScore.unresolvedDiKeys.length > 0) {
            line(`  ⚠ Unresolved DI keys as MessageChannel: [${report.symbolScore.unresolvedDiKeys.join(', ')}]`);
        }
        if (report.symbolScore.missingPhysicalNames.length > 0) {
            line(`  ⚠ Missing physical names: [${report.symbolScore.missingPhysicalNames.join(', ')}]`);
        }
    }

    line('');
    line('  ─── Aggregate ──────────────────────────────────────────');
    line(`  Precision:       ${(report.aggregatePrecision * 100).toFixed(1)}%`);
    line(`  Recall:          ${(report.aggregateRecall * 100).toFixed(1)}%`);
    line(`  Regressions:     ${report.criticalRegressionCount}`);
    line(`  Negatives:       ${report.negativeViolations.length}`);
    line(`  Advisory Skip:   ${report.advisorySkippedCount}`);
    line(SEP);
    line('');
}

export function writeReportJSON(report: EvalReport, outputPath: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
}

// ─── Eval History (Append-Only JSONL) ────────────────────────────────────────

export interface EvalHistoryEntry {
    timestamp: string;
    commit: string;
    fixture: string;
    model: string;
    precision: number;
    recall: number;
    edgeCoverage: number;
    symbolResolution: number;
    regressions: number;
}

/**
 * Append a compact history entry to .eval-history.jsonl for regression tracking.
 *
 * Each line is a self-contained JSON object, enabling:
 *   - `git blame` visibility on when metrics changed
 *   - CI gate integration (e.g., fail if precision drops below threshold)
 *   - Machine-parseable trend analysis without loading full report JSONs
 */
export function appendToHistory(report: EvalReport, historyPath: string): void {
    const commit = (() => {
        try {
            const { execSync } = require('child_process');
            return (execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }) as string).trim();
        } catch {
            return 'unknown';
        }
    })();

    const edgeCoverage = report.edgeResult.expectedCount > 0
        ? report.edgeResult.foundCount / report.edgeResult.expectedCount
        : 1.0;

    const symbolResolution = report.symbolScore.expectedCount > 0
        ? report.symbolScore.resolvedCount / report.symbolScore.expectedCount
        : 1.0;

    const entry: EvalHistoryEntry = {
        timestamp: report.timestamp,
        commit,
        fixture: report.fixture,
        model: report.llmModel,
        precision: Math.round(report.aggregatePrecision * 10000) / 10000,
        recall: Math.round(report.aggregateRecall * 10000) / 10000,
        edgeCoverage: Math.round(edgeCoverage * 10000) / 10000,
        symbolResolution: Math.round(symbolResolution * 10000) / 10000,
        regressions: report.criticalRegressionCount,
    };

    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf-8');
}
