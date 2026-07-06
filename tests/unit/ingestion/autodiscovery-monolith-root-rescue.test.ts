import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverAutoComponents,
    matchesLocalPathDependency,
} from '../../../src/ingestion/extractors/autodiscovery';

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-monolith-rescue-'));
}

function write(repo: string, rel: string, content: string) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

describe('matchesLocalPathDependency', () => {
    it('matches exact relative paths', () => {
        expect(matchesLocalPathDependency(['contexts/orders'], 'contexts/orders')).toBe(true);
        expect(matchesLocalPathDependency(['contexts/orders'], 'contexts/shipping')).toBe(false);
    });

    it('matches single-segment globs without crossing slashes', () => {
        expect(matchesLocalPathDependency(['contexts/*'], 'contexts/orders')).toBe(true);
        expect(matchesLocalPathDependency(['contexts/*'], 'contexts/orders/nested')).toBe(false);
    });

    it('matches multi-segment ** globs', () => {
        expect(matchesLocalPathDependency(['contexts/**'], 'contexts/orders/nested')).toBe(true);
    });

    it('never matches on empty patterns', () => {
        expect(matchesLocalPathDependency([], 'contexts/orders')).toBe(false);
    });
});

describe('discoverAutoComponents — monolith root rescue', () => {
    let repo: string;

    beforeEach(() => { repo = makeRepo(); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('rescues a root manifest that vendors its children via path repositories', async () => {
        // Monolith-root shape: root composer.json path-requires the very child
        // workspaces whose manifests pruned it (child-wins).
        write(repo, 'composer.json', JSON.stringify({
            name: 'acme/inventory-app',
            require: { php: '>=8.1', 'acme/orders': '*' },
            repositories: [{ type: 'path', url: 'contexts/*' }],
            autoload: { 'psr-4': { 'App\\': 'src/' } },
        }));
        write(repo, 'public/index.php', '<?php require __DIR__ . "/../src/bootstrap.php";');
        write(repo, 'src/bootstrap.php', '<?php');
        write(repo, 'contexts/orders/composer.json', JSON.stringify({
            name: 'acme/orders',
            require: { php: '>=8.1' },
        }));
        write(repo, 'contexts/orders/src/Order.php', '<?php class Order {}');

        const { components, serviceRoots } = await discoverAutoComponents(
            [{ name: 'inventory-app', path: repo, org: 'acme' }],
            [],
        );

        const names = components.map(c => c.name).sort();
        expect(names).toContain('orders');
        // The root survives pruning: its manifest vendors contexts/orders.
        const root = components.find(c => c.catalogFile === repo);
        expect(root).toBeDefined();
        // public/index.php entrypoint fires the PHP runtime signal.
        expect(root!.type).toBe('service');
        const rootService = serviceRoots.find(s => s.path === repo);
        expect(rootService?.isRuntimeService).toBe(true);
    });

    it('does NOT rescue a root manifest without local path dependencies (monorepo intact)', async () => {
        // True monorepo shape: root manifest exists but does not vendor the
        // children. Child-wins pruning must keep dropping the root.
        write(repo, 'composer.json', JSON.stringify({
            name: 'acme/platform',
            require: { php: '>=8.1' },
        }));
        write(repo, 'public/index.php', '<?php');
        write(repo, 'apps/orders/composer.json', JSON.stringify({ name: 'acme/orders' }));
        write(repo, 'apps/shipping/composer.json', JSON.stringify({ name: 'acme/shipping' }));

        const { components } = await discoverAutoComponents(
            [{ name: 'platform', path: repo, org: 'acme' }],
            [],
        );

        expect(components.find(c => c.catalogFile === repo)).toBeUndefined();
        expect(components.map(c => c.name).sort()).toEqual(['orders', 'shipping']);
    });

    it('does NOT rescue when path dependencies cover no discovered component', async () => {
        // Path repo pointing at a dir with no manifest (plain vendored code):
        // no discovered child is covered, the root stays pruned.
        write(repo, 'composer.json', JSON.stringify({
            name: 'acme/platform',
            require: { php: '>=8.1' },
            repositories: [{ type: 'path', url: 'lib/legacy-helpers' }],
        }));
        write(repo, 'lib/legacy-helpers/helper.php', '<?php');
        write(repo, 'apps/orders/composer.json', JSON.stringify({ name: 'acme/orders' }));

        const { components } = await discoverAutoComponents(
            [{ name: 'platform', path: repo, org: 'acme' }],
            [],
        );

        expect(components.find(c => c.catalogFile === repo)).toBeUndefined();
    });
});
