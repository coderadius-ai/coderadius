import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferLanguage } from '../../../src/ingestion/extractors/autodiscovery';

/**
 * Builds a temporary repo skeleton on disk and returns its absolute path.
 * The caller adds files via `touch(repo, 'apps/api/package.json')`.
 */
function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-langinfer-'));
}

function touch(repo: string, rel: string) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
}

describe('inferLanguage — tsconfig promotion (Strategy A)', () => {
    let repo: string;

    beforeEach(() => { repo = makeRepo(); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('package.json alone → javascript (unchanged behaviour)', () => {
        touch(repo, 'apps/legacy-js/package.json');
        const dir = path.join(repo, 'apps/legacy-js');
        expect(inferLanguage(['package.json'], dir, repo)).toBe('javascript');
    });

    it('package.json + sibling tsconfig.json → promoted to typescript', () => {
        // Mirrors core-service/apps/api: per-app tsconfig next to package.json.
        touch(repo, 'apps/api/package.json');
        touch(repo, 'apps/api/tsconfig.json');
        const dir = path.join(repo, 'apps/api');
        expect(inferLanguage(['package.json'], dir, repo)).toBe('typescript');
    });

    it('package.json with tsconfig.json 1 hop up (monorepo workspace) → typescript', () => {
        // Workspaces pattern: tsconfig at apps/, package.json at apps/orders.
        touch(repo, 'apps/orders/package.json');
        touch(repo, 'apps/tsconfig.json');
        const dir = path.join(repo, 'apps/orders');
        expect(inferLanguage(['package.json'], dir, repo)).toBe('typescript');
    });

    it('package.json with tsconfig.json at repo root (2 hops up) → typescript', () => {
        // Most common monorepo: shared tsconfig.json at repo root.
        touch(repo, 'apps/api/package.json');
        touch(repo, 'tsconfig.json');
        const dir = path.join(repo, 'apps/api');
        expect(inferLanguage(['package.json'], dir, repo)).toBe('typescript');
    });

    it('tsconfig.json beyond 2 ancestors (3+ hops up) → stays javascript', () => {
        // Cap the walk: 3 ancestors out is suspicious — likely the tsconfig
        // belongs to a different concern (e.g. a parent monorepo).
        touch(repo, 'apps/a/b/c/package.json');
        touch(repo, 'tsconfig.json'); // 3 hops up from apps/a/b/c
        const dir = path.join(repo, 'apps/a/b/c');
        expect(inferLanguage(['package.json'], dir, repo)).toBe('javascript');
    });

    it('walk never crosses the repo boundary', () => {
        // A tsconfig.json in the OS tmpdir (above the repo) must not be picked up.
        const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-outsider-'));
        try {
            touch(outsider, 'tsconfig.json');
            const innerRepo = fs.mkdtempSync(path.join(outsider, 'repo-'));
            touch(innerRepo, 'apps/api/package.json');
            const dir = path.join(innerRepo, 'apps/api');
            expect(inferLanguage(['package.json'], dir, innerRepo)).toBe('javascript');
        } finally {
            fs.rmSync(outsider, { recursive: true, force: true });
        }
    });

    it('php/composer.json is not affected by the promotion', () => {
        touch(repo, 'apps/orders/composer.json');
        touch(repo, 'tsconfig.json'); // a stray tsconfig from another plugin must not flip PHP
        const dir = path.join(repo, 'apps/orders');
        expect(inferLanguage(['composer.json'], dir, repo)).toBe('php');
    });

    it('Dockerfile only → unknown, no promotion', () => {
        touch(repo, 'apps/svc/Dockerfile');
        touch(repo, 'tsconfig.json');
        const dir = path.join(repo, 'apps/svc');
        expect(inferLanguage(['Dockerfile'], dir, repo)).toBe('unknown');
    });

    it('no manifest at all → unknown', () => {
        const dir = path.join(repo, 'apps/empty');
        fs.mkdirSync(dir, { recursive: true });
        expect(inferLanguage([], dir, repo)).toBe('unknown');
    });

    it('repoPath === serviceDir → only local check, no walk needed', () => {
        // Edge case: a single-service "repo" rooted at the service dir itself.
        touch(repo, 'package.json');
        touch(repo, 'tsconfig.json');
        expect(inferLanguage(['package.json'], repo, repo)).toBe('typescript');
    });
});
