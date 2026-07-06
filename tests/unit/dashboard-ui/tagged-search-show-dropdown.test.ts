import { describe, expect, it } from 'vitest';
import { shouldShowDropdown, type ShowDropdownInput } from '../../../packages/dashboard-ui/src/components/TaggedSearch';

const SCOPE = { key: 'service', label: 'Service', color: '#7c5cfc' };

function base(overrides: Partial<ShowDropdownInput> = {}): ShowDropdownInput {
    return {
        open: true,
        queryLength: 0,
        activeScope: null,
        scopeValue: null,
        scopeSuggestionsCount: 0,
        ...overrides,
    };
}

describe('shouldShowDropdown', () => {
    it('returns false when closed, regardless of query', () => {
        expect(shouldShowDropdown(base({ open: false, queryLength: 5 }))).toBe(false);
    });

    // THIS IS THE REGRESSION CASE — free-text query with no scope must open the dropdown.
    // This bug has resurfaced 3 times because refactors of the boolean condition
    // accidentally nest `queryLength > 0` inside scope-dependent sub-expressions.
    it('returns true for free-text query without any scope', () => {
        expect(shouldShowDropdown(base({ queryLength: 5 }))).toBe(true);
    });

    it('returns true when a scope is active (browse-all mode)', () => {
        expect(shouldShowDropdown(base({ activeScope: SCOPE }))).toBe(true);
    });

    it('returns true for query + active scope (filtered search)', () => {
        expect(shouldShowDropdown(base({ queryLength: 3, activeScope: SCOPE }))).toBe(true);
    });

    it('returns false when scope + scopeValue are both set (compound tag is sealed)', () => {
        expect(shouldShowDropdown(base({ activeScope: SCOPE, scopeValue: 'orders' }))).toBe(false);
    });

    it('returns true when scope suggestions are available', () => {
        expect(shouldShowDropdown(base({ queryLength: 3, scopeSuggestionsCount: 2 }))).toBe(true);
    });

    it('returns false with no query, no scope, and input open (empty focus)', () => {
        expect(shouldShowDropdown(base())).toBe(false);
    });
});
