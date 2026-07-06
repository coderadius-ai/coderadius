/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-zodios-outbound
 *
 * Verifies that the Zodios deterministic detection pipeline (post-LLM merge)
 * correctly resolves API call aliases to their HTTP endpoints WITHOUT any LLM
 * involvement.
 *
 * Architecture under test:
 *   zodios-context-builder → resolveZodiosCallsForTask()
 *     (returns ZodiosResolvedCall[] — purely deterministic, zero LLM tokens)
 *
 * Key assertions:
 *   ✓ GET /api/v1/quotes is resolved from .getQuotes() alias
 *   ✓ POST /api/v1/quotes is resolved from .createQuote() alias
 *   ✓ DELETE /api/v1/quotes/:quoteId is NOT resolved (not called in QuoteUseCase)
 *   ✓ Wrapper method names (getQuotes, createQuote) do NOT become APIEndpoint nodes
 *   ✓ The resolved calls have correct HTTP methods (uppercase)
 *   ✓ The result is deterministic (same input → same output, always)
 *
 * This test does NOT call the LLM. It runs in ~1ms (no replay cache needed).
 *
 * Fixture: tests/eval/patterns/ts-zodios-outbound/fixture/
 * Manifest: tests/eval/patterns/ts-zodios-outbound/expected.graph.yaml
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
    collectZodiosAliasMaps,
    resolveZodiosCallsForTask,
    type ZodiosResolvedCall,
} from '../../../../src/ingestion/processors/code-pipeline/zodios-context-builder.js';
import type { AnalysisTask } from '../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FileImportMap } from '../../../../src/ingestion/core/import-graph.js';
import { loadFixtureManifest } from '../../helpers/pattern-eval.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const SRC_DIR = path.join(FIXTURE_DIR, 'src');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk a directory recursively and return all file paths.
 */
