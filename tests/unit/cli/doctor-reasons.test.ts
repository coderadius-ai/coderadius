/**
 * Guards the human-readable copy that `cr doctor` shows operators.
 *
 * Regression target: `broker-candidate@v1` (and the rest of the broker
 * discovery family) had no `REVIEW_REASONS` entry, so every unbound
 * BrokerCandidate fell through to the internal fallback. These assert what
 * the operator SHOULD see — a mapped, actionable reason that names the
 * concrete config knob — so the fix is pinned by what we want, not by the
 * absence of the old text.
 *
 * The `yaml` templates turn the prose suggestion into a paste-ready
 * coderadius.yaml fragment parameterized on the flagged entity's name.
 */
import { describe, it, expect } from 'vitest';
import { REVIEW_REASONS, formatReasons, unmappedReason } from '../../../src/cli/commands/doctor.js';

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

describe('yaml fragments are paste-ready and parameterized on the entity name', () => {
    it('broker family emits a messageBrokers block naming the candidate', () => {
        for (const tag of BROKER_FAMILY_TAGS) {
            const reason = REVIEW_REASONS[tag];
            expect(reason.yaml, `${tag} has no yaml template`).toBeDefined();
            const frag = reason.yaml!('acme-mq');
            expect(frag).toContain('messageBrokers:');
            expect(frag).toContain('acme-mq');
        }
    });

    it('dynamic-routing / low-evidence channels emit a class_routes skeleton', () => {
        for (const tag of ['symfony-messenger-dynamic-routing@v1', 'channel-autopromoter-low-evidence@v1']) {
            const frag = REVIEW_REASONS[tag].yaml!('OrderPlacedEvent');
            expect(frag).toContain('class_routes:');
            expect(frag).toContain('class: OrderPlacedEvent');
            expect(frag).toContain('routing_key:');
        }
    });

    it('ambiguous routing patterns emit an aliases skeleton anchored on the channel name', () => {
        const frag = REVIEW_REASONS['channel-routing-pattern-ambiguous@v1'].yaml!('order.created');
        expect(frag).toContain('aliases:');
        expect(frag).toContain('from: order.created');
        expect(frag).toContain('channelKind:');
    });

    it('prose-only reasons carry no yaml template (schema anchor is informational)', () => {
        expect(REVIEW_REASONS['channel-autopromoter-schema-anchor@v1'].yaml).toBeUndefined();
        expect(REVIEW_REASONS['untagged@v1'].yaml).toBeUndefined();
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
