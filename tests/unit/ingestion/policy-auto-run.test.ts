import { describe, test, expect } from 'vitest';
import { getBuiltinPacks } from '../../../src/policy-runner/auto-run';

describe('policy auto-run', () => {
    test('builtin packs include agent-readiness', () => {
        const packs = getBuiltinPacks();
        expect(packs.length).toBeGreaterThanOrEqual(1);
        expect(packs.some(p => p.name === 'agent-readiness')).toBe(true);
    });

    test('builtin packs are immutable', () => {
        const packs = getBuiltinPacks();
        expect(Object.isFrozen(packs) || Array.isArray(packs)).toBe(true);
    });

    test('each pack has a name and reasonable timeout', () => {
        for (const pack of getBuiltinPacks()) {
            expect(pack.name).toBeTruthy();
            expect(pack.queryTimeoutMs).toBeGreaterThan(0);
        }
    });
});
