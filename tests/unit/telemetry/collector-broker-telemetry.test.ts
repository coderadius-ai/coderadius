/**
 * Unit Tests — Broker discovery negative telemetry rows.
 *
 * The candidate ledger's whole point is that broker-ish evidence which cannot
 * be grounded stays VISIBLE: unbound candidates and guess-only bindings must
 * surface as funnel rows (and in `cr doctor` via NEEDS_REVIEW_LABELS).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NEEDS_REVIEW_LABELS, INFERRED_NODE_LABELS } from '../../../src/graph/queries/grounding.js';

let collector: any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(async () => {
    const mod = await import('../../../src/telemetry/collector.js');
    collector = mod.telemetryCollector;
    collector.reset();
});

describe('Broker discovery negative telemetry', () => {
    it('tracks unbound candidates and guess-only bindings independently', () => {
        collector.addBrokerCandidatesUnbound(3);
        collector.addBrokerGuessOnlyBindings(2);
        const f = collector.getFunnel();
        expect(f.brokerCandidatesUnbound).toBe(3);
        expect(f.brokerGuessOnlyBindings).toBe(2);
    });

    it('resets with the rest of the funnel', () => {
        collector.addBrokerCandidatesUnbound(1);
        collector.addBrokerGuessOnlyBindings(1);
        collector.reset();
        const f = collector.getFunnel();
        expect(f.brokerCandidatesUnbound).toBe(0);
        expect(f.brokerGuessOnlyBindings).toBe(0);
    });

    it('prints both rows in the funnel report when non-zero', () => {
        // The funnel section renders when pipeline activity exists.
        collector.incrementTotalFunctionsParsed(5);
        collector.addBrokerCandidatesUnbound(4);
        collector.addBrokerGuessOnlyBindings(2);
        const report = stripAnsi(collector.generateFunnelReport());
        expect(report).toContain('Broker Candidates Unbound');
        expect(report).toContain('4');
        expect(report).toContain('Broker Guess-only Bindings');
        expect(report).toContain('2');
    });

    it('omits both rows when zero (no noise)', () => {
        collector.incrementTotalFunctionsParsed(5);
        const report = stripAnsi(collector.generateFunnelReport());
        expect(report).not.toContain('Broker Candidates Unbound');
        expect(report).not.toContain('Broker Guess-only Bindings');
    });
});

describe('NEEDS_REVIEW_LABELS — broker discovery review surface', () => {
    it('includes MessageBroker and BrokerCandidate so cr doctor sees them', () => {
        expect(NEEDS_REVIEW_LABELS).toContain('MessageBroker');
        expect(NEEDS_REVIEW_LABELS).toContain('BrokerCandidate');
    });

    it('does NOT widen the quality-breakdown label set (aggregate stays focused)', () => {
        expect(INFERRED_NODE_LABELS).not.toContain('MessageBroker');
        expect(INFERRED_NODE_LABELS).not.toContain('BrokerCandidate');
    });
});
