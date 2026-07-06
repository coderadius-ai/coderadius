/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-graphql-same-namespace
 *
 * Real-world case mirrored from a customer codebase: a PHP service that wraps
 * a remote GraphQL provider in a thin `*GqlClient` class. The wrapper and the
 * adapter that calls it live in the SAME PHP namespace, so the adapter has no
 * `use` statement for the wrapper — the property is typed with the bare class
 * name (`private InventoryGqlClient $client`).
 *
 * This pattern broke the original (text-based) static-supplements matcher,
 * which required a `use` statement or an FQCN-verbatim appearance. The fix
 * resolves the receiver via the file's namespace + use-aliases + per-class
 * property type-hints. See `src/ingestion/core/languages/php/static-supplements.ts`.
 *
 * The test runs deterministically — no LLM calls. It exercises the chain
 *   coderadius.yaml → registry → static-supplements → ClientBinding
 * end-to-end across two PHP files in a fixture directory.
 *
 * Fixture: tests/eval/patterns/php-graphql-same-namespace/fixture/
 * Manifest: tests/eval/patterns/php-graphql-same-namespace/expected.graph.yaml
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { extractPhpStaticSupplements } from '../../../../src/ingestion/core/languages/php/static-supplements.js';
import {
    clearGraphQLClientDecorators,
    registerGraphQLClientDecorator,
} from '../../../../src/ingestion/core/graphql-client-registry.js';
import { loadRepoHints, clearRepoHintsCache } from '../../../../src/config/repo-hints.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import type { ClientBinding } from '../../../../src/ingestion/core/types.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

interface PhpFile {
    relativePath: string;
    source: string;
    chunks: CodeChunk[];
    rootNode: ReturnType<ReturnType<PHPPlugin['createParser']>['parse']>['rootNode'];
}

function loadPhpFiles(fixtureDir: string): PhpFile[] {
    const plugin = new PHPPlugin();
    const parser = plugin.createParser();
    const files: PhpFile[] = [];

    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.php')) {
                const source = fs.readFileSync(full, 'utf-8');
                const tree = parser.parse(source);
                const relativePath = path.relative(fixtureDir, full);
                files.push({
                    relativePath,
                    source,
                    chunks: plugin.extractFunctions(tree, source, relativePath),
                    rootNode: tree.rootNode,
                });
            }
        }
    };
    walk(fixtureDir);
    return files;
}

describe('Pattern Eval — php-graphql-same-namespace', () => {
    let files: PhpFile[];

    beforeAll(() => {
        files = loadPhpFiles(FIXTURE_DIR);
    });

    beforeEach(() => {
        clearGraphQLClientDecorators();
        clearRepoHintsCache();
    });
    afterEach(() => {
        clearGraphQLClientDecorators();
        clearRepoHintsCache();
    });

    it('loads the fixture and parses both PHP files', () => {
        expect(files.length).toBe(2);
        const adapter = files.find(f => f.relativePath.endsWith('InventoryAdapter.php'));
        const wrapper = files.find(f => f.relativePath.endsWith('InventoryGqlClient.php'));
        expect(adapter).toBeDefined();
        expect(wrapper).toBeDefined();
        expect(adapter!.chunks.find(c => c.name.endsWith('.createOrder'))).toBeDefined();
        expect(adapter!.chunks.find(c => c.name.endsWith('.cancelOrder'))).toBeDefined();
    });

    it('coderadius.yaml registers the graphql-client decorator', () => {
        const hints = loadRepoHints(FIXTURE_DIR);
        expect(hints.decorators).toHaveLength(1);
        expect(hints.decorators[0]).toMatchObject({
            name: 'Acme\\Inventory\\InventoryGqlClient::post',
            kind: 'graphql-client',
            args: ['query', 'variables'],
        });
    });

    it('does NOT emit ClientBindings without the decorator registered (regression baseline)', () => {
        const adapter = files.find(f => f.relativePath.endsWith('InventoryAdapter.php'))!;
        for (const chunk of adapter.chunks) {
            const result = extractPhpStaticSupplements(adapter.rootNode, adapter.source, adapter.relativePath, chunk);
            expect(result).toBeNull();
        }
    });

    it('emits a ClientBinding for every adapter call-site once the decorator is registered', () => {
        // Wire the decorator from coderadius.yaml exactly as the workflow does.
        const hints = loadRepoHints(FIXTURE_DIR);
        for (const dec of hints.decorators) {
            if (dec.kind === 'graphql-client') {
                registerGraphQLClientDecorator(dec.name, dec.args);
            }
        }

        const adapter = files.find(f => f.relativePath.endsWith('InventoryAdapter.php'))!;

        // Both adapter methods that wrap a `->post(...)` call must emit one binding each.
        const callSites = ['createOrder', 'cancelOrder'];
        const collected: Record<string, ClientBinding[]> = {};
        for (const methodName of callSites) {
            const chunk = adapter.chunks.find(c => c.name.endsWith(`.${methodName}`));
            expect(chunk, `chunk for ${methodName} must exist`).toBeDefined();
            const result = extractPhpStaticSupplements(adapter.rootNode, adapter.source, adapter.relativePath, chunk!);
            expect(result, `static-supplements must fire for ${methodName}`).not.toBeNull();
            expect(result!.clientBindings).toHaveLength(1);
            collected[methodName] = result!.clientBindings!;
        }

        // All bindings point at the same FQCN with deterministic shape.
        for (const [name, bindings] of Object.entries(collected)) {
            expect(bindings[0], `binding ${name}`).toMatchObject({
                token: 'Acme\\Inventory\\InventoryGqlClient',
                clientKind: 'sdk',
                protocol: 'graphql',
                evidence: 'coderadius.yaml:graphql-client',
                typeName: 'Acme\\Inventory\\InventoryGqlClient',
            });
        }
    });

    it('does NOT emit a binding for the wrapper class implementation itself', () => {
        const hints = loadRepoHints(FIXTURE_DIR);
        for (const dec of hints.decorators) {
            if (dec.kind === 'graphql-client') {
                registerGraphQLClientDecorator(dec.name, dec.args);
            }
        }

        const wrapper = files.find(f => f.relativePath.endsWith('InventoryGqlClient.php'))!;
        for (const chunk of wrapper.chunks) {
            const result = extractPhpStaticSupplements(wrapper.rootNode, wrapper.source, wrapper.relativePath, chunk);
            // The wrapper's own method bodies don't contain a `->post(` call, so
            // no binding is emitted (no false positives from the receiver-type
            // heuristic).
            expect(result, `wrapper chunk ${chunk.name} should not emit a binding`).toBeNull();
        }
    });
});
