/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-zodios-mapped
 *
 * Reproduces the bug where Zodios clients accessed through a
 * Pick<typeof api, ...> mapped type are invisible to the static analyzer.
 *
 * Architecture under test:
 *   zodios-context-builder → collectZodiosAliasMaps() → zodiosTypeIndex
 *
 * Root cause:
 *   Pass 2 in collectZodiosAliasMaps uses this regex:
 *     /export\s+type\s+(\w+)\s*=\s*typeof\s+(\w+)/g
 *   which only matches:
 *     export type IFoo = typeof api
 *   and misses:
 *     export type IFoo = Pick<typeof api, 'a' | 'b'>
 *
 * Expected (after fix):
 *   ✓ zodiosTypeIndex contains 'IPlacesApiRepository' → PlacesApi.repository.ts
 *   ✓ GET /places is resolved from .findPlaces() alias
 *   ✓ GET /places/:placeId is resolved from .getPlace() alias
 *   ✓ GET /birthplaces is resolved from .findBirthplaces() alias
 *
 * Before fix (RED state):
 *   ✗ zodiosTypeIndex does NOT contain 'IPlacesApiRepository'
 *   ✗ No resolved calls produced (empty array)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
    collectZodiosAliasMaps,
    resolveZodiosCallsForTask,
    type ZodiosResolvedCall,
    type ZodiosTypeIndex,
} from '../../../../src/ingestion/processors/code-pipeline/zodios-context-builder.js';
import type { AnalysisTask } from '../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FileImportMap } from '../../../../src/ingestion/core/import-graph.js';
import { loadFixtureManifest } from '../../helpers/pattern-eval.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const SRC_DIR = path.join(FIXTURE_DIR, 'src');

// ─── Helpers (shared with ts-zodios-outbound) ─────────────────────────────────

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

function buildImportMap(absolutePath: string): FileImportMap {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const relativePath = path.relative(FIXTURE_DIR, absolutePath);
    const imports: FileImportMap['imports'] = [];

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

    return { filePath: relativePath, imports };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Pattern Eval — ts-zodios-mapped (Pick<typeof api> type resolution)', () => {
    let manifest: ReturnType<typeof loadFixtureManifest>;
    let zodiosTypeIndex: ZodiosTypeIndex;
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

        // 2. Build import maps
        const fileImportMaps: FileImportMap[] = parsedFiles.map(pf =>
            buildImportMap(path.join(FIXTURE_DIR, pf.relativePath)),
        );

        // 3. All file paths for import resolution
        const allFilePaths = new Set(parsedFiles.map(pf => pf.relativePath));

        // 4. Build the Zodios index (function under test)
        const result = collectZodiosAliasMaps(parsedFiles, fileImportMaps, allFilePaths);
        zodiosTypeIndex = result.zodiosTypeIndex;

        // 5. Build minimal AnalysisTask for the consumer (PlacesService.ts)
        const servicePath = 'src/usecases/PlacesService.ts';
        const serviceContent = fs.readFileSync(path.join(FIXTURE_DIR, servicePath), 'utf-8');
        const serviceImportMap = fileImportMaps.find(m => m.filePath === servicePath)!;

        const minimalTask = {
            chunk: {
                name: 'PlacesService',
                sourceCode: serviceContent,
                filepath: servicePath,
                language: 'typescript' as const,
                startLine: 1,
                endLine: serviceContent.split('\n').length,
            },
            fileContext: {
                relativePath: servicePath,
                repo: { path: FIXTURE_DIR, name: 'ts-zodios-mapped' } as any,
                routing: { type: 'service', name: 'ts-zodios-mapped' } as any,
            },
            functionId: 'test:PlacesService',
            functionHash: 'test-hash',
            constructorSource: undefined,
        } as unknown as AnalysisTask;

        // 6. Resolve Zodios calls (function under test)
        resolvedCalls = resolveZodiosCallsForTask(
            minimalTask,
            serviceImportMap,
            allFilePaths,
            result.zodiosIndex,
            zodiosTypeIndex,
        );
    });

    it('should load fixture manifest correctly', () => {
        expect(manifest.fixture).toBe('ts-zodios-mapped');
    });

    it('should index IPlacesApiRepository from Pick<typeof api, ...> [BUG REPRODUCTION]', () => {
        // This is the core assertion that demonstrates the bug.
        // Before fix: zodiosTypeIndex.has('IPlacesApiRepository') === false
        // After fix:  zodiosTypeIndex.has('IPlacesApiRepository') === true
        expect(
            zodiosTypeIndex.has('IPlacesApiRepository'),
            'IPlacesApiRepository (Pick<typeof api, ...>) must be indexed in zodiosTypeIndex. ' +
            'The regex in zodios-context-builder.ts Pass 2 must handle Pick<typeof x, ...> and Omit<typeof x, ...>.',
        ).toBe(true);
    });

    it('should produce non-empty resolved calls for PlacesService', () => {
        expect(
            resolvedCalls.length,
            'resolveZodiosCallsForTask must return at least one call. ' +
            'With Pick<typeof api, ...> unresolved, the type index is empty and no calls are returned.',
        ).toBeGreaterThan(0);
    });

    it('should resolve GET /places from .findPlaces() alias', () => {
        const call = resolvedCalls.find(c => c.alias === 'findPlaces');
        expect(call, 'findPlaces alias must be resolved').toBeDefined();
        expect(call!.method).toBe('GET');
        expect(call!.path).toBe('/places');
    });

    it('should resolve GET /places/:placeId from .getPlace() alias', () => {
        const call = resolvedCalls.find(c => c.alias === 'getPlace');
        expect(call, 'getPlace alias must be resolved').toBeDefined();
        expect(call!.method).toBe('GET');
        expect(call!.path).toBe('/places/:placeId');
    });

    it('should resolve GET /birthplaces from .findBirthplaces() alias', () => {
        const call = resolvedCalls.find(c => c.alias === 'findBirthplaces');
        expect(call, 'findBirthplaces alias must be resolved').toBeDefined();
        expect(call!.method).toBe('GET');
        expect(call!.path).toBe('/birthplaces');
    });

    it('should return HTTP methods as uppercase', () => {
        for (const call of resolvedCalls) {
            expect(call.method).toBe(call.method.toUpperCase());
        }
    });

    it('should NOT produce wrapper method names as API paths [negative]', () => {
        const paths = resolvedCalls.map(c => c.path);
        const forbiddenPaths = manifest.negative_nodes?.['APIEndpoint'] ?? [];
        for (const forbidden of forbiddenPaths) {
            expect(paths, `"${forbidden}" must NOT appear as a resolved path`).not.toContain(forbidden);
        }
    });

    it('should score against manifest — all expected endpoints resolved', () => {
        const paths = resolvedCalls.map(c => c.path);
        const expectedEndpoints = manifest.expected_nodes['APIEndpoint'] ?? [];
        for (const expected of expectedEndpoints) {
            const found = paths.some(p => p === expected || p.includes(expected.replace(/^\/.+/, '')));
            expect(found, `Expected endpoint "${expected}" not found in resolved calls: ${JSON.stringify(paths)}`).toBe(true);
        }
    });
});
