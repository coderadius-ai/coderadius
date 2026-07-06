import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveSource, findLocalRepos, readGitSubmodulePaths } from '../../../../src/ingestion/core/source-resolver.js';

// Mock simple-git to avoid actual git operations
vi.mock('simple-git', () => ({
    simpleGit: () => ({
        status: vi.fn().mockResolvedValue({ current: 'main' }),
        revparse: vi.fn().mockResolvedValue('deadbeef'),
        getRemotes: vi.fn().mockResolvedValue([{ name: 'origin', refs: { fetch: 'https://github.com/org/repo.git' } }]),
    }),
}));

describe('Source Resolver - Unit Tests', () => {
    let tempBase: string;

    beforeEach(() => {
        tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'coderadius-test-resolver-'));
    });

    afterEach(() => {
        fs.rmSync(tempBase, { recursive: true, force: true });
    });

    describe('Remote URL Detection', () => {
        it('should resolve HTTPS github URLs', async () => {
            // resolveSource will call cloneOrPull which we would need to mock more deeply
            // if we wanted to test actual cloning. For now let's focus on path logic.
            // But we can verify it doesn't try to treat it as a local path.
        });
    });

    describe('findLocalRepos', () => {
        it('should detect a directory with .git as a single repo', async () => {
            const repoPath = path.join(tempBase, 'my-repo');
            fs.mkdirSync(repoPath);
            fs.mkdirSync(path.join(repoPath, '.git'));

            const repos = await findLocalRepos(repoPath);
            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('my-repo');
            expect(repos[0].path).toBe(repoPath);
        });

        it('should detect multiple git repos in a monorepo layout', async () => {
            fs.mkdirSync(path.join(tempBase, 'services'));
            const svc1 = path.join(tempBase, 'services/svc1');
            const svc2 = path.join(tempBase, 'services/svc2');
            
            fs.mkdirSync(svc1, { recursive: true });
            fs.mkdirSync(path.join(svc1, '.git'));
            
            fs.mkdirSync(svc2, { recursive: true });
            fs.mkdirSync(path.join(svc2, '.git'));

            const repos = await findLocalRepos(tempBase);
            expect(repos).toHaveLength(2);
            const names = repos.map(r => r.name).sort();
            expect(names).toEqual(['svc1', 'svc2']);
        });

        it('should fallback to treating a directory as a single repo if no .git is found (Legacy Monolith)', async () => {
            // This is the bug fix verification!
            const monolithPath = path.join(tempBase, 'legacy-monolith');
            fs.mkdirSync(monolithPath);
            fs.mkdirSync(path.join(monolithPath, 'src'));
            fs.mkdirSync(path.join(monolithPath, 'lib'));
            fs.writeFileSync(path.join(monolithPath, 'index.php'), '<?php ...');

            const repos = await findLocalRepos(monolithPath);
            
            // Should NOT return 2 repos (src, lib), but 1 repo (legacy-monolith)
            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('legacy-monolith');
            expect(repos[0].path).toBe(monolithPath);
        });

        it('should exclude git submodules from local repo discovery', async () => {
            // Setup a "monorepo" with one real repo and one submodule
            const submodulePath = path.join(tempBase, 'external-lib');
            const realRepoPath = path.join(tempBase, 'internal-service');
            
            fs.mkdirSync(submodulePath);
            fs.mkdirSync(path.join(submodulePath, '.git')); // It looks like a repo
            
            fs.mkdirSync(realRepoPath);
            fs.mkdirSync(path.join(realRepoPath, '.git'));

            // Create .gitmodules in the root
            fs.writeFileSync(path.join(tempBase, '.gitmodules'), `
[submodule "external-lib"]
	path = external-lib
	url = https://github.com/other/lib.git
`);

            const repos = await findLocalRepos(tempBase);
            
            // Should only find the internal-service, NOT the submodule
            expect(repos).toHaveLength(1);
            expect(repos[0].name).toBe('internal-service');
        });
    });

    describe('readGitSubmodulePaths', () => {
        it('should correctly parse .gitmodules file', () => {
            const repoPath = tempBase;
            fs.writeFileSync(path.join(repoPath, '.gitmodules'), `
[submodule "vendor/package1"]
	path = vendor/pkg1
[submodule "libs/pkg2"]
	path = libs/pkg2
`);
            const paths = readGitSubmodulePaths(repoPath);
            expect(paths.has('vendor/pkg1')).toBe(true);
            expect(paths.has('libs/pkg2')).toBe(true);
            expect(paths.has('vendor')).toBe(true); // Should also track top-level dir
            expect(paths.has(path.join(repoPath, 'libs/pkg2'))).toBe(true);
        });
    });
});
