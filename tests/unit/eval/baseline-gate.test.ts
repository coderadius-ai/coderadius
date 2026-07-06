import { describe, it, expect } from 'vitest';
import {
    evaluateBaselineGate,
    shouldRunGitFallback,
    formatPreflightSummary,
} from '../../../src/eval/baseline-gate.js';

describe('evaluateBaselineGate', () => {
    it('aborts (exitCode 2) when no files are in the graph and override is off', () => {
        const result = evaluateBaselineGate({
            knownFiles: [],
            allowUnknownBaseline: false,
            qualifiedRepoName: 'acme/quote-service',
            repoRoot: '/tmp/quote-service',
        });
        expect(result.proceed).toBe(false);
        if (result.proceed) throw new Error('typeguard');
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain('acme/quote-service');
        expect(result.message).toContain('cr analyze');
        expect(result.message).toContain('--allow-unknown-baseline');
    });

    it('proceeds with a warning when no files are in the graph and override is on', () => {
        const result = evaluateBaselineGate({
            knownFiles: [],
            allowUnknownBaseline: true,
            qualifiedRepoName: 'acme/quote-service',
            repoRoot: '/tmp/quote-service',
        });
        expect(result.proceed).toBe(true);
        if (!result.proceed) throw new Error('typeguard');
        expect(result.warning).toBeDefined();
        expect(result.warning).toContain('acme/quote-service');
        expect(result.warning).toContain('LOW');
    });

    it('proceeds without a warning when at least one file is in the graph', () => {
        const result = evaluateBaselineGate({
            knownFiles: ['src/A.ts'],
            allowUnknownBaseline: false,
            qualifiedRepoName: 'acme/quote-service',
            repoRoot: '/tmp/quote-service',
        });
        expect(result.proceed).toBe(true);
        if (!result.proceed) throw new Error('typeguard');
        expect(result.warning).toBeUndefined();
    });

    it('proceeds without a warning even with override on, when baseline is fully present', () => {
        const result = evaluateBaselineGate({
            knownFiles: ['src/A.ts', 'src/B.ts'],
            allowUnknownBaseline: true,
            qualifiedRepoName: 'acme/quote-service',
            repoRoot: '/tmp/quote-service',
        });
        expect(result.proceed).toBe(true);
        if (!result.proceed) throw new Error('typeguard');
        expect(result.warning).toBeUndefined();
    });

    it('does not include em-dashes in the abort message (project rule)', () => {
        const result = evaluateBaselineGate({
            knownFiles: [],
            allowUnknownBaseline: false,
            qualifiedRepoName: 'acme/x',
            repoRoot: '/tmp/x',
        });
        if (result.proceed) throw new Error('typeguard');
        expect(result.message).not.toContain('—');
    });
});

describe('shouldRunGitFallback', () => {
    it('runs when partially synced and no --files flag', () => {
        expect(shouldRunGitFallback({
            knownFilesCount: 5,
            unknownFilesCount: 2,
            hasFilesFlag: false,
        })).toBe(true);
    });

    it('does NOT run when the repo is fully unsynced (regression case)', () => {
        expect(shouldRunGitFallback({
            knownFilesCount: 0,
            unknownFilesCount: 7,
            hasFilesFlag: false,
        })).toBe(false);
    });

    it('does NOT run when there are no unknown files', () => {
        expect(shouldRunGitFallback({
            knownFilesCount: 5,
            unknownFilesCount: 0,
            hasFilesFlag: false,
        })).toBe(false);
    });

    it('does NOT run when --files flag was used (explicit file list)', () => {
        expect(shouldRunGitFallback({
            knownFilesCount: 5,
            unknownFilesCount: 2,
            hasFilesFlag: true,
        })).toBe(false);
    });
});

describe('formatPreflightSummary', () => {
    it('uses singular form for 1 file', () => {
        // Note: in non-TTY test environments the dim wrapper is a no-op.
        expect(formatPreflightSummary(1)).toContain('Static + semantic extraction: 1 changed file');
    });

    it('uses plural form for many files', () => {
        expect(formatPreflightSummary(12)).toContain('Static + semantic extraction: 12 changed files');
    });

    it('does not include the `[cr impact]` prefix anymore (redundant after banner)', () => {
        expect(formatPreflightSummary(3)).not.toContain('[cr impact]');
    });

    it('does not include a time estimate (was incoherent vs actual sub-10s durations)', () => {
        expect(formatPreflightSummary(3)).not.toContain('minute');
        expect(formatPreflightSummary(3)).not.toContain('Ctrl-C');
    });

    it('indents to align with the rest of the TTY report', () => {
        // Strip ANSI codes if any, then check the visible prefix is 2 spaces.
        const stripped = formatPreflightSummary(3).replace(/\x1b\[[0-9;]*m/g, '');
        expect(stripped.startsWith('  ')).toBe(true);
    });

    it('does not include em-dashes (project rule)', () => {
        expect(formatPreflightSummary(3)).not.toContain('—');
    });
});
