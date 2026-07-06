import { describe, it, expect } from 'vitest';
import { getMonorepoRouting } from '../../../../src/ingestion/processors/code-pipeline/file-discovery.js';

const REPO = 'acme/orders';

describe('getMonorepoRouting', () => {
    describe('apps/<name>/* → :Service', () => {
        it('routes files under apps/api/ to the api service', () => {
            expect(getMonorepoRouting('apps/api/src/Main.ts', REPO)).toEqual({
                type: 'service',
                name: 'api',
                urn: 'cr:service:acme/orders:api',
            });
        });
    });

    describe('packages/<name>/* → :Library', () => {
        it('routes files under packages/shared/ to the shared library', () => {
            expect(getMonorepoRouting('packages/shared/src/util.ts', REPO)).toEqual({
                type: 'library',
                name: 'shared',
                urn: 'cr:library:shared',
            });
        });
    });

    describe('libs/<name>/* → :Library (NestJS convention) [F1 fix]', () => {
        // REGRESSION GUARD (F1 from acme-platform ingestion analysis): the NestJS
        // monorepo convention uses `libs/<name>/` for shared workspaces.
        // Before F1 only `packages/<name>/` was recognised, so files under
        // `libs/helper/src/*.ts` were routed to the repo root and the
        // `:Library:helper` node ended up with zero CONTAINS Function edges
        // even after RC0 correctly classified helper as a Library.

        it('routes files under libs/helper/ to the helper library', () => {
            expect(getMonorepoRouting('libs/helper/src/CryptoHelper.ts', REPO)).toEqual({
                type: 'library',
                name: 'helper',
                urn: 'cr:library:helper',
            });
        });

        it('routes files under libs/product/ to the product library', () => {
            expect(getMonorepoRouting('libs/product/src/domain/Quote.ts', REPO)).toEqual({
                type: 'library',
                name: 'product',
                urn: 'cr:library:product',
            });
        });

        it('handles deeply nested files under libs/<name>/', () => {
            const routing = getMonorepoRouting('libs/helper/src/sub/dir/Foo.ts', REPO);
            expect(routing.type).toBe('library');
            expect(routing.name).toBe('helper');
        });
    });

    describe('fallback → :Repository', () => {
        it('routes root files to repository', () => {
            expect(getMonorepoRouting('README.md', REPO)).toEqual({
                type: 'repository',
                name: REPO,
                urn: `cr:repository:${REPO}`,
            });
        });

        it('routes src/ at root (polyrepo) to repository, not library', () => {
            expect(getMonorepoRouting('src/Main.ts', REPO)).toEqual({
                type: 'repository',
                name: REPO,
                urn: `cr:repository:${REPO}`,
            });
        });

        it('does NOT hijack a single segment under apps/ or libs/ (no name)', () => {
            // Defensive: `apps/` or `libs/` alone (no nested name) cannot
            // produce a sensible component identity.
            expect(getMonorepoRouting('apps/', REPO).type).toBe('repository');
            expect(getMonorepoRouting('libs/', REPO).type).toBe('repository');
        });
    });
});
