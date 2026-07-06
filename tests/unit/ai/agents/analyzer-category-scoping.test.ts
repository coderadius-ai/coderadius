/**
 * Stage 5 — sink-category-scoped responseSchema.
 *
 * A taint-selected function carries its sink categories (from the tainting
 * imports). The responseSchema is scoped to those categories: broker-only infra
 * fields drop when there's no broker, emergent_api_calls drops when there's no
 * HTTP. Field-OMISSION is safe (an absent field can't be given a wrong value),
 * unlike describe-trimming. These tests pin detection + scoping deterministically.
 */
import { describe, it, expect } from 'vitest';
import {
    detectInfraCategories,
    makeScopedAnalysisSchema,
    categorySignature,
    buildAnalyzerInstructions,
} from '../../../../src/ai/agents/unified-analyzer.js';

const commonPrefixLen = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
};

describe('detectInfraCategories', () => {
    const taint = (imports: string) => `--- Taint Context ---\nDirect I/O imports: ${imports}\n--- End ---`;

    it('maps known sink prefixes to categories', () => {
        expect([...(detectInfraCategories(taint('pg, mongoose'))!)]).toEqual(['database']);
        expect([...(detectInfraCategories(taint('amqplib'))!)]).toEqual(['broker']);
        expect([...(detectInfraCategories(taint('axios'))!)]).toEqual(['http']);
        expect([...(detectInfraCategories(taint('ioredis'))!)]).toEqual(['cache']);
    });

    it('collects the superset for multi-sink functions', () => {
        const cats = detectInfraCategories(taint('pg, amqplib'))!;
        expect([...cats].sort()).toEqual(['broker', 'database']);
    });

    it('falls back to full schema (null) on ambiguity or no taint', () => {
        expect(detectInfraCategories(taint('@aws-sdk/client-s3'))).toBeNull(); // polymorphic SDK
        expect(detectInfraCategories(taint('some-unknown-lib'))).toBeNull();   // unknown sink
        expect(detectInfraCategories('no imports line here')).toBeNull();
        expect(detectInfraCategories(undefined)).toBeNull();
    });
});

describe('makeScopedAnalysisSchema — field omission', () => {
    const base = {
        _reasoning: 'r', has_io: true, intent: 'reads orders',
        infrastructure: [{ name: 'orders', type: 'Database', operation: 'READS', evidence: 'SELECT * FROM orders' }],
        capabilities: ['database-reader'],
    };

    it('database-only: drops the 6 broker infra fields and emergent_api_calls', () => {
        const s = makeScopedAnalysisSchema('fast', new Set(['database'] as const));
        const parsed = s.parse({ ...base, emergent_api_calls: [{ method: 'GET', path: '/x' }] }) as Record<string, unknown>;
        // emergent_api_calls is not in the schema → stripped
        expect(parsed.emergent_api_calls).toBeUndefined();
        // infra DB entry survives with evidence
        expect((parsed.infrastructure as Array<{ name: string }>)[0].name).toBe('orders');
        // a broker field on a DB-schema infra item is stripped
        const withBroker = s.parse({ ...base, infrastructure: [{ name: 'orders', type: 'Database', channelKind: 'topic' }] }) as Record<string, unknown>;
        expect((withBroker.infrastructure as Array<Record<string, unknown>>)[0].channelKind).toBeUndefined();
    });

    it('http: includes emergent_api_calls', () => {
        const s = makeScopedAnalysisSchema('fast', new Set(['http'] as const));
        const parsed = s.parse({ ...base, infrastructure: [], emergent_api_calls: [{ method: 'GET', path: '/api/orders/{id}', direction: 'OUTBOUND' }] }) as Record<string, unknown>;
        expect((parsed.emergent_api_calls as unknown[]).length).toBe(1);
    });

    it('broker: keeps channelKind/routingKey on infra items', () => {
        const s = makeScopedAnalysisSchema('fast', new Set(['broker'] as const));
        const parsed = s.parse({ ...base, infrastructure: [{ name: 'order-events', type: 'MessageChannel', operation: 'WRITES', channelKind: 'topic', routingKey: 'order.created' }] }) as Record<string, unknown>;
        const infra = (parsed.infrastructure as Array<Record<string, unknown>>)[0];
        expect(infra.channelKind).toBe('topic');
        expect(infra.routingKey).toBe('order.created');
        // no http → emergent omitted
        expect(parsed.emergent_api_calls).toBeUndefined();
    });

    it('null categories returns the full schema (keeps everything)', () => {
        const s = makeScopedAnalysisSchema('fast', null);
        const parsed = s.parse({ ...base, emergent_api_calls: [{ method: 'GET', path: '/x' }] }) as Record<string, unknown>;
        expect(parsed.emergent_api_calls).toBeDefined();
    });

    it('categorySignature is stable + sorted', () => {
        expect(categorySignature(new Set(['broker', 'database'] as const))).toBe('broker+database');
        expect(categorySignature(null)).toBe('full');
    });
});

describe('buildAnalyzerInstructions — category blocks at the tail (Vertex prefix cacheability)', () => {
    it('two same-(io) prompts differing only by sink category share the stable head through <wrapper_detection>', () => {
        const db = buildAnalyzerInstructions('fast', undefined, true, new Set(['database'] as const));
        const broker = buildAnalyzerInstructions('fast', undefined, true, new Set(['broker'] as const));
        const sharedPrefix = db.slice(0, commonPrefixLen(db, broker));
        // The category-gated blocks must live AFTER every stable block, so the
        // shared prefix reaches the last stable block (wrapper_detection) before
        // the prompts diverge at the category tail. If a gated block sat earlier,
        // the divergence (and thus the cache boundary) would precede it.
        expect(sharedPrefix).toContain('<wrapper_detection>');
    });

    it('the shared prefix covers the bulk of the prompt (>60%), not the old ~first-block boundary', () => {
        const db = buildAnalyzerInstructions('fast', undefined, true, new Set(['database'] as const));
        const broker = buildAnalyzerInstructions('fast', undefined, true, new Set(['broker'] as const));
        const shared = commonPrefixLen(db, broker);
        expect(shared / Math.min(db.length, broker.length)).toBeGreaterThan(0.6);
    });
});
