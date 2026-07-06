/**
 * Guards the human-readable copy that `cr review pending` shows operators.
 *
 * Regression target: `broker-candidate@v1` (and the rest of the broker
 * discovery family) had no `REVIEW_REASONS` entry, so every unbound
 * BrokerCandidate fell through to the internal fallback. These assert what
 * the operator SHOULD see — a mapped, actionable reason that names the
 * concrete config knob — so the fix is pinned by what we want, not by the
 * absence of the old text.
 */
import { describe, it, expect } from 'vitest';
import { REVIEW_REASONS, formatReasons, unmappedReason } from '../../../src/cli/commands/review.js';

/** Tags stamped on `needsReview = true` nodes that the operator can actually act on. */
const BROKER_FAMILY_TAGS = [
    'broker-candidate@v1',
    'broker-candidate-convergence@v1',
    'broker-candidate-declared@v1',
];

describe('REVIEW_REASONS gives broker candidates an actionable reason', () => {
    it('points the operator at the messageBrokers config knob for broker-candidate@v1', () => {
        const reason = REVIEW_REASONS['broker-candidate@v1'];
        expect(reason).toBeDefined();
        expect(reason.label.length).toBeGreaterThan(0);
        expect(reason.suggestion).toContain('coderadius.yaml.messageBrokers');
    });

    it('resolves the whole broker discovery family through formatReasons, not the fallback', () => {
        for (const tag of BROKER_FAMILY_TAGS) {
            const reasons = formatReasons([tag]);
            expect(reasons, `${tag} has no mapped reason`).toHaveLength(1);
            expect(reasons[0].suggestion).toContain('coderadius.yaml.messageBrokers');
        }
    });

    it('formatReasons returns the mapped reason object verbatim', () => {
        expect(formatReasons(['broker-candidate@v1'])).toEqual([REVIEW_REASONS['broker-candidate@v1']]);
    });

    it('formatReasons returns nothing for an unmapped tag (so the caller falls back)', () => {
        expect(formatReasons(['totally-unknown@v9'])).toEqual([]);
    });
});

describe('unmappedReason fallback', () => {
    it('surfaces the raw tag as a support reference under an actionable label', () => {
        const reason = unmappedReason(['channel-autopromoter-weak-broker@v1']);
        expect(reason.label.length).toBeGreaterThan(0);
        // The operator can keep/override; support can still correlate the tag.
        expect(reason.suggestion).toContain('channel-autopromoter-weak-broker@v1');
    });

    it('joins multiple tags into one reference', () => {
        const reason = unmappedReason(['a@v1', 'b@v1']);
        expect(reason.suggestion).toContain('a@v1, b@v1');
    });
});
