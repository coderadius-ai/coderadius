import { describe, it, expect } from 'vitest';
import { computePruneCandidates } from '../../../src/cli/commands/policy/prune.js';

// Pure scoping logic for `cr policy prune --rules-path <path>`. The whole reason the
// prune is explicit + dry-run is that tag-scoping is intentionally permissive
// (a multi-tag rule is in scope of every one of its tags); these tests pin that
// contract so the dry-run preview is trustworthy.

const P = (id: string, tags: string[]) => ({ id, tags });

describe('computePruneCandidates', () => {
    it('reaps persisted rules in the pack tag-scope that are no longer loaded', () => {
        const persisted = [P('keep', ['pack-a']), P('orphan', ['pack-a']), P('other', ['pack-b'])];
        const candidates = computePruneCandidates(persisted, ['keep'], ['pack-a']);
        expect(candidates).toEqual(['orphan']);
    });

    it('never touches rules outside the run tag-scope', () => {
        const persisted = [P('a', ['pack-a']), P('b', ['pack-b'])];
        // Running pack-a must not list pack-b's rule, even though it is "not loaded".
        expect(computePruneCandidates(persisted, [], ['pack-a'])).toEqual(['a']);
    });

    it('returns nothing when the run carries no tags (fail-safe)', () => {
        const persisted = [P('a', ['pack-a']), P('b', ['pack-b'])];
        expect(computePruneCandidates(persisted, [], [])).toEqual([]);
    });

    it('treats a multi-tag rule as in-scope of any of its tags', () => {
        const persisted = [P('shared', ['pack-a', 'pack-b'])];
        // shared belongs to both packs; running pack-b lists it when not loaded.
        expect(computePruneCandidates(persisted, [], ['pack-b'])).toEqual(['shared']);
    });

    it('reaps nothing when every persisted rule is still loaded', () => {
        const persisted = [P('a', ['pack-a']), P('b', ['pack-a'])];
        expect(computePruneCandidates(persisted, ['a', 'b'], ['pack-a'])).toEqual([]);
    });
});
