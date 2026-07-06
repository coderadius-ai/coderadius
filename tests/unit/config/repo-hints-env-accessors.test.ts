import { describe, it, expect } from 'vitest';
import {
    RepoHintsSchema,
    getEnvAccessors,
    type EnvAccessor,
} from '../../../src/config/repo-hints.js';

describe('envAccessors schema', () => {
    it('round-trips a declared accessor with key and default positions', () => {
        const hints = RepoHintsSchema.parse({
            envAccessors: [
                { callee: 'Acme\\Platform\\EnvVault::fetch', keyArg: 0, defaultArg: 1 },
            ],
        });
        const accessors: EnvAccessor[] = getEnvAccessors(hints);
        expect(accessors).toHaveLength(1);
        expect(accessors[0].callee).toBe('Acme\\Platform\\EnvVault::fetch');
        expect(accessors[0].keyArg).toBe(0);
        expect(accessors[0].defaultArg).toBe(1);
    });

    it('defaults: keyArg=0, defaultArg absent, envAccessors=[] when omitted', () => {
        const minimal = RepoHintsSchema.parse({
            envAccessors: [{ callee: 'EnvVault::fetch' }],
        });
        expect(minimal.envAccessors[0].keyArg).toBe(0);
        expect(minimal.envAccessors[0].defaultArg).toBeUndefined();

        const empty = RepoHintsSchema.parse({});
        expect(getEnvAccessors(empty)).toEqual([]);
    });

    it('rejects negative arg positions', () => {
        expect(RepoHintsSchema.safeParse({
            envAccessors: [{ callee: 'X::y', keyArg: -1 }],
        }).success).toBe(false);
        expect(RepoHintsSchema.safeParse({
            envAccessors: [{ callee: 'X::y', defaultArg: -2 }],
        }).success).toBe(false);
    });

    it('rejects an accessor without callee', () => {
        expect(RepoHintsSchema.safeParse({
            envAccessors: [{ keyArg: 0 }],
        }).success).toBe(false);
    });
});
