import { describe, it, expect } from 'vitest';
import { classifyBlastPositional } from '../../../src/cli/commands/evaluate/blast.js';

const never = () => false;

describe('classifyBlastPositional', () => {
    it('returns empty when no positional is given', () => {
        expect(classifyBlastPositional(undefined, never, never)).toEqual({});
    });

    it('treats an existing directory as the repo path', () => {
        const result = classifyBlastPositional('../orders', p => p === '../orders', never);
        expect(result).toEqual({ repoPath: '../orders' });
    });

    it('treats a non-directory that resolves as a git ref as the head', () => {
        const result = classifyBlastPositional('feature/checkout', never, r => r === 'feature/checkout');
        expect(result).toEqual({ headRef: 'feature/checkout' });
    });

    it('prefers the directory interpretation when both would match', () => {
        const always = () => true;
        expect(classifyBlastPositional('main', always, always)).toEqual({ repoPath: 'main' });
    });

    it('falls through as a path when neither matches (existing error names it)', () => {
        expect(classifyBlastPositional('no-such-thing', never, never)).toEqual({ repoPath: 'no-such-thing' });
    });
});
