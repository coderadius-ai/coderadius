import { describe, it, expect } from 'vitest';
import { makeFilePathResolver } from '../../../src/eval/file-path-resolver.js';

describe('makeFilePathResolver', () => {
    const resolve = makeFilePathResolver();

    it('returns null when the repo URL is absent (caller falls back to relative path)', () => {
        expect(resolve(null, 'apps/api/src/Quote.ts')).toBeNull();
    });

    it('returns null for an empty relative path', () => {
        expect(resolve('https://github.com/acme/repo', '')).toBeNull();
    });

    it('builds a GitHub-style URL for github.com hosts', () => {
        expect(resolve('https://github.com/acme/repo', 'apps/api/src/Quote.ts'))
            .toBe('https://github.com/acme/repo/blob/HEAD/apps/api/src/Quote.ts');
    });

    it('builds a GitLab-style URL for gitlab.* hosts (the /-/blob/ shape)', () => {
        expect(resolve('https://gitlab.com/acme/repo', 'apps/api/src/Quote.ts'))
            .toBe('https://gitlab.com/acme/repo/-/blob/HEAD/apps/api/src/Quote.ts');
        expect(resolve('https://gitlab.internal.acme.io/squad/repo', 'src/A.ts'))
            .toBe('https://gitlab.internal.acme.io/squad/repo/-/blob/HEAD/src/A.ts');
    });

    it('builds a Bitbucket-style URL for bitbucket.* hosts (the /src/ shape)', () => {
        expect(resolve('https://bitbucket.org/acme/repo', 'src/A.ts'))
            .toBe('https://bitbucket.org/acme/repo/src/HEAD/src/A.ts');
    });

    it('strips trailing .git from the URL', () => {
        expect(resolve('https://github.com/acme/repo.git', 'a.ts'))
            .toBe('https://github.com/acme/repo/blob/HEAD/a.ts');
    });

    it('strips trailing slashes from the URL', () => {
        expect(resolve('https://github.com/acme/repo///', 'a.ts'))
            .toBe('https://github.com/acme/repo/blob/HEAD/a.ts');
    });

    it('never returns an absolute filesystem path (no leak surface)', () => {
        // Even when caller asks with no URL, we never invent /Users/... etc.
        expect(resolve(null, 'apps/api/src/Quote.ts')).toBeNull();
    });
});
