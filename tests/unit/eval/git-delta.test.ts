import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these run before vi.mock() hoisting
const { mockExecSync, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockExistsSync: vi.fn(() => false),
    mockReadFileSync: vi.fn(() => ''),
}));

vi.mock('node:child_process', () => ({ execSync: mockExecSync }));
vi.mock('node:fs', () => ({
    default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
}));
vi.mock('../../../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { computeGitDelta, detectConfigFiles } from '../../../src/eval/git-delta.js';

// ─── computeGitDelta (git mode) ───────────────────────────────────────────────

describe('computeGitDelta — git mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
    });

    it('returns changed files from git diff output', async () => {
        mockExecSync.mockReturnValue('src/A.ts\nsrc/B.php\n');
        const result = await computeGitDelta({ base: 'origin/main', head: 'HEAD', repoRoot: '/repo' });
        expect(result.changedFiles).toEqual(['src/A.ts', 'src/B.php']);
        expect(result.base).toBe('origin/main');
        expect(result.head).toBe('HEAD');
        expect(result.filteredCount).toBe(0);
    });

    it('returns empty array when git diff produces no output', async () => {
        mockExecSync.mockReturnValue('');
        const result = await computeGitDelta({ base: 'origin/main', head: 'HEAD', repoRoot: '/repo' });
        expect(result.changedFiles).toHaveLength(0);
    });

    it('falls back to two-dot diff when three-dot diff fails', async () => {
        mockExecSync
            .mockImplementationOnce(() => { throw new Error('unknown revision'); })
            .mockReturnValueOnce('src/fallback.ts\n');
        const result = await computeGitDelta({ base: 'origin/main', head: 'HEAD', repoRoot: '/repo' });
        expect(result.changedFiles).toEqual(['src/fallback.ts']);
    });

    it('throws when both three-dot and two-dot diff fail', async () => {
        mockExecSync.mockImplementation(() => { throw new Error('git not found'); });
        await expect(computeGitDelta({ base: 'origin/main', head: 'HEAD', repoRoot: '/repo' }))
            .rejects.toThrow('Git diff failed');
    });

    it('uses default base/head when not specified', async () => {
        mockExecSync.mockReturnValue('');
        const result = await computeGitDelta({ repoRoot: '/repo' });
        expect(result.base).toBe('origin/main');
        expect(result.head).toBe('HEAD');
    });
});

// ─── computeGitDelta (explicit files mode) ───────────────────────────────────

describe('computeGitDelta — explicit files mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
    });

    it('parses comma-separated file list without running git', async () => {
        const result = await computeGitDelta({ explicitFiles: 'src/A.ts,src/B.php', repoRoot: '/repo' });
        expect(mockExecSync).not.toHaveBeenCalled();
        expect(result.changedFiles).toEqual(['src/A.ts', 'src/B.php']);
    });

    it('parses newline-separated file list', async () => {
        const result = await computeGitDelta({ explicitFiles: 'src/A.ts\nsrc/B.php', repoRoot: '/repo' });
        expect(result.changedFiles).toEqual(['src/A.ts', 'src/B.php']);
    });

    it('trims whitespace from file paths', async () => {
        const result = await computeGitDelta({ explicitFiles: '  src/A.ts , src/B.php  ', repoRoot: '/repo' });
        expect(result.changedFiles).toEqual(['src/A.ts', 'src/B.php']);
    });

    it('filters out empty entries', async () => {
        const result = await computeGitDelta({ explicitFiles: 'src/A.ts,,src/B.php', repoRoot: '/repo' });
        expect(result.changedFiles).toHaveLength(2);
    });
});

// ─── .crignore filtering ────────────────────────────────────────────────────

describe('computeGitDelta — .crignore filtering', () => {
    beforeEach(() => vi.clearAllMocks());

    it('filters files matching .crignore patterns', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('vendor/*\ndist/*\n');
        mockExecSync.mockReturnValue('src/A.ts\nvendor/lib.php\ndist/bundle.js\n');

        const result = await computeGitDelta({ base: 'main', head: 'HEAD', repoRoot: '/repo' });

        expect(result.changedFiles).toEqual(['src/A.ts']);
        expect(result.filteredCount).toBe(2);
    });

    it('ignores comment lines in .crignore', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('# This is a comment\nvendor/*\n');
        mockExecSync.mockReturnValue('src/A.ts\nvendor/lib.php\n');

        const result = await computeGitDelta({ base: 'main', head: 'HEAD', repoRoot: '/repo' });

        expect(result.changedFiles).toEqual(['src/A.ts']);
    });

    it('returns all files when no .crignore exists', async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecSync.mockReturnValue('src/A.ts\nsrc/B.ts\n');

        const result = await computeGitDelta({ base: 'main', head: 'HEAD', repoRoot: '/repo' });

        expect(result.changedFiles).toHaveLength(2);
        expect(result.filteredCount).toBe(0);
    });

    it('reports filteredCount correctly', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue('node_modules/*\n');
        mockExecSync.mockReturnValue('src/A.ts\nnode_modules/lodash/index.js\n');

        const result = await computeGitDelta({ base: 'main', head: 'HEAD', repoRoot: '/repo' });

        expect(result.filteredCount).toBe(1);
        expect(result.changedFiles).toHaveLength(1);
    });
});

// ─── detectConfigFiles ────────────────────────────────────────────────────────

describe('detectConfigFiles', () => {
    it('identifies YAML/YML files', () => {
        const configs = detectConfigFiles(['src/A.ts', 'config/services.yaml', 'deploy.yml']);
        expect(configs).toContain('config/services.yaml');
        expect(configs).toContain('deploy.yml');
        expect(configs).not.toContain('src/A.ts');
    });

    it('identifies files with "config" in the path', () => {
        const configs = detectConfigFiles(['src/MyConfig.php', 'src/Controller.php']);
        expect(configs).toContain('src/MyConfig.php');
        expect(configs).not.toContain('src/Controller.php');
    });

    it('identifies .env files', () => {
        const configs = detectConfigFiles(['.env', '.env.example', 'src/index.ts']);
        expect(configs).toContain('.env');
        expect(configs).toContain('.env.example');
    });

    it('identifies coderadius.yaml', () => {
        const configs = detectConfigFiles(['coderadius.yaml', 'src/A.ts']);
        expect(configs).toContain('coderadius.yaml');
    });

    it('identifies services.xml', () => {
        const configs = detectConfigFiles(['config/services.xml', 'src/A.ts']);
        expect(configs).toContain('config/services.xml');
    });

    it('returns empty array when no config files present', () => {
        expect(detectConfigFiles(['src/A.ts', 'src/B.php'])).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
        expect(detectConfigFiles([])).toHaveLength(0);
    });
});
