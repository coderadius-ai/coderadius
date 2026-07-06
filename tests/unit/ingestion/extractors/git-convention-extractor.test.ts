import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: git-convention-extractor.ts
//
// Mocks simple-git so we can drive the subject list deterministically.
// ═══════════════════════════════════════════════════════════════════════════════

const mockLog = vi.fn();

vi.mock('simple-git', () => ({
    simpleGit: vi.fn(() => ({ log: mockLog })),
}));

import { extractGitConventions } from '../../../../src/ingestion/extractors/git-convention-extractor.js';

function setSubjects(subjects: string[]) {
    mockLog.mockResolvedValue({
        all: subjects.map(s => ({ subject: s })),
    });
}

describe('extractGitConventions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns zero rates when the log is empty', async () => {
        setSubjects([]);
        const result = await extractGitConventions('/repo');
        expect(result).toEqual({ ticketIdRate: 0, conventionalCommitRate: 0, sampleSize: 0 });
    });

    it('counts ticket-ID and Conventional Commits independently', async () => {
        setSubjects([
            'ABC-123 feat: add new endpoint',       // ticket + conv
            'ABC-124 fix the bug',                  // ticket only
            'feat: refactor the loader',            // conv only
            'random fix without convention',        // neither
        ]);

        const result = await extractGitConventions('/repo');
        expect(result.sampleSize).toBe(4);
        expect(result.ticketIdRate).toBeCloseTo(0.5);   // 2/4
        expect(result.conventionalCommitRate).toBeCloseTo(0.5); // 2/4
    });

    it('handles Conventional Commits with scope and breaking marker', async () => {
        setSubjects([
            'feat(api)!: drop legacy endpoint',
            'fix(parser): off-by-one in tokenizer',
            'docs: README update',
        ]);

        const result = await extractGitConventions('/repo');
        expect(result.sampleSize).toBe(3);
        expect(result.conventionalCommitRate).toBe(1);
    });

    it('matches ticket prefixes case-sensitively (uppercase only)', async () => {
        setSubjects([
            'ABC-123 valid uppercase',
            'abc-123 invalid lowercase',
            'A-1 single letter rejected',
            'AB-7 minimum two letters accepted',
        ]);

        const result = await extractGitConventions('/repo');
        expect(result.ticketIdRate).toBeCloseTo(0.5); // 2/4
    });

    it('returns zeros on git failure (never throws)', async () => {
        mockLog.mockRejectedValueOnce(new Error('not a git repository'));
        const result = await extractGitConventions('/repo');
        expect(result).toEqual({ ticketIdRate: 0, conventionalCommitRate: 0, sampleSize: 0 });
    });

    it('respects custom maxCommits override', async () => {
        setSubjects(['feat: one']);
        await extractGitConventions('/repo', { maxCommits: 100 });
        expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ maxCount: 100 }));
    });
});
