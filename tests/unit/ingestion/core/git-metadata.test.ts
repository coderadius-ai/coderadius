/**
 * Unit Tests — Git Metadata Extractor
 *
 * Tests the three core functions:
 *   1. detectHostingPlatform() — pure URL parsing + CI env fallback
 *   2. probeBranches() / extractGitMetadata() — branch detection with mock git
 *   3. Cache marker behavior (write, read, invalidation)
 *
 * All git operations are mocked via simple-git.
 * File system operations use a temp directory for marker file tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { detectHostingPlatform, extractGitMetadata, type HostingPlatform } from '../../../../src/ingestion/core/git-metadata.js';

// ─── simple-git Mock ─────────────────────────────────────────────────────────

const { mockGitRaw } = vi.hoisted(() => ({
    mockGitRaw: vi.fn(),
}));

vi.mock('simple-git', () => ({
    simpleGit: () => ({
        raw: mockGitRaw,
    }),
}));

// ═════════════════════════════════════════════════════════════════════════════
// 1. Platform Detection — detectHostingPlatform()
// ═════════════════════════════════════════════════════════════════════════════

describe('detectHostingPlatform', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Clear CI env vars that might pollute the test environment (e.g. running in GitHub Actions)
        delete process.env.GITLAB_CI;
        delete process.env.CI_SERVER_NAME;
        delete process.env.GITHUB_ACTIONS;
        delete process.env.BITBUCKET_PIPELINE_UUID;
        delete process.env.SYSTEM_TEAMFOUNDATIONSERVERURI;
        delete process.env.CODEBUILD_BUILD_ID;
    });

    afterEach(() => {
        // Restore environment after each test
        process.env = { ...originalEnv };
    });

    describe('HTTPS URLs', () => {
        it('should detect GitHub from HTTPS URL', () => {
            expect(detectHostingPlatform('https://github.com/org/repo.git')).toBe('github');
        });

        it('should detect GitLab from HTTPS URL', () => {
            expect(detectHostingPlatform('https://gitlab.com/org/repo.git')).toBe('gitlab');
        });

        it('should detect Bitbucket from HTTPS URL', () => {
            expect(detectHostingPlatform('https://bitbucket.org/org/repo.git')).toBe('bitbucket');
        });

        it('should detect Azure DevOps from dev.azure.com URL', () => {
            expect(detectHostingPlatform('https://dev.azure.com/org/project/_git/repo')).toBe('azure-devops');
        });

        it('should detect Azure DevOps from visualstudio.com URL', () => {
            expect(detectHostingPlatform('https://org.visualstudio.com/project/_git/repo')).toBe('azure-devops');
        });

        it('should detect AWS CodeCommit from HTTPS URL', () => {
            expect(detectHostingPlatform('https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyDemoRepo')).toBe('aws-codecommit');
        });

        it('should detect Google Cloud Source Repositories from HTTPS URL', () => {
            expect(detectHostingPlatform('https://source.developers.google.com/p/my-project/r/my-repo')).toBe('google-cloud');
        });
    });

    describe('SSH URLs', () => {
        it('should detect GitHub from SSH URL', () => {
            expect(detectHostingPlatform('git@github.com:org/repo.git')).toBe('github');
        });

        it('should detect GitLab from SSH URL', () => {
            expect(detectHostingPlatform('git@gitlab.com:org/repo.git')).toBe('gitlab');
        });

        it('should detect Bitbucket from SSH URL', () => {
            expect(detectHostingPlatform('git@bitbucket.org:org/repo.git')).toBe('bitbucket');
        });

        it('should detect AWS CodeCommit from SSH URL', () => {
            expect(detectHostingPlatform('ssh://git-codecommit.eu-west-1.amazonaws.com/v1/repos/MyDemoRepo')).toBe('aws-codecommit');
        });

        it('should detect AWS CodeCommit from GRC URL', () => {
            expect(detectHostingPlatform('codecommit::us-east-1://MyDemoRepo')).toBe('aws-codecommit');
        });
    });

    describe('Self-hosted instances', () => {
        it('should detect self-hosted GitLab from gitlab.corp.com', () => {
            expect(detectHostingPlatform('https://gitlab.acme-corp.com/team/repo.git')).toBe('gitlab');
        });

        it('should detect self-hosted GitLab from SSH with gitlab. prefix', () => {
            expect(detectHostingPlatform('git@gitlab.internal.com:ops/infra.git')).toBe('gitlab');
        });

        it('should detect self-hosted GitHub Enterprise from github.corp.com', () => {
            expect(detectHostingPlatform('https://github.enterprise.com/org/repo.git')).toBe('github');
        });
    });

    describe('CI environment variable fallback', () => {
        it('should detect GitLab via GITLAB_CI env var when no URL', () => {
            process.env.GITLAB_CI = 'true';
            expect(detectHostingPlatform(undefined)).toBe('gitlab');
        });

        it('should detect GitLab via CI_SERVER_NAME env var when no URL', () => {
            process.env.CI_SERVER_NAME = 'GitLab';
            expect(detectHostingPlatform(undefined)).toBe('gitlab');
        });

        it('should detect GitHub via GITHUB_ACTIONS env var when no URL', () => {
            process.env.GITHUB_ACTIONS = 'true';
            expect(detectHostingPlatform(undefined)).toBe('github');
        });

        it('should detect Bitbucket via BITBUCKET_PIPELINE_UUID env var when no URL', () => {
            process.env.BITBUCKET_PIPELINE_UUID = '{abc-123}';
            expect(detectHostingPlatform(undefined)).toBe('bitbucket');
        });

        it('should detect Azure DevOps via SYSTEM_TEAMFOUNDATIONSERVERURI env var when no URL', () => {
            process.env.SYSTEM_TEAMFOUNDATIONSERVERURI = 'https://dev.azure.com/org';
            expect(detectHostingPlatform(undefined)).toBe('azure-devops');
        });

        it('should detect AWS CodeCommit via CODEBUILD_BUILD_ID env var when no URL', () => {
            process.env.CODEBUILD_BUILD_ID = 'my-project:12345678-1234-1234-1234-123456789012';
            expect(detectHostingPlatform(undefined)).toBe('aws-codecommit');
        });

        it('should fall back to CI env when URL has unrecognizable domain', () => {
            process.env.GITLAB_CI = 'true';
            expect(detectHostingPlatform('https://git.custom-domain.com/org/repo.git')).toBe('gitlab');
        });
    });

    describe('Edge cases', () => {
        it('should return unknown for undefined URL with no CI env', () => {
            // Clear all CI env vars
            delete process.env.GITLAB_CI;
            delete process.env.CI_SERVER_NAME;
            delete process.env.GITHUB_ACTIONS;
            delete process.env.BITBUCKET_PIPELINE_UUID;
            delete process.env.SYSTEM_TEAMFOUNDATIONSERVERURI;
            delete process.env.CODEBUILD_BUILD_ID;
            expect(detectHostingPlatform(undefined)).toBe('unknown');
        });

        it('should return unknown for an empty string URL', () => {
            delete process.env.GITLAB_CI;
            delete process.env.CI_SERVER_NAME;
            delete process.env.GITHUB_ACTIONS;
            delete process.env.BITBUCKET_PIPELINE_UUID;
            delete process.env.SYSTEM_TEAMFOUNDATIONSERVERURI;
            delete process.env.CODEBUILD_BUILD_ID;
            expect(detectHostingPlatform('')).toBe('unknown');
        });

        it('should return unknown for unrecognizable URL without CI env', () => {
            delete process.env.GITLAB_CI;
            delete process.env.CI_SERVER_NAME;
            delete process.env.GITHUB_ACTIONS;
            expect(detectHostingPlatform('https://git.internal.company.com/repo.git')).toBe('unknown');
        });

        it('should be case-insensitive for URL matching', () => {
            expect(detectHostingPlatform('https://GITHUB.COM/Org/Repo.git')).toBe('github');
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Branch Detection & extractGitMetadata()
// ═════════════════════════════════════════════════════════════════════════════

describe('extractGitMetadata', () => {
    let tempDir: string;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderadius-git-meta-'));
        // Create a fake .git directory
        fs.mkdirSync(path.join(tempDir, '.git'));
        mockGitRaw.mockReset();
        // Clear CI env vars that pollute hosting-platform detection (e.g. GITHUB_ACTIONS in CI)
        delete process.env.GITLAB_CI;
        delete process.env.CI_SERVER_NAME;
        delete process.env.GITHUB_ACTIONS;
        delete process.env.BITBUCKET_PIPELINE_UUID;
        delete process.env.SYSTEM_TEAMFOUNDATIONSERVERURI;
        delete process.env.CODEBUILD_BUILD_ID;
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        process.env = { ...originalEnv };
    });

    describe('Default branch detection', () => {
        it('should detect default branch via symbolic-ref + ls-remote', async () => {
            // symbolic-ref returns "refs/remotes/origin/main"
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'abc123\trefs/heads/main\n' +
                        'def456\trefs/heads/develop\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBe('main');
            expect(meta.coreBranches).toContain('main');
            expect(meta.coreBranches).toContain('develop');
            expect(meta.hostingPlatform).toBe('github');
        });

        it('should fallback to main/master heuristic when symbolic-ref fails (CI trap)', async () => {
            // symbolic-ref fails (exit code 128 — detached HEAD in CI)
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'));
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'abc123\trefs/heads/master\n' +
                        'def456\trefs/heads/develop\n' +
                        'ghi789\trefs/heads/staging\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://gitlab.com/org/repo.git');

            // Should fallback to 'master' since main is not present
            expect(meta.defaultBranch).toBe('master');
            expect(meta.coreBranches).toContain('master');
            expect(meta.coreBranches).toContain('develop');
            expect(meta.coreBranches).toContain('staging');
            expect(meta.hostingPlatform).toBe('gitlab');
        });

        it('should prefer main over master when both exist in fallback', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('detached HEAD'));
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'abc123\trefs/heads/main\n' +
                        'def456\trefs/heads/master\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBe('main');
        });

        it('should return null defaultBranch when neither main nor master exists', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('detached HEAD'));
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'abc123\trefs/heads/develop\n' +
                        'def456\trefs/heads/feature/xyz\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBeNull();
            expect(meta.coreBranches).toContain('develop');
            // feature/* is not a core branch
            expect(meta.coreBranches).not.toContain('feature/xyz');
        });
    });

    describe('Core branch pattern matching', () => {
        it('should detect all standard core branch patterns', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'a\trefs/heads/main\n' +
                        'b\trefs/heads/master\n' +
                        'c\trefs/heads/develop\n' +
                        'd\trefs/heads/development\n' +
                        'e\trefs/heads/staging\n' +
                        'f\trefs/heads/prod\n' +
                        'g\trefs/heads/qa\n' +
                        'h\trefs/heads/uat\n' +
                        'i\trefs/heads/feature/new-thing\n' +
                        'j\trefs/heads/bugfix/minor-issue\n' +
                        'k\trefs/heads/release/1.0\n' +
                        'l\trefs/heads/hotfix/critical-fix\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.coreBranches).toContain('main');
            expect(meta.coreBranches).toContain('master');
            expect(meta.coreBranches).toContain('develop');
            expect(meta.coreBranches).toContain('development');
            expect(meta.coreBranches).toContain('staging');
            expect(meta.coreBranches).toContain('prod');
            expect(meta.coreBranches).toContain('qa');
            expect(meta.coreBranches).toContain('uat');

            // These should NOT be in core branches
            expect(meta.coreBranches).not.toContain('feature/new-thing');
            expect(meta.coreBranches).not.toContain('bugfix/minor-issue');
            expect(meta.coreBranches).not.toContain('release/1.0');
            expect(meta.coreBranches).not.toContain('hotfix/critical-fix');
        });

        it('should sort core branches deterministically', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'z\trefs/heads/staging\n' +
                        'y\trefs/heads/develop\n' +
                        'x\trefs/heads/main\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            // Core branches should be sorted alphabetically (develop, main, staging)
            expect(meta.coreBranches).toEqual(['develop', 'main', 'staging']);
            // Default branch should be detected
            expect(meta.defaultBranch).toBe('main');
        });
    });

    describe('Network mode control', () => {
        it('should skip ls-remote when allowNetwork=false', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                // ls-remote should NOT be called
                if (args[0] === 'ls-remote') {
                    throw new Error('ls-remote should not be called in offline mode');
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git', false);

            expect(meta.defaultBranch).toBe('main');
            // Offline mode: coreBranches only contains the default branch
            expect(meta.coreBranches).toEqual(['main']);
            expect(meta.hostingPlatform).toBe('github');
        });

        it('should handle offline mode with no symbolic-ref (graceful degradation)', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('detached HEAD'));
                }
                if (args[0] === 'ls-remote') {
                    throw new Error('ls-remote should not be called in offline mode');
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git', false);

            expect(meta.defaultBranch).toBeNull();
            expect(meta.coreBranches).toEqual([]);
            expect(meta.hostingPlatform).toBe('github');
        });
    });

    describe('Cache marker behavior (Trap 2)', () => {
        it('should read from marker file on subsequent calls', async () => {
            // Write a cached marker file
            const markerPath = path.join(tempDir, '.git', '.coderadius-branches-probed');
            fs.writeFileSync(markerPath, JSON.stringify({
                defaultBranch: 'main',
                coreBranches: ['main', 'develop', 'staging'],
            }));

            // Git should NOT be called at all — cache hit
            mockGitRaw.mockImplementation(() => {
                throw new Error('git should not be called when cache exists');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git', true, false);

            expect(meta.defaultBranch).toBe('main');
            expect(meta.coreBranches).toEqual(['main', 'develop', 'staging']);
        });

        it('should ignore marker file when freshScan=true (--fresh invalidation)', async () => {
            // Write a stale marker
            const markerPath = path.join(tempDir, '.git', '.coderadius-branches-probed');
            fs.writeFileSync(markerPath, JSON.stringify({
                defaultBranch: 'master',
                coreBranches: ['master'],
            }));

            // Fresh probe returns different data
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve(
                        'abc\trefs/heads/main\n' +
                        'def\trefs/heads/develop\n'
                    );
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git', true, true);

            // Should have fresh data, not cached
            expect(meta.defaultBranch).toBe('main');
            expect(meta.coreBranches).toContain('main');
            expect(meta.coreBranches).toContain('develop');
        });

        it('should write marker file after successful probe', async () => {
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve('abc\trefs/heads/main\n');
                }
                return Promise.resolve('');
            });

            await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            const markerPath = path.join(tempDir, '.git', '.coderadius-branches-probed');
            expect(fs.existsSync(markerPath)).toBe(true);

            const cached = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            expect(cached.defaultBranch).toBe('main');
            expect(cached.coreBranches).toContain('main');
        });

        it('should handle corrupted marker files gracefully', async () => {
            // Write garbage to the marker file
            const markerPath = path.join(tempDir, '.git', '.coderadius-branches-probed');
            fs.writeFileSync(markerPath, '{invalid json!!!');

            // Should fall through to git probe
            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.resolve('refs/remotes/origin/main\n');
                }
                if (args[0] === 'ls-remote') {
                    return Promise.resolve('abc\trefs/heads/main\n');
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBe('main');
        });
    });

    describe('Error resilience (never throws)', () => {
        it('should survive when both symbolic-ref and ls-remote fail', async () => {
            mockGitRaw.mockImplementation(() => {
                return Promise.reject(new Error('network unreachable'));
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            // Should not throw — graceful degradation
            expect(meta.hostingPlatform).toBe('github');
            // Default branch may be null if no local refs exist
            expect(meta.defaultBranch).toBeNull();
            expect(meta.coreBranches).toEqual([]);
        });

        it('should survive when .git directory does not exist (offline + no .git)', async () => {
            const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderadius-no-git-'));
            try {
                mockGitRaw.mockImplementation(() => {
                    return Promise.reject(new Error('not a git repository'));
                });

                const meta = await extractGitMetadata(noGitDir, undefined, false);

                expect(meta.hostingPlatform).toBe('unknown');
                expect(meta.defaultBranch).toBeNull();
                expect(meta.coreBranches).toEqual([]);
            } finally {
                fs.rmSync(noGitDir, { recursive: true, force: true });
            }
        });
    });

    describe('Local ref fallback (no network, ls-remote fails)', () => {
        it('should detect default branch from local refs/remotes/origin/ when ls-remote fails', async () => {
            // Create local ref structure
            const refsDir = path.join(tempDir, '.git', 'refs', 'remotes', 'origin');
            fs.mkdirSync(refsDir, { recursive: true });
            fs.writeFileSync(path.join(refsDir, 'main'), 'abc123');

            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('detached HEAD'));
                }
                if (args[0] === 'ls-remote') {
                    return Promise.reject(new Error('network down'));
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBe('main');
            expect(meta.coreBranches).toContain('main');
        });

        it('should detect master from local refs when main does not exist', async () => {
            const refsDir = path.join(tempDir, '.git', 'refs', 'remotes', 'origin');
            fs.mkdirSync(refsDir, { recursive: true });
            fs.writeFileSync(path.join(refsDir, 'master'), 'abc123');

            mockGitRaw.mockImplementation((args: string[]) => {
                if (args[0] === 'symbolic-ref') {
                    return Promise.reject(new Error('detached HEAD'));
                }
                if (args[0] === 'ls-remote') {
                    return Promise.reject(new Error('network down'));
                }
                return Promise.resolve('');
            });

            const meta = await extractGitMetadata(tempDir, 'https://github.com/org/repo.git');

            expect(meta.defaultBranch).toBe('master');
            expect(meta.coreBranches).toContain('master');
        });
    });
});
