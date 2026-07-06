/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-legacy-filesystem-routing
 *
 * Real-world case mirrored from a customer codebase: a legacy PHP app with a
 * `pages/` tree of filesystem-routed page scripts (no framework router). The
 * original extractor reduced the route path to the file BASENAME, so every
 * `add.php` in the repo collapsed into a single `GET /add.php` endpoint
 * (174 files → 62 basenames in the reporting repo) and form targets reading
 * `$_POST` were published as GET-only.
 *
 * Pins three guarantees of the fix:
 *   ✓ Route path is the FULL repo-relative path (no basename collisions),
 *     taken from `relativePath` — never from the machine-absolute filepath.
 *   ✓ Scripts reading $_POST/$_FILES expose POST in addition to GET.
 *   ✓ Framework-managed directories (src/, app/, vendor/…) stay excluded,
 *     including when the path is repo-relative (no leading slash).
 *   ✓ Route chunks carry framework 'legacy-php' through static infra
 *     extraction (emergent INBOUND call) so the mutation layer can stamp
 *     heuristic/medium grounding instead of ast/exact.
 *
 * The test runs deterministically — no LLM calls. It exercises the chain
 *   plugin.extractFunctions → legacy route chunks → extractStaticInfra
 * end-to-end across the fixture tree.
 *
 * Fixture: tests/eval/patterns/php-legacy-filesystem-routing/fixture/
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

interface PhpFile {
    relativePath: string;
    source: string;
    chunks: CodeChunk[];
    rootNode: ReturnType<ReturnType<PHPPlugin['createParser']>['parse']>['rootNode'];
}

const plugin = new PHPPlugin();

function loadPhpFiles(fixtureDir: string): PhpFile[] {
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
                    // Mirror the pipeline call exactly: filepath is machine-absolute,
                    // relativePath is repo-relative. Routes must come from the latter.
                    chunks: plugin.extractFunctions(tree, source, full, relativePath),
                    rootNode: tree.rootNode,
                });
            }
        }
    };
    walk(fixtureDir);
    return files;
}

function routeChunks(file: PhpFile): CodeChunk[] {
    return file.chunks.filter(c => c.name.endsWith('::__route_handler'));
}

describe('Pattern Eval — php-legacy-filesystem-routing', () => {
    let files: PhpFile[];

    beforeAll(() => {
        files = loadPhpFiles(FIXTURE_DIR);
    });

    it('loads the fixture tree', () => {
        expect(files.map(f => f.relativePath).sort()).toEqual([
            'pages/inventory/items/add.php',
            'pages/orders/save.php',
            'pages/shipping/slots/add.php',
            'src/Service/InventoryHelper.php',
        ]);
    });

    it('emits the full repo-relative path — two add.php files stay distinct endpoints', () => {
        const inventory = files.find(f => f.relativePath === 'pages/inventory/items/add.php')!;
        const shipping = files.find(f => f.relativePath === 'pages/shipping/slots/add.php')!;

        expect(routeChunks(inventory).map(c => c.name)).toEqual([
            'GET /pages/inventory/items/add.php::__route_handler',
        ]);
        expect(routeChunks(shipping).map(c => c.name)).toEqual([
            'GET /pages/shipping/slots/add.php::__route_handler',
        ]);
    });

    it('route path never embeds the machine-absolute fixture prefix', () => {
        for (const file of files) {
            for (const chunk of routeChunks(file)) {
                expect(chunk.name).not.toContain(FIXTURE_DIR);
            }
        }
    });

    it('a script reading $_POST exposes POST in addition to GET', () => {
        const save = files.find(f => f.relativePath === 'pages/orders/save.php')!;
        expect(routeChunks(save).map(c => c.name).sort()).toEqual([
            'GET /pages/orders/save.php::__route_handler',
            'POST /pages/orders/save.php::__route_handler',
        ]);
    });

    it('framework-managed src/ stays excluded on repo-relative paths', () => {
        const helper = files.find(f => f.relativePath === 'src/Service/InventoryHelper.php')!;
        expect(routeChunks(helper)).toEqual([]);
    });

    it('static infra extraction yields an INBOUND emergent call with framework legacy-php', () => {
        const save = files.find(f => f.relativePath === 'pages/orders/save.php')!;
        const postChunk = routeChunks(save).find(c => c.name.startsWith('POST '))!;

        const infra = plugin.extractStaticInfra(save.rootNode, postChunk);
        expect(infra).not.toBeNull();
        expect(infra!.emergent_api_calls).toEqual([{
            direction: 'INBOUND',
            method: 'POST',
            path: '/pages/orders/save.php',
            framework: 'legacy-php',
        }]);
        expect(infra!.capabilities).toContain('http-handler');
    });
});