function walkDir(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkDir(fullPath));
        } else {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Build a minimal FileImportMap for a given source file by statically
 * scanning its import statements. Good enough for the zodios-context-builder
 * which only needs specifier names and source paths.
 */
function buildImportMap(absolutePath: string, relativeBase: string): FileImportMap {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const relativePath = path.relative(FIXTURE_DIR, absolutePath);
    const imports: FileImportMap['imports'] = [];

    // Match: import { ... } from 'source' or import type { ... } from 'source'
    const importRegex = /import\s+(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
        const namedImports = match[1];
        const namespaceImport = match[2];
        const defaultImport = match[3];
        const source = match[4];

        const specifiers: string[] = [];
        if (namedImports) {
            specifiers.push(
                ...namedImports
                    .split(',')
                    .map(s => s.trim().replace(/\s+as\s+\w+/, '').trim())
                    .filter(Boolean),
            );
        }
        if (namespaceImport) specifiers.push(namespaceImport);
        if (defaultImport) specifiers.push(defaultImport);

        imports.push({
            source,
            specifiers,
            isExternal: !source.startsWith('.') && !source.startsWith('/'),
        });
    }

    return {
        filePath: relativePath,
        imports,
    };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Pattern Eval — ts-zodios-outbound (Deterministic AST Resolver)', () => {
    let manifest: ReturnType<typeof loadFixtureManifest>;
    let resolvedCalls: ZodiosResolvedCall[];

    beforeAll(() => {
        manifest = loadFixtureManifest(TEST_DIR);

        // 1. Collect all source files from the fixture
        const allFiles = walkDir(SRC_DIR);
        const parsedFiles = allFiles
            .filter(f => f.endsWith('.ts'))
            .map(f => ({
                relativePath: path.relative(FIXTURE_DIR, f),
                fileContent: fs.readFileSync(f, 'utf-8'),
            }));

        // 2. Build import maps for each file
        const fileImportMaps: FileImportMap[] = parsedFiles.map(pf =>
            buildImportMap(path.join(FIXTURE_DIR, pf.relativePath), FIXTURE_DIR),
        );

        // 3. Collect all file paths (for import resolution)
        const allFilePaths = new Set(parsedFiles.map(pf => pf.relativePath));

        // 4. Build the Zodios index (the same call made in static-analyzer-pass)
        const { zodiosIndex, zodiosTypeIndex } = collectZodiosAliasMaps(
            parsedFiles,
            fileImportMaps,
            allFilePaths,
        );

        // 5. Build a minimal AnalysisTask for the QuoteUseCase consumer
        const quoteUseCasePath = 'src/usecases/QuoteUseCase.ts';
        const quoteUseCaseContent = fs.readFileSync(
            path.join(FIXTURE_DIR, quoteUseCasePath),
            'utf-8',
        );
        const quoteUseCaseImportMap = fileImportMaps.find(
            m => m.filePath === quoteUseCasePath,
        )!;

        const minimalTask = {
            chunk: {
                name: 'QuoteUseCase',
                sourceCode: quoteUseCaseContent,
                filepath: quoteUseCasePath,
                language: 'typescript' as const,
                startLine: 1,
                endLine: quoteUseCaseContent.split('\n').length,
            },
            fileContext: {
                relativePath: quoteUseCasePath,
                repo: { path: FIXTURE_DIR, name: 'ts-zodios-outbound' } as any,
                routing: { type: 'service', name: 'ts-zodios-outbound' } as any,
            },
            functionId: 'test:QuoteUseCase',
            functionHash: 'test-hash',
            constructorSource: undefined,
        } as unknown as AnalysisTask;

        // 6. Resolve Zodios calls deterministically (the function under test)
        resolvedCalls = resolveZodiosCallsForTask(
            minimalTask,
            quoteUseCaseImportMap,
            allFilePaths,
            zodiosIndex,
            zodiosTypeIndex,
        );
    });

    it('should load fixture manifest correctly', () => {
        expect(manifest.fixture).toBe('ts-zodios-outbound');
    });

    it('should collect the Zodios alias map from ExternalApi.repository.ts', async () => {
        // Re-run collection to verify zodiosIndex is built
        const allFiles = walkDir(SRC_DIR);
        const parsedFiles = allFiles
            .filter(f => f.endsWith('.ts'))
            .map(f => ({
                relativePath: path.relative(FIXTURE_DIR, f),
                fileContent: fs.readFileSync(f, 'utf-8'),
            }));
        const fileImportMaps: FileImportMap[] = parsedFiles.map(pf =>
            buildImportMap(path.join(FIXTURE_DIR, pf.relativePath), FIXTURE_DIR),
        );
        const allFilePaths = new Set(parsedFiles.map(pf => pf.relativePath));
        const { zodiosIndex } = collectZodiosAliasMaps(parsedFiles, fileImportMaps, allFilePaths);

        // At least one file with a zodios definition should be indexed
        expect(zodiosIndex.size).toBeGreaterThan(0);

        // The ExternalApi.repository.ts file should be in the index
        const repoFile = [...zodiosIndex.keys()].find(k => k.includes('ExternalApi.repository'));
        expect(repoFile, 'ExternalApi.repository.ts must be indexed as a Zodios file').toBeDefined();

        // The alias map must contain all three aliases
        const aliasMap = zodiosIndex.get(repoFile!)!;
        expect(aliasMap.has('getQuotes')).toBe(true);
        expect(aliasMap.has('createQuote')).toBe(true);
        expect(aliasMap.has('deleteQuote')).toBe(true);
    });

    it('should resolve GET /api/v1/quotes from .getQuotes() alias', () => {
        const getCall = resolvedCalls.find(c => c.alias === 'getQuotes');
        expect(getCall, 'getQuotes alias must be resolved').toBeDefined();
        expect(getCall!.method).toBe('GET');
        expect(getCall!.path).toBe('/api/v1/quotes');
    });

    it('should resolve POST /api/v1/quotes from .createQuote() alias', () => {
        const postCall = resolvedCalls.find(c => c.alias === 'createQuote');
        expect(postCall, 'createQuote alias must be resolved').toBeDefined();
        expect(postCall!.method).toBe('POST');
        expect(postCall!.path).toBe('/api/v1/quotes');
    });

    it('should NOT resolve .deleteQuote() (not called in QuoteUseCase)', () => {
        const deleteCall = resolvedCalls.find(c => c.alias === 'deleteQuote');
        expect(deleteCall, 'deleteQuote must NOT be resolved — it is not called in QuoteUseCase').toBeUndefined();
    });

    it('should return HTTP methods as uppercase', () => {
        for (const call of resolvedCalls) {
            expect(call.method).toBe(call.method.toUpperCase());
        }
    });

    it('should record the source type for traceability', () => {
        for (const call of resolvedCalls) {
            expect(call.sourceType).toBeTruthy();
        }
    });

    it('should score against manifest — wrapper names must NOT appear as APIEndpoints', () => {
        // Simulate what scoreAnalysis does: collect extracted API paths
        const extractedPaths = resolvedCalls.map(c => c.path);

        // Positive: expected API paths must be present
        expect(extractedPaths).toContain('/api/v1/quotes');

        // Negative: wrapper method names must NOT appear as paths
        const forbiddenApiNames = manifest.negative_nodes?.['APIEndpoint'] ?? [];
        for (const forbidden of forbiddenApiNames) {
            expect(
                extractedPaths,
                `Wrapper name "${forbidden}" must NOT appear as a resolved API path`,
            ).not.toContain(forbidden);
        }
    });

    it('should be fully deterministic (same output on repeated calls)', () => {
        // Re-running the resolver with the same inputs must return identical results
        const allFiles = walkDir(SRC_DIR);
        const parsedFiles = allFiles
            .filter(f => f.endsWith('.ts'))
            .map(f => ({
                relativePath: path.relative(FIXTURE_DIR, f),
                fileContent: fs.readFileSync(f, 'utf-8'),
            }));
        const fileImportMaps: FileImportMap[] = parsedFiles.map(pf =>
            buildImportMap(path.join(FIXTURE_DIR, pf.relativePath), FIXTURE_DIR),
        );
        const allFilePaths = new Set(parsedFiles.map(pf => pf.relativePath));
        const { zodiosIndex, zodiosTypeIndex } = collectZodiosAliasMaps(parsedFiles, fileImportMaps, allFilePaths);

        const quoteUseCasePath = 'src/usecases/QuoteUseCase.ts';
        const quoteUseCaseContent = fs.readFileSync(path.join(FIXTURE_DIR, quoteUseCasePath), 'utf-8');
        const quoteUseCaseImportMap = fileImportMaps.find(m => m.filePath === quoteUseCasePath)!;

        const task = {
            chunk: { name: 'QuoteUseCase', sourceCode: quoteUseCaseContent, filepath: quoteUseCasePath, language: 'typescript' as const, startLine: 1, endLine: quoteUseCaseContent.split('\n').length },
            fileContext: { relativePath: quoteUseCasePath, repo: { path: FIXTURE_DIR, name: 'ts-zodios-outbound' } as any, routing: { type: 'service', name: 'ts-zodios-outbound' } as any },
            functionId: 'test:QuoteUseCase',
            functionHash: 'test-hash',
            constructorSource: undefined,
        } as unknown as AnalysisTask;

        const secondRun = resolveZodiosCallsForTask(task, quoteUseCaseImportMap, allFilePaths, zodiosIndex, zodiosTypeIndex);

        // Sort both arrays for comparison
        const sort = (arr: ZodiosResolvedCall[]) =>
            [...arr].sort((a, b) => `${a.method}:${a.path}`.localeCompare(`${b.method}:${b.path}`));

        expect(sort(secondRun)).toEqual(sort(resolvedCalls));
    });
});
