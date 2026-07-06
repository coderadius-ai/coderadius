/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-psr18-taint-propagation
 *
 * Real-world case: a PHP service uses an HTTP wrapper class that imports
 * only PSR-18 (`Psr\Http\Client\ClientInterface`) — the de-facto PHP HTTP
 * standard. The wrapper, its interface, the service that calls it, and the
 * top-level adapter all live in the SAME namespace, so dependencies are
 * declared only via constructor type-hints (no `use` statements between
 * them, no FQCNs in code).
 *
 * Three engine guarantees this test pins:
 *
 *   1. PSR-18 sink recognition: importing `Psr\Http\Client\ClientInterface`
 *      seeds Patient Zero (was previously missing — only Guzzle and
 *      Symfony HttpClient were registered).
 *
 *   2. Same-namespace implicit imports: when class A depends on bare type
 *      hint B in the same namespace, the engine must emit an implicit
 *      local import to B's PSR-4 file (extractPhpSameNamespaceImplicitImports).
 *
 *   3. Class-hierarchy back-propagation: when an HTTP wrapper implements
 *      an interface, the interface inherits the I/O taint contract.
 *      Without this, code consuming the interface via DI would never be
 *      tainted (the common dependency-injection pattern).
 *
 * Deterministic — no LLM calls. Exercises the pure taint engine end-to-end
 * on a multi-file PHP fixture.
 *
 * Fixture: tests/eval/patterns/php-psr18-taint-propagation/fixture/
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { extractPhpStaticSupplements } from '../../../../src/ingestion/core/languages/php/static-supplements.js';
import {
    buildImportGraph,
    propagateTaints,
    buildSinkRegistry,
    type ClassPropertyAlias,
    type FileImportMap,
} from '../../../../src/ingestion/core/import-graph.js';
import type { ImportContext } from '../../../../src/ingestion/core/languages/types.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

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

