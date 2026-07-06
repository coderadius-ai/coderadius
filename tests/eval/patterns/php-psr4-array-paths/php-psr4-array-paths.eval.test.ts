/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-psr4-array-paths
 *
 * Real-world case: a legacy PHP monolith declares a single PSR-4 prefix that
 * maps to MULTIPLE physical roots, which Composer supports natively:
 *
 *   "Acme\\": ["lib/Acme/", "src/Acme/"]
 *
 * The mapping loader cast the value to `string`, so the array reached
 * `path.posix.join(mapping.directory, ...)` verbatim and the whole ingestion
 * crashed with `The "paths[0]" property must be of type string, got array`.
 *
 * Three engine guarantees this test pins:
 *
 *   1. Array-valued PSR-4 entries expand into one DependencyMapping per
 *      directory (declaration order preserved) instead of crashing.
 *
 *   2. Namespace resolution probes ALL roots in order: a class whose file
 *      lives only under the SECOND root still resolves (first root probe
 *      misses, second hits).
 *
 *   3. Cross-root taint propagation: classes of the SAME namespace split
 *      across the two physical roots still see each other (explicit `use`
 *      and same-namespace bare type-hints), so I/O taint flows across roots.
 *
 * Deterministic — no LLM calls. Exercises mapping load → import extraction →
 * import graph → taint propagation on a multi-root PHP fixture.
 *
 * Fixture: tests/eval/patterns/php-psr4-array-paths/fixture/
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import {
    buildImportGraph,
    propagateTaints,
    buildSinkRegistry,
    type FileImportMap,
} from '../../../../src/ingestion/core/import-graph.js';
import type { DependencyMapping, ImportContext } from '../../../../src/ingestion/core/languages/types.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

function discoverPhpFiles(rootDir: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.posix.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.php')) files.push(full);
        }
    };
    walk(rootDir);
    return files;
}

describe('Pattern Eval — php-psr4-array-paths', () => {
    let dependencyMappings: DependencyMapping[];
    let fileImportMaps: FileImportMap[];
    const plugin = new PHPPlugin();
    const parser = plugin.createParser();

    beforeAll(() => {
        const allAbs = discoverPhpFiles(FIXTURE_DIR);
        const allRel = new Set(allAbs.map(f => path.posix.relative(FIXTURE_DIR, f)));
        dependencyMappings = plugin.loadDependencyMappings(FIXTURE_DIR);
        const ctx: ImportContext = {
            allFilePaths: allRel,
            dependencyMappings,
            allowAbsolute: false,
        };

        fileImportMaps = [];
        for (const absPath of allAbs) {
            const relPath = path.posix.relative(FIXTURE_DIR, absPath);
            const source = fs.readFileSync(absPath, 'utf-8');
            const tree = parser.parse(source);
            // Before the fix this call crashed: the array-valued mapping
            // reached path.posix.join inside resolvePhpNamespaceToPsr4.
            const imports = plugin.extractImports(tree.rootNode, ctx);
            const exportedSymbols = plugin.extractExports(tree.rootNode);
            const implementsFiles = plugin.extractImplementsFiles?.(tree.rootNode, ctx) ?? [];
            fileImportMaps.push({ filePath: relPath, imports, exportedSymbols, implementsFiles });
        }
    });

    it('expands the array-valued PSR-4 prefix into one mapping per root, in declaration order', () => {
        const acmeRoots = dependencyMappings
            .filter(m => m.prefix === 'Acme\\')
            .map(m => m.directory);
        expect(acmeRoots).toEqual(['lib/Acme/', 'src/Acme/']);
    });

    it('discovers the three fixture files across both roots', () => {
        const paths = fileImportMaps.map(fm => fm.filePath).sort();
        expect(paths).toEqual([
            'lib/Acme/Inventory/LegacyStockClient.php',
            'src/Acme/Inventory/StockAuditLog.php',
            'src/Acme/Orders/OrdersService.php',
        ]);
    });

    it('resolves an explicit `use` into the FIRST root', () => {
        // OrdersService (src/ root) imports Acme\Inventory\LegacyStockClient,
        // whose file exists only under lib/Acme/ (first array entry).
        const serviceFile = fileImportMaps.find(fm => fm.filePath.endsWith('OrdersService.php'))!;
        const localImports = serviceFile.imports.filter(i => !i.isExternal).map(i => i.source);
        expect(localImports).toContain('lib/Acme/Inventory/LegacyStockClient.php');
    });

    it('resolves a same-namespace bare type-hint into the SECOND root', () => {
        // LegacyStockClient (lib/ root) type-hints StockAuditLog with no `use`
        // statement: same namespace Acme\Inventory, but the file physically
        // lives under src/Acme/ (second array entry). The first-root probe
        // (lib/Acme/Inventory/StockAuditLog.php) misses; the second must hit.
        const clientFile = fileImportMaps.find(fm => fm.filePath.endsWith('LegacyStockClient.php'))!;
        const localImports = clientFile.imports.filter(i => !i.isExternal).map(i => i.source);
        expect(localImports).toContain('src/Acme/Inventory/StockAuditLog.php');
    });

    it('propagates taint across physical roots', () => {
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const graph = buildImportGraph(fileImportMaps);
        const taint = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);

        // Patient Zero: PSR-18 import seeds the client in the lib/ root.
        expect(taint.get('lib/Acme/Inventory/LegacyStockClient.php')?.taintedSymbols.has('LegacyStockClient')).toBe(true);
        // Contagion crosses the root boundary via the explicit use import.
        expect(taint.get('src/Acme/Orders/OrdersService.php')?.taintedSymbols.has('OrdersService')).toBe(true);
    });

    it('does NOT taint the I/O-free audit log (negative control)', () => {
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const graph = buildImportGraph(fileImportMaps);
        const taint = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);

        // StockAuditLog imports nothing and performs no I/O: cross-root
        // resolution must not fabricate taint for it.
        expect(taint.get('src/Acme/Inventory/StockAuditLog.php')?.taintedSymbols.has('StockAuditLog') ?? false).toBe(false);
    });
});
