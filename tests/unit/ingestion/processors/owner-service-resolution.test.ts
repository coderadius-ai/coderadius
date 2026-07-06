import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveOwnerService } from '../../../../src/ingestion/processors/code-pipeline/file-discovery.js';
import type { DiscoveredService } from '../../../../src/ingestion/extractors/autodiscovery.js';

/**
 * Pure ownership resolution — no fs, no graph, deterministic.
 *
 * resolveOwnerService = longest-prefix match + a "sole runtime service of the
 * repo" fallback. The fallback is the writer-side counterpart of the Tier-3
 * `soleServiceUrns` guard in topology.ts: it rescues a single-service repo
 * whose Service is catalog-declared (Backstage/Cortex) with a root pointing at
 * the catalog-info.yaml directory instead of the code root, so the bare
 * prefix-match never reaches the source files. A genuine monorepo (≥2 runtime
 * services in the repo) must never attribute a loose file to an arbitrary one.
 */
describe('resolveOwnerService', () => {
    const REPO = path.join('/repos', 'acme-mono');

    const svc = (name: string, relRoot: string, isRuntimeService = true): DiscoveredService => ({
        name,
        path: path.join(REPO, relRoot),
        language: 'php',
        isRuntimeService,
    });

    it('returns the longest-prefix match when the file lives under a service root', () => {
        const roots = [svc('orders', 'apps/orders'), svc('payments', 'apps/payments')];
        const file = path.join(REPO, 'apps/orders/src/Handler.php');
        expect(resolveOwnerService(file, roots, REPO)?.name).toBe('orders');
    });

    it('FALLBACK: no prefix match + exactly one runtime service in the repo → that service (acme-monolith case)', () => {
        // The Backstage service root points at the catalog-info.yaml dir, not the
        // code root, so the .php files never prefix-match.
        const roots = [svc('acme-monolith', '.backstage')];
        const file = path.join(REPO, 'src/classes/DbDbal.php');
        expect(resolveOwnerService(file, roots, REPO)?.name).toBe('acme-monolith');
    });

    it('GUARD: no prefix match + multiple runtime services in the repo → null (monorepo safety)', () => {
        const roots = [svc('api', '.catalog/api'), svc('worker', '.catalog/worker')];
        const file = path.join(REPO, 'src/loose.php');
        expect(resolveOwnerService(file, roots, REPO)).toBeNull();
    });

    it('GUARD: no prefix match + zero runtime services → null', () => {
        const roots = [svc('shared', '.catalog/shared', /* isRuntimeService */ false)];
        const file = path.join(REPO, 'src/loose.php');
        expect(resolveOwnerService(file, roots, REPO)).toBeNull();
    });

    it('a real prefix match is never overridden by the fallback', () => {
        // One runtime service whose root DOES cover the file → direct match,
        // fallback path not taken (would return the same here, but the point is
        // direct wins deterministically).
        const roots = [svc('orders', 'apps/orders'), svc('other', '.backstage')];
        const file = path.join(REPO, 'apps/orders/src/X.php');
        expect(resolveOwnerService(file, roots, REPO)?.name).toBe('orders');
    });

    it('fallback ignores library workspaces; a sole runtime service alongside libraries still wins', () => {
        const roots = [
            svc('helper', 'libs/helper', /* isRuntimeService */ false),
            svc('app', '.backstage'),
        ];
        const file = path.join(REPO, 'src/Service.php');
        expect(resolveOwnerService(file, roots, REPO)?.name).toBe('app');
    });

    it('TIE: a catalog-declared runtime root wins over an autodiscovery non-runtime root at the SAME path (declared > heuristic)', () => {
        // Single-repo catalog-declared service whose code root IS the repo root
        // (e.g. composer.json + catalog-info.yaml both at the repo root). The
        // governance scan pushes BOTH the raw autodiscovery root (isRuntimeService
        // false — the language heuristic did not fire) AND the catalog-promoted
        // root (isRuntimeService true). They share the same path, so the prefix
        // lengths tie. The catalog (declared) root must win, otherwise the file
        // is mis-attributed to a :Library and the :Service stays an empty shell.
        const autoRoot = svc('repo', '.', /* isRuntimeService */ false);
        const catalogRoot = svc('repo', '.', /* isRuntimeService */ true);
        const file = path.join(REPO, 'src/Broker/Orchestrator.php');
        // Order-independent: runtime wins whether pushed before or after the auto root.
        expect(resolveOwnerService(file, [autoRoot, catalogRoot], REPO)?.isRuntimeService).toBe(true);
        expect(resolveOwnerService(file, [catalogRoot, autoRoot], REPO)?.isRuntimeService).toBe(true);
    });

    it('fallback only counts services of the FILE\'s repo, not other repos', () => {
        const OTHER = path.join('/repos', 'acme-other');
        const roots = [
            svc('acme-monolith', '.backstage'),
            { name: 'a', path: path.join(OTHER, 'apps/a'), language: 'ts', isRuntimeService: true },
            { name: 'b', path: path.join(OTHER, 'apps/b'), language: 'ts', isRuntimeService: true },
        ];
        const file = path.join(REPO, 'src/loose.php');
        // REPO still has exactly one runtime service; the other repo's two
        // services must not poison the count.
        expect(resolveOwnerService(file, roots, REPO)?.name).toBe('acme-monolith');
    });
});
