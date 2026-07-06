/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — In-Memory LLM Output Scorer
 *
 * Scores the raw LLM analysis output (from analyzeFunction) against an
 * expected.graph.yaml manifest WITHOUT requiring a Neo4j database.
 *
 * This is the core of the "Pattern-Based Eval" architecture:
 *   1. Read real source code from a fixture directory
 *   2. Parse it into CodeChunk(s)
 *   3. Run through analyzeFunction() (with LLM replay cache)
 *   4. Score the LLM output against the manifest's expected/negative nodes
 *
 * Used by: tests/eval/patterns/*.eval.test.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EvalManifest } from '../types/eval-manifest.js';
import { loadManifest } from '../types/eval-manifest.js';
import type { CodeChunk } from '../../../src/graph/types.js';
import { getLanguagePlugin } from '../../../src/ingestion/core/languages/registry.js';
import {
    buildEntityTableContext,
    collectEntityTableRegistry,
} from '../../../src/ingestion/processors/code-pipeline/entity-table-registry.js';
import type {
    AnalysisTask,
    StaticAnalysisResult,
} from '../../../src/ingestion/processors/code-pipeline/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LLMAnalysisOutput {
    has_io: boolean;
    infrastructure: Array<{
        name: string;
        type: string;
        operation?: string;
        isDiKey?: boolean;
    }>;
    capabilities?: Array<{
        type: string;
        name?: string;
    }>;
    emergent_api_calls?: Array<{
        path: string;
        method?: string;
    }>;
}

export interface PatternScoreResult {
    fixture: string;
    functionName: string;
    /** True if the LLM returned has_io as expected */
    hasIoCorrect: boolean;
    /** Names extracted by LLM, grouped by type */
    extractedByType: Record<string, string[]>;
    /** Expected nodes found in LLM output */
    truePositives: string[];
    /** Expected nodes NOT found in LLM output */
    falseNegatives: string[];
    /** Negative violations (things that should NOT appear but did) */
    negativeViolations: Array<{
        category: string;
        violatingName: string;
        matchType: 'exact' | 'pattern';
        matchedPattern?: string;
    }>;
}

// ─── Fixture Loader ──────────────────────────────────────────────────────────

/**
 * Detect language from file extension.
 */
function detectLanguage(filepath: string): 'typescript' | 'php' | 'go' | 'python' {
    const ext = path.extname(filepath).toLowerCase();
    switch (ext) {
        case '.ts':
        case '.tsx':
            return 'typescript';
        case '.php':
            return 'php';
        case '.go':
            return 'go';
        case '.py':
            return 'python';
        default:
            return 'typescript';
    }
}

/**
 * Scan a fixture directory for source files and return CodeChunk(s).
 * Skips non-code files (yaml, json, md, etc).
 */
export function loadFixtureChunks(fixtureDir: string): CodeChunk[] {
    const srcDir = path.join(fixtureDir, 'src');
    const searchDir = fs.existsSync(srcDir) ? srcDir : fixtureDir;
    const chunks: CodeChunk[] = [];

    const codeExtensions = new Set(['.ts', '.tsx', '.php', '.go', '.py']);

    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (codeExtensions.has(path.extname(entry.name).toLowerCase())) {
                const sourceCode = fs.readFileSync(fullPath, 'utf-8');
                const relativePath = path.relative(fixtureDir, fullPath);
                const language = detectLanguage(entry.name);

                // Extract function/class name from filename (sans extension)
                const baseName = path.basename(entry.name, path.extname(entry.name));
                const lines = sourceCode.split('\n');

                chunks.push({
                    name: baseName,
                    filepath: relativePath,
                    sourceCode,
                    language,
                    startLine: 1,
                    startColumn: 1,
                    endLine: lines.length,
                    endColumn: 1,
                    envVars: [],
                });
            }
        }
    }

    walk(searchDir);
    return chunks;
}

/**
 * Build the LLM entity-table grounding context for a fixture, the same way
 * the real pipeline does (static-analyzer-pass.ts):
 *
 *   1. Run the language plugin's framework-signal extraction over every
 *      fixture file → `<Class>::__class_metadata` chunks.
 *   2. Run `extractStaticInfra` on each metadata chunk → `MAPS_TO` entries
 *      (the AST-declared @Entity('table') / @Schema({collection}) names).
 *   3. Feed them through the REAL `collectEntityTableRegistry` +
 *      `buildEntityTableContext` (tier-matched against the consumer's
 *      imports), so the eval exercises the production grounding chain.
 *
 * Returns the prompt context string for `analyzeFunction`'s
 * `entityTableContext` parameter, or null when the fixture declares no
 * statically-resolvable entity tables. Without this grounding the LLM
 * GUESSES table names from class names (singular/plural nondeterminism).
 */