describe('Pattern Eval — php-psr18-taint-propagation', () => {
    let fileImportMaps: FileImportMap[];
    let classPropertyAliases: Map<string, ClassPropertyAlias[]>;
    let orderClientChunkSource: string;
    const plugin = new PHPPlugin();
    const parser = plugin.createParser();

    beforeAll(() => {
        const allAbs = discoverPhpFiles(FIXTURE_DIR);
        const allRel = new Set(allAbs.map(f => path.posix.relative(FIXTURE_DIR, f)));
        const dependencyMappings = plugin.loadDependencyMappings(FIXTURE_DIR);
        const ctx: ImportContext = {
            allFilePaths: allRel,
            dependencyMappings,
            allowAbsolute: false,
        };

        fileImportMaps = [];
        classPropertyAliases = new Map();
        for (const absPath of allAbs) {
            const relPath = path.posix.relative(FIXTURE_DIR, absPath);
            const source = fs.readFileSync(absPath, 'utf-8');
            const tree = parser.parse(source);
            const imports = plugin.extractImports(tree.rootNode, ctx);
            const exportedSymbols = plugin.extractExports(tree.rootNode);
            const implementsFiles = plugin.extractImplementsFiles?.(tree.rootNode, ctx) ?? [];
            const aliases = plugin.extractClassPropertyAliases(tree.rootNode);
            fileImportMaps.push({ filePath: relPath, imports, exportedSymbols, implementsFiles });
            if (aliases.length > 0) classPropertyAliases.set(relPath, aliases);
            if (relPath.endsWith('OrdersClient.php')) orderClientChunkSource = source;
        }
    });

    it('discovers the four fixture files', () => {
        const paths = fileImportMaps.map(fm => fm.filePath).sort();
        expect(paths).toEqual([
            'src/Inventory/OrdersAdapter.php',
            'src/Inventory/OrdersClient.php',
            'src/Inventory/OrdersClientInterface.php',
            'src/Inventory/OrdersService.php',
        ]);
    });

    it('exports interfaces alongside classes (extractPhpExports)', () => {
        const interfaceFile = fileImportMaps.find(fm => fm.filePath.endsWith('OrdersClientInterface.php'))!;
        expect(interfaceFile.exportedSymbols).toContain('OrdersClientInterface');
    });

    it('emits same-namespace implicit imports for bare type-hints', () => {
        // OrdersService has `private OrdersClientInterface $client` (no use statement).
        // The engine must materialise this as an implicit local import.
        const serviceFile = fileImportMaps.find(fm => fm.filePath.endsWith('OrdersService.php'))!;
        const localImports = serviceFile.imports
            .filter(i => !i.isExternal)
            .map(i => i.source);
        expect(localImports).toContain('src/Inventory/OrdersClientInterface.php');
    });

    it('records implements relationship for back-propagation', () => {
        // OrdersClient implements OrdersClientInterface.
        // The interface's file path must appear in implementsFiles.
        const clientFile = fileImportMaps.find(fm => fm.filePath.endsWith('OrdersClient.php'))!;
        expect(clientFile.implementsFiles).toContain('src/Inventory/OrdersClientInterface.php');
    });

    it('extracts class property aliases for legacy PHP (untyped property + typed ctor param)', () => {
        // OrdersService uses the legacy pattern:
        //   private $client;                                    // untyped property
        //   public function __construct(OrdersClientInterface $client) { $this->client = $client; }
        // The plugin must recognise the constructor body's `$this->X = $Y`
        // assignment to bind the property to its parameter type. Without
        // this, the heuristic-filter Gate 3 (DI alias) cannot match
        // `$this->client->callQuotationMethod(...)` against a tainted type.
        const aliases = plugin.extractClassPropertyAliases(
            parser.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'src/Inventory/OrdersService.php'), 'utf-8')).rootNode,
        );
        expect(aliases).toContainEqual({
            propertyAccess: 'this->client',
            typeName: 'OrdersClientInterface',
        });
    });

    it('seeds OrdersClient as Patient Zero (PSR-18 import)', () => {
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const graph = buildImportGraph(fileImportMaps);
        const taint = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);
        expect(taint.get('src/Inventory/OrdersClient.php')?.taintedSymbols.has('OrdersClient')).toBe(true);
    });

    it('back-propagates taint to the implemented interface', () => {
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const graph = buildImportGraph(fileImportMaps);
        const taint = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);
        // OrdersClientInterface has NO PSR-18 import and is NOT depended on by
        // any tainted file forward — only OrdersClient implements it. Without
        // back-propagation, the interface remains untainted forever.
        expect(taint.get('src/Inventory/OrdersClientInterface.php')?.taintedSymbols.has('OrdersClientInterface')).toBe(true);
    });

    it('forward-propagates taint through the wrapper chain', () => {
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const graph = buildImportGraph(fileImportMaps);
        const taint = propagateTaints(fileImportMaps, new Map(), [], graph, sinkRegistry);

        // OrdersService imports OrdersClientInterface (now tainted via back-prop).
        // Its own export OrdersService inherits taint via the contagion fix.
        expect(taint.get('src/Inventory/OrdersService.php')?.taintedSymbols.has('OrdersService')).toBe(true);

        // OrdersAdapter imports OrdersService (now tainted).
        // Same contagion: OrdersAdapter export must be tainted.
        expect(taint.get('src/Inventory/OrdersAdapter.php')?.taintedSymbols.has('OrdersAdapter')).toBe(true);
    });

    it('emits PSR-18 ClientBinding from the PHP plugin (sendRequest on ClientInterface)', () => {
        // The PHP plugin must recognise the PSR-18 method-call pattern
        // (`$this->client->sendRequest($req)` where `$this->client` is typed
        // against `Psr\Http\Client\ClientInterface`) as a deterministic
        // HTTP client signal. This emits a ClientBinding that the
        // static-analyzer-task-builder uses as a Gate 6 (Supplemental) rescue.
        //
        // Without this, the wrapper method that ACTUALLY performs the HTTP I/O
        // (e.g. `OrdersClient.callQuotationMethod`) fails all heuristic-filter
        // gates because PSR-18 interfaces live in vendor code we never parse,
        // so the type symbol `ClientInterface` never appears in any local
        // file's tainted-symbol set.
        const fullSource = orderClientChunkSource;
        const tree = parser.parse(fullSource);

        // The body of `callQuotationMethod` starts at the line of the
        // `public function` declaration inside `class OrdersClient { ... }`.
        const lines = fullSource.split('\n');
        const declLineIdx = lines.findIndex(l => l.includes('public function callQuotationMethod'));
        const declLine = lines[declLineIdx];
        const startColumn = declLine.indexOf('public');
        const chunk: CodeChunk = {
            name: 'Acme\\Inventory\\OrdersClient.callQuotationMethod',
            sourceCode: lines.slice(declLineIdx, declLineIdx + 7).join('\n'),
            filepath: 'src/Inventory/OrdersClient.php',
            language: 'php',
            startLine: declLineIdx + 1,
            startColumn: startColumn + 1,
            endLine: declLineIdx + 7,
            endColumn: 1,
        };

        const result = extractPhpStaticSupplements(
            tree.rootNode,
            fullSource,
            'src/Inventory/OrdersClient.php',
            chunk,
        );
        expect(result?.clientBindings).toBeDefined();
        const bindings = result!.clientBindings!;
        // The wrapper method invokes both `RequestFactoryInterface::createRequest`
        // and `ClientInterface::sendRequest`. Both PSR-18 patterns must surface.
        const tokens = bindings.map(b => b.token).sort();
        expect(tokens).toContain('Psr\\Http\\Client\\ClientInterface');
        expect(tokens).toContain('Psr\\Http\\Message\\RequestFactoryInterface');
        // Evidence string distinguishes PSR-18 AST detection from decorator-based.
        expect(bindings.every(b => b.evidence === 'psr18-ast')).toBe(true);
        expect(bindings.every(b => b.protocol === 'http')).toBe(true);
    });

    it('does NOT emit PSR-18 ClientBinding for the pure-delegation adapter', () => {
        // OrdersService.quotation just calls `$this->client->callQuotationMethod(...)`.
        // No PSR-18 method (sendRequest / createRequest) is invoked here —
        // the receiver type is the LOCAL interface OrdersClientInterface, not
        // a PSR-18 type. The plugin must NOT emit a PSR-18 ClientBinding here.
        const servicePath = path.join(FIXTURE_DIR, 'src/Inventory/OrdersService.php');
        const serviceSource = fs.readFileSync(servicePath, 'utf-8');
        const tree = parser.parse(serviceSource);
        const lines = serviceSource.split('\n');
        const declLineIdx = lines.findIndex(l => l.includes('public function quotation'));
        const declLine = lines[declLineIdx];
        const startColumn = declLine.indexOf('public');
        const chunk: CodeChunk = {
            name: 'Acme\\Inventory\\OrdersService.quotation',
            sourceCode: lines.slice(declLineIdx, declLineIdx + 10).join('\n'),
            filepath: 'src/Inventory/OrdersService.php',
            language: 'php',
            startLine: declLineIdx + 1,
            startColumn: startColumn + 1,
            endLine: declLineIdx + 10,
            endColumn: 1,
        };

        const result = extractPhpStaticSupplements(
            tree.rootNode,
            serviceSource,
            'src/Inventory/OrdersService.php',
            chunk,
        );
        // No coderadius.yaml decorators in this fixture, no PSR-18 call here.
        const psr18Bindings = (result?.clientBindings ?? []).filter(b => b.evidence === 'psr18-ast');
        expect(psr18Bindings).toEqual([]);
    });

    it('does NOT taint files outside the wrapper chain (negative control)', () => {
        // Add a fictional unrelated file to the maps to ensure taint does not
        // leak into files that have no path back to a sink.
        const sinkRegistry = buildSinkRegistry(FIXTURE_DIR);
        const extraMaps: FileImportMap[] = [
            ...fileImportMaps,
            {
                filePath: 'src/Inventory/UnrelatedHelper.php',
                imports: [],
                exportedSymbols: ['UnrelatedHelper'],
                implementsFiles: [],
            },
        ];
        const graph = buildImportGraph(extraMaps);
        const taint = propagateTaints(extraMaps, new Map(), [], graph, sinkRegistry);
        expect(taint.get('src/Inventory/UnrelatedHelper.php')?.taintedSymbols.has('UnrelatedHelper') ?? false).toBe(false);
    });
});
