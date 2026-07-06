import { describe, it, expect } from 'vitest';
import {
    selectPromotionBroker,
    type BrokerBindingRow,
} from '../../../../src/ingestion/processors/channel-autopromoter.js';

// ═════════════════════════════════════════════════════════════════════════════
// Evidence ladder (C4) — pure selection over the channel's CONNECTS_TO rows.
//
//   weak(row)  = via =~ '.*residual.*' AND broker.needsReview   (conjunction)
//   strong     = everything else (config edges INCLUDED, at parity — a
//                conflict between config and another strong source is
//                AMBIGUOUS, never a silent precedence)
//   T2 strong-converged → T3 weak-only fallback (recall preserved, tagged)
// ═════════════════════════════════════════════════════════════════════════════

function row(partial: Partial<BrokerBindingRow> & { urn: string }): BrokerBindingRow {
    return {
        fingerprint: partial.urn.split(':').pop() ?? 'fp',
        via: 'broker-candidate:a1',
        bindSource: 'env-var',
        needsReview: false,
        provider: 'rabbitmq',
        ...partial,
    };
}

const CH = { technology: 'rabbitmq' as string | null };

describe('selectPromotionBroker — strong vs weak', () => {
    it('strong row wins over a weak residual row (weak excluded when strong exists)', () => {
        const strong = row({ urn: 'cr:broker:rabbitmq:a' });
        const weak = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const sel = selectPromotionBroker(CH, [strong, weak]);
        expect(sel).toEqual({ kind: 'promote', broker: strong, weak: false });
    });

    it('weak-only single broker still promotes, flagged weak (recall preserved)', () => {
        const weak = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const sel = selectPromotionBroker(CH, [weak]);
        expect(sel).toEqual({ kind: 'promote', broker: weak, weak: true });
    });

    it('two distinct weak brokers → ambiguous', () => {
        const w1 = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const w2 = row({ urn: 'cr:broker:rabbitmq:c', via: 'broker-candidate:s2-declared-sink-residual', needsReview: true });
        expect(selectPromotionBroker(CH, [w1, w2])).toEqual({ kind: 'ambiguous' });
    });

    it('residual via on a CLEANED broker (needsReview=false) is NOT weak — conjunction pin', () => {
        const cleaned = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:s3-key-name-residual', needsReview: false });
        const weak = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const sel = selectPromotionBroker(CH, [cleaned, weak]);
        expect(sel).toEqual({ kind: 'promote', broker: cleaned, weak: false });
    });

    it('an a1-anchored edge to a needsReview broker is NOT weak (via lacks residual) — conjunction pin', () => {
        const anchored = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:a1', needsReview: true });
        const weak = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const sel = selectPromotionBroker(CH, [anchored, weak]);
        expect(sel).toEqual({ kind: 'promote', broker: anchored, weak: false });
    });
});

describe('selectPromotionBroker — config edges at strong parity (review punto 3)', () => {
    it('config edge alone promotes', () => {
        const config = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:s4-config-declared', bindSource: 'config' });
        expect(selectPromotionBroker(CH, [config])).toEqual({ kind: 'promote', broker: config, weak: false });
    });

    it('config edge + strong env edge to DIFFERENT brokers → AMBIGUOUS, no silent precedence', () => {
        const config = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:s4-config-declared', bindSource: 'config' });
        const strongEnv = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:a2' });
        expect(selectPromotionBroker(CH, [config, strongEnv])).toEqual({ kind: 'ambiguous' });
    });

    it('config edge beats a weak residual to a different broker', () => {
        const config = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:s4-config-declared', bindSource: 'config' });
        const weak = row({ urn: 'cr:broker:rabbitmq:b', via: 'broker-candidate:s3-key-name-residual', needsReview: true });
        const sel = selectPromotionBroker(CH, [config, weak]);
        expect(sel).toEqual({ kind: 'promote', broker: config, weak: false });
    });

    it('config + env edges to the SAME broker collapse to one distinct → promote', () => {
        const config = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:s4-config-declared', bindSource: 'config' });
        const env = row({ urn: 'cr:broker:rabbitmq:a', via: 'broker-candidate:a1' });
        const sel = selectPromotionBroker(CH, [config, env]);
        expect(sel.kind).toBe('promote');
        expect(sel.kind === 'promote' && sel.broker.urn).toBe('cr:broker:rabbitmq:a');
    });
});

describe('selectPromotionBroker — provider/technology compatibility', () => {
    it('filters provider-incompatible rows before ambiguity', () => {
        const kafka = row({ urn: 'cr:broker:kafka:x', provider: 'kafka' });
        const rabbit = row({ urn: 'cr:broker:rabbitmq:a' });
        const sel = selectPromotionBroker({ technology: 'rabbitmq' }, [kafka, rabbit]);
        expect(sel).toEqual({ kind: 'promote', broker: rabbit, weak: false });
    });

    it("'unknown'/null technology passes everything", () => {
        const kafka = row({ urn: 'cr:broker:kafka:x', provider: 'kafka' });
        expect(selectPromotionBroker({ technology: 'unknown' }, [kafka]).kind).toBe('promote');
        expect(selectPromotionBroker({ technology: null }, [kafka]).kind).toBe('promote');
    });

    it("null/'unknown' broker provider passes the filter", () => {
        const anon = row({ urn: 'cr:broker:rabbitmq:a', provider: null });
        expect(selectPromotionBroker({ technology: 'rabbitmq' }, [anon]).kind).toBe('promote');
    });

    it('abstract bus technologies (symfony-messenger) ride ANY physical transport', () => {
        const rabbit = row({ urn: 'cr:broker:rabbitmq:a' });
        expect(selectPromotionBroker({ technology: 'symfony-messenger' }, [rabbit]).kind).toBe('promote');
    });

    it('all rows filtered out → none', () => {
        const kafka = row({ urn: 'cr:broker:kafka:x', provider: 'kafka' });
        expect(selectPromotionBroker({ technology: 'rabbitmq' }, [kafka])).toEqual({ kind: 'none' });
    });
});

describe('selectPromotionBroker — empty input', () => {
    it('no rows → none', () => {
        expect(selectPromotionBroker(CH, [])).toEqual({ kind: 'none' });
    });
});
