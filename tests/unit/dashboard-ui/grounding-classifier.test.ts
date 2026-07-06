import { describe, expect, it } from 'vitest';
import { classifyLastSeenCommit } from '../../../packages/dashboard-ui/src/types/grounding';

describe('classifyLastSeenCommit', () => {
    it("null → kind 'none'", () => {
        expect(classifyLastSeenCommit(null)).toEqual({ kind: 'none' });
    });

    it("undefined → kind 'none'", () => {
        expect(classifyLastSeenCommit(undefined)).toEqual({ kind: 'none' });
    });

    it("empty / whitespace → kind 'none'", () => {
        expect(classifyLastSeenCommit('')).toEqual({ kind: 'none' });
        expect(classifyLastSeenCommit('   ')).toEqual({ kind: 'none' });
    });

    it("'SYSTEM' (any case) → kind 'catalog'", () => {
        expect(classifyLastSeenCommit('SYSTEM')).toEqual({ kind: 'catalog' });
        expect(classifyLastSeenCommit('system')).toEqual({ kind: 'catalog' });
        expect(classifyLastSeenCommit('System')).toEqual({ kind: 'catalog' });
    });

    it("'unknown' (any case) → kind 'unresolved'", () => {
        expect(classifyLastSeenCommit('unknown')).toEqual({ kind: 'unresolved' });
        expect(classifyLastSeenCommit('UNKNOWN')).toEqual({ kind: 'unresolved' });
    });

    it("full 40-char SHA → kind 'sha' with 12-char short", () => {
        const full = '8f884d62a96f1a2b3c4d5e6f7890abcdef012345';
        expect(classifyLastSeenCommit(full)).toEqual({
            kind: 'sha',
            full,
            short: '8f884d62a96f',
        });
    });

    it("short SHA (≤ 12 chars) → kind 'sha' with short === full", () => {
        const short = '8f884d62a96f';
        expect(classifyLastSeenCommit(short)).toEqual({
            kind: 'sha',
            full: short,
            short,
        });
    });

    it('trims surrounding whitespace before classification', () => {
        expect(classifyLastSeenCommit('  SYSTEM  ')).toEqual({ kind: 'catalog' });
        const result = classifyLastSeenCommit('  abcdef1234567890  ');
        expect(result.kind).toBe('sha');
        if (result.kind === 'sha') expect(result.full).toBe('abcdef1234567890');
    });
});
