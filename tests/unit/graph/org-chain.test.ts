import { describe, it, expect } from 'vitest';
import { baseOrgPath, sanitizeOrg } from '../../../src/graph/mutations/organization.js';

// Pure logic for the organization derivation. No DB.
//
// Organizations are SINGLE-LEVEL by design: they may come from GitLab groups,
// GitHub orgs, or a corporate IDP/LDAP, so the common denominator is one flat
// level. GitLab subgroup paths collapse into their base group.

describe('sanitizeOrg', () => {
    it('drops sentinel / empty values', () => {
        const invalid: Array<string | null | undefined> = ['', '  ', 'unknown', 'UNKNOWN', 'null', 'undefined', null, undefined];
        for (const v of invalid) {
            expect(sanitizeOrg(v)).toBeNull();
        }
    });

    it('trims and lowercases a real group path', () => {
        expect(sanitizeOrg('  Acme/Lib  ')).toBe('acme/lib');
        expect(sanitizeOrg('Acme')).toBe('acme');
    });
});

describe('baseOrgPath', () => {
    it('returns a one-segment org unchanged', () => {
        expect(baseOrgPath('acme')).toBe('acme');
    });

    it('collapses a GitLab subgroup path to the base group', () => {
        expect(baseOrgPath('acme/lib')).toBe('acme');
        expect(baseOrgPath('Acme/Lib/TS')).toBe('acme');
    });

    it('drops sentinel / empty values like sanitizeOrg', () => {
        expect(baseOrgPath('unknown')).toBeNull();
        expect(baseOrgPath('')).toBeNull();
        expect(baseOrgPath(null)).toBeNull();
    });

    it('never returns an empty base segment', () => {
        expect(baseOrgPath('/acme')).toBe('acme');
    });
});
