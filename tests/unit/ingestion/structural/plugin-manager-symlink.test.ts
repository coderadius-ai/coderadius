import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveInRepoSymlink } from '../../../../src/ingestion/structural/plugin-manager.js';

const REPO = '/repo';
const j = (rel: string) => path.join(REPO, rel);

describe('resolveInRepoSymlink', () => {
    it('returns undefined for a regular file (realpath unchanged)', () => {
        const rel = 'payment-service/.claude/skills/x/SKILL.md';
        const realpath = (p: string) => p; // no symlink anywhere
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBeUndefined();
    });

    it('detects an ANCESTOR-directory symlink (.agents -> .claude), not just the leaf', () => {
        // notification-service/.agents/skills/x is a symlink to .claude/skills/x;
        // the SKILL.md leaf is a regular file, so a leaf-only lstat would miss it.
        const rel = 'notification-service/.agents/skills/x/SKILL.md';
        const target = 'notification-service/.claude/skills/x/SKILL.md';
        const realpath = (p: string) => (p === j(rel) ? j(target) : p);
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBe(target);
    });

    it('detects a leaf-file symlink', () => {
        const rel = 'svc/.agents/skills/x/SKILL.md';
        const target = 'svc/.claude/skills/x/SKILL.md';
        const realpath = (p: string) => (p === j(rel) ? j(target) : p);
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBe(target);
    });

    it('ignores symlinks that resolve OUTSIDE the repo', () => {
        const rel = 'svc/.agents/skills/x/SKILL.md';
        const realpath = (_p: string) => '/somewhere/else/SKILL.md';
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBeUndefined();
    });

    it('returns undefined for a broken symlink (realpath throws)', () => {
        const rel = 'svc/.agents/skills/x/SKILL.md';
        const realpath = (_p: string) => { throw new Error('ENOENT'); };
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBeUndefined();
    });

    it('does not false-positive when only the repo prefix is symlinked', () => {
        // Caller canonicalizes repoRealPath, so the resolved path stays under it
        // and the relative portion is unchanged → not flagged.
        const rel = 'svc/.claude/skills/x/SKILL.md';
        const realpath = (p: string) => p; // canonical prefix already applied
        expect(resolveInRepoSymlink(REPO, rel, realpath)).toBeUndefined();
    });
});
