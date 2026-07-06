/**
 * Unit Tests — deterministicTeamMatch
 *
 * Tests the Level 1 zero-LLM team alias resolver.
 * Zero I/O calls — CI-safe, runs in <5ms.
 */
import { describe, it, expect } from 'vitest';
import { deterministicTeamMatch } from '../../../../src/ingestion/extractors/team-alias-resolver.js';

const KNOWN_TEAMS = [
    'payments',
    'frontend-core',
    'data-analytics',
    'platform',
    'sre',
    'checkout',
    'identity',
];

describe('deterministicTeamMatch', () => {

    describe('Exact match', () => {
        it('matches exactly (case-insensitive)', () => {
            expect(deterministicTeamMatch('payments', KNOWN_TEAMS)).toBe('payments');
        });

        it('matches case-insensitively: "Payments" → "payments"', () => {
            expect(deterministicTeamMatch('Payments', KNOWN_TEAMS)).toBe('payments');
        });
    });

    describe('Suffix matching (IT prefix stripping)', () => {
        it('"it-dev-payments" → "payments" (classic IT namespace prefix)', () => {
            expect(deterministicTeamMatch('it-dev-payments', KNOWN_TEAMS)).toBe('payments');
        });

        it('"acme-payments" → "payments"', () => {
            expect(deterministicTeamMatch('acme-payments', KNOWN_TEAMS)).toBe('payments');
        });

        it('"org/payments" → "payments" (slash delimiter)', () => {
            expect(deterministicTeamMatch('org/payments', KNOWN_TEAMS)).toBe('payments');
        });
    });

    describe('Prefix matching (suffix stripping)', () => {
        it('"payments-squad" → "payments"', () => {
            expect(deterministicTeamMatch('payments-squad', KNOWN_TEAMS)).toBe('payments');
        });

        it('"checkout-team" → "checkout"', () => {
            expect(deterministicTeamMatch('checkout-team', KNOWN_TEAMS)).toBe('checkout');
        });

        it('"platform-engineering" → "platform"', () => {
            expect(deterministicTeamMatch('platform-engineering', KNOWN_TEAMS)).toBe('platform');
        });
    });

    describe('Middle-segment matching (> 4 chars only)', () => {
        it('"acme-payments-v2" → "payments" (bounded both sides)', () => {
            expect(deterministicTeamMatch('acme-payments-v2', KNOWN_TEAMS)).toBe('payments');
        });

        it('"group-checkout-eu" → "checkout"', () => {
            expect(deterministicTeamMatch('group-checkout-eu', KNOWN_TEAMS)).toBe('checkout');
        });

        it('"x-sre-y" does NOT match "sre" (too short, ≤4 chars — excluded from middle match)', () => {
            // sre is 3 chars → middle-segment rule requires > 4 chars.
            // This prevents accidentally matching short tokens.
            // Result: null (passed to LLM batch)
            expect(deterministicTeamMatch('x-sre-y', KNOWN_TEAMS)).toBeNull();
        });
    });

    describe('No false positives', () => {
        it('"payment-processor" does NOT match "payments" (no whole-word boundary)', () => {
            // "payment" ≠ "payments" — the team name must appear whole
            expect(deterministicTeamMatch('payment-processor', KNOWN_TEAMS)).toBeNull();
        });

        it('"frontend" does NOT match "frontend-core" (prefix yes, but reversed direction)', () => {
            // "frontend-core" is the team. "frontend" alone is not a match:
            // it does not CONTAIN "-frontend-core-" nor end with "-frontend-core"
            expect(deterministicTeamMatch('frontend', KNOWN_TEAMS)).toBeNull();
        });

        it('"sre-ops" DOES match "sre" via prefix rule (starts with "sre-")', () => {
            // The > 4 chars limit applies ONLY to middle-segment matching ("x-sre-y").
            // Prefix/suffix matching has no length restriction — "sre-ops" starts with "sre-".
            // This is intentional: sre is an unambiguous team name as a prefix.
            expect(deterministicTeamMatch('sre-ops', KNOWN_TEAMS)).toBe('sre');
        });

        it('completely unrelated name returns null', () => {
            expect(deterministicTeamMatch('marketing-brand', KNOWN_TEAMS)).toBeNull();
        });

        it('empty phantom returns null', () => {
            expect(deterministicTeamMatch('', KNOWN_TEAMS)).toBeNull();
        });

        it('team name of length 1 is skipped (too short to match safely)', () => {
            const teamsWithShort = [...KNOWN_TEAMS, 'a'];
            expect(deterministicTeamMatch('acme-a-group', teamsWithShort)).toBeNull();
        });
    });

    describe('Real-world enterprise patterns', () => {
        it('"acme-it-payments" → "payments"', () => {
            expect(deterministicTeamMatch('acme-it-payments', KNOWN_TEAMS)).toBe('payments');
        });

        it('"squads-checkout" → "checkout"', () => {
            expect(deterministicTeamMatch('squads-checkout', KNOWN_TEAMS)).toBe('checkout');
        });

        it('"be-identity" → "identity"', () => {
            expect(deterministicTeamMatch('be-identity', KNOWN_TEAMS)).toBe('identity');
        });

        it('"data-analytics-platform" → "data-analytics" (prefix match, longer team name wins)', () => {
            // "data-analytics" starts with "data-analytics" and is followed by "-"
            expect(deterministicTeamMatch('data-analytics-platform', KNOWN_TEAMS)).toBe('data-analytics');
        });
    });

    describe('Overlapping team names (length-descending sort)', () => {
        // Real-world scenario: three teams whose names are prefixes of each other.
        // Without sorting by length descending, "org-dev-plat" would greedily match
        // phantoms that should go to "org-dev-plat-external" or "org-dev-plat-dx".
        const OVERLAPPING_TEAMS = [
            'org-dev-plat',
            'org-dev-plat-external',
            'org-dev-plat-dx',
        ];

        it('each team matches itself exactly', () => {
            expect(deterministicTeamMatch('org-dev-plat', OVERLAPPING_TEAMS)).toBe('org-dev-plat');
            expect(deterministicTeamMatch('org-dev-plat-external', OVERLAPPING_TEAMS)).toBe('org-dev-plat-external');
            expect(deterministicTeamMatch('org-dev-plat-dx', OVERLAPPING_TEAMS)).toBe('org-dev-plat-dx');
        });

        it('phantom with suffix maps to the MOST SPECIFIC team, not the shortest', () => {
            // "it-org-dev-plat-external" should map to "org-dev-plat-external" (21 chars),
            // NOT "org-dev-plat" (12 chars) — even though both are valid suffix matches.
            expect(deterministicTeamMatch('it-org-dev-plat-external', OVERLAPPING_TEAMS)).toBe('org-dev-plat-external');
        });

        it('"acme-org-dev-plat-dx" → "org-dev-plat-dx" (not "org-dev-plat")', () => {
            expect(deterministicTeamMatch('acme-org-dev-plat-dx', OVERLAPPING_TEAMS)).toBe('org-dev-plat-dx');
        });

        it('"acme-org-dev-plat" → "org-dev-plat" (exact suffix, no ambiguity)', () => {
            expect(deterministicTeamMatch('acme-org-dev-plat', OVERLAPPING_TEAMS)).toBe('org-dev-plat');
        });

        it('phantom with unknown suffix resolves to base team via prefix rule', () => {
            // "org-dev-plat-squad" starts with "org-dev-plat-" but NOT with
            // "org-dev-plat-external-" or "org-dev-plat-dx-".
            // Result: "org-dev-plat" via prefix rule.
            expect(deterministicTeamMatch('org-dev-plat-squad', OVERLAPPING_TEAMS)).toBe('org-dev-plat');
        });

        it('completely unrelated phantom returns null', () => {
            expect(deterministicTeamMatch('marketing-team', OVERLAPPING_TEAMS)).toBeNull();
        });
    });
});