export function buildFixtureEntityTableContext(
    fixtureChunks: CodeChunk[],
    consumerChunk: CodeChunk,
): string | null {
    const syntheticResults: StaticAnalysisResult[] = [];

    for (const chunk of fixtureChunks) {
        const plugin = getLanguagePlugin(chunk.language);
        if (!plugin?.extractStaticInfra) continue;

        const parser = plugin.createParser();
        const tree = parser.parse(chunk.sourceCode);
        const fileChunks = plugin.extractFunctions(tree, chunk.sourceCode, chunk.filepath);

        const tasks: AnalysisTask[] = [];
        for (const metaChunk of fileChunks) {
            if (!metaChunk.name.endsWith('::__class_metadata')) continue;
            const staticInfra = plugin.extractStaticInfra(tree.rootNode, metaChunk);
            if (!staticInfra?.infrastructure?.length) continue;
            // Minimal AnalysisTask shape — the registry collector only reads
            // isResolvedStatically, staticAnalysis.infrastructure, chunk.{name,filepath}.
            tasks.push({
                chunk: metaChunk,
                isResolvedStatically: true,
                staticAnalysis: staticInfra,
            } as unknown as AnalysisTask);
        }
        if (tasks.length > 0) {
            syntheticResults.push({ analysisTasks: tasks } as unknown as StaticAnalysisResult);
        }
    }

    const registry = collectEntityTableRegistry(syntheticResults);
    if (registry.length === 0) return null;

    // Raw import lines from the consumer file feed the registry's Tier-1
    // matcher (the same field the pipeline populates on AnalysisTask.imports).
    const imports = consumerChunk.sourceCode
        .split('\n')
        .filter(line => /^\s*(import\s|use\s)/.test(line));

    return buildEntityTableContext(
        { chunk: consumerChunk, imports } as unknown as AnalysisTask,
        registry,
    );
}

/**
 * Load the expected.graph.yaml manifest from a fixture directory.
 */
export function loadFixtureManifest(fixtureDir: string): EvalManifest {
    const manifestPath = path.join(fixtureDir, 'expected.graph.yaml');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`No expected.graph.yaml found in ${fixtureDir}`);
    }
    return loadManifest(manifestPath);
}

// ─── In-Memory Scorer ────────────────────────────────────────────────────────

/**
 * Score a single LLM analysis result against a manifest.
 * This is the in-memory equivalent of scoreNodes + checkNegatives,
 * but operates on the raw LLM JSON instead of a Neo4j graph.
 */
export function scoreAnalysis(
    manifest: EvalManifest,
    functionName: string,
    analysis: LLMAnalysisOutput,
): PatternScoreResult {
    const extractedByType: Record<string, string[]> = {};
    const truePositives: string[] = [];
    const falseNegatives: string[] = [];

    // Group LLM infrastructure output by type
    for (const infra of analysis.infrastructure) {
        // Map LLM types to graph node labels
        const label = mapInfraTypeToLabel(infra.type);
        if (!extractedByType[label]) extractedByType[label] = [];
        extractedByType[label].push(infra.name);
    }

    // Include emergent_api_calls as APIEndpoints
    if (analysis.emergent_api_calls) {
        if (!extractedByType['APIEndpoint']) extractedByType['APIEndpoint'] = [];
        for (const api of analysis.emergent_api_calls) {
            extractedByType['APIEndpoint'].push(api.path);
        }
    }

    // Also add Function from the chunk itself
    if (!extractedByType['Function']) extractedByType['Function'] = [];
    extractedByType['Function'].push(functionName);

    // Score expected_nodes against extracted
    for (const [label, expectedNames] of Object.entries(manifest.expected_nodes)) {
        // Skip labels we can't verify from LLM output alone (Service, Team, etc.)
        // These are verified by the full graph integration test
        if (['Service', 'Team', 'Repository'].includes(label)) continue;

        const actualNames = extractedByType[label] ?? [];
        const actualLower = new Set(actualNames.map(n => n.toLowerCase()));

        for (const expected of expectedNames) {
            if (actualLower.has(expected.toLowerCase()) ||
                actualNames.some(n => n.toLowerCase().includes(expected.toLowerCase()))) {
                truePositives.push(`${label}:${expected}`);
            } else {
                falseNegatives.push(`${label}:${expected}`);
            }
        }
    }

    // Check negatives
    const negativeViolations: PatternScoreResult['negativeViolations'] = [];

    for (const [label, forbiddenNames] of Object.entries(manifest.negative_nodes)) {
        const actualNames = extractedByType[label] ?? [];
        const actualLower = new Set(actualNames.map(n => n.toLowerCase()));

        for (const forbidden of forbiddenNames) {
            if (actualLower.has(forbidden.toLowerCase())) {
                negativeViolations.push({
                    category: label,
                    violatingName: forbidden,
                    matchType: 'exact',
                });
            }
        }
    }

    for (const [label, patterns] of Object.entries(manifest.negative_patterns)) {
        const actualNames = extractedByType[label] ?? [];

        for (const pattern of patterns) {
            const regex = new RegExp(pattern);
            for (const name of actualNames) {
                if (regex.test(name)) {
                    negativeViolations.push({
                        category: label,
                        violatingName: name,
                        matchType: 'pattern',
                        matchedPattern: pattern,
                    });
                }
            }
        }
    }

    return {
        fixture: manifest.fixture,
        functionName,
        hasIoCorrect: true, // caller verifies this separately
        extractedByType,
        truePositives,
        falseNegatives,
        negativeViolations,
    };
}

// ─── Infra Type Mapping ──────────────────────────────────────────────────────

/**
 * Map LLM infrastructure type names to graph node labels.
 */
function mapInfraTypeToLabel(infraType: string): string {
    const normalized = infraType.toLowerCase();
    if (normalized.includes('database') || normalized === 'datacontainer') return 'DataContainer';
    if (normalized.includes('message') || normalized.includes('queue') || normalized.includes('topic')
        || normalized.includes('channel') || normalized === 'messagechannel') return 'MessageChannel';
    if (normalized.includes('cache')) return 'Cache';
    if (normalized.includes('api') || normalized.includes('endpoint')) return 'APIEndpoint';
    return infraType; // Pass through unknown types
}
