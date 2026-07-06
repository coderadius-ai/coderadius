/**
 * Documents the field-fingerprint logic used in graph-writer.ts to dedup
 * the same body emitted both as `emergent_api_calls[*].payload_schema` and
 * as `produced_payloads[*]` by the LLM (orchestrator /renewals bug).
 *
 * The fingerprint is `sorted(field.name).join('|')`. Two payloads with the
 * same set of field names (in any order) share a fingerprint.
 */

import { describe, it, expect } from 'vitest';

// Mirror of the inline helper in graph-writer.ts:persistFunction
function payloadFieldFingerprint(fields: Array<{ name?: string }> | undefined): string {
    return (fields ?? []).map(f => f.name ?? '').sort().join('|');
}

describe('payloadFieldFingerprint', () => {
    it('returns identical fingerprints for same field-set, any order', () => {
        const a = payloadFieldFingerprint([{ name: 'id' }, { name: 'amount' }, { name: 'currency' }]);
        const b = payloadFieldFingerprint([{ name: 'currency' }, { name: 'amount' }, { name: 'id' }]);
        expect(a).toBe(b);
    });

    it('distinguishes different field-sets', () => {
        const a = payloadFieldFingerprint([{ name: 'renewals' }]);
        const b = payloadFieldFingerprint([{ name: 'orderId' }]);
        expect(a).not.toBe(b);
    });

    it('orchestrator /renewals: payload_schema and produced_payloads share fingerprint', () => {
        // What unified-analyzer emitted: same body in two places.
        const payloadSchema = [{ name: 'renewals', type: 'Array<ShipmentProposal>' }];
        const producedPayload = { name: 'renewals', fields: [{ name: 'renewals', type: 'Array<ShipmentProposal>' }] };
        const fpA = payloadFieldFingerprint(payloadSchema);
        const fpB = payloadFieldFingerprint(producedPayload.fields);
        expect(fpA).toBe(fpB);
        expect(fpA).toBe('renewals');  // sanity
    });

    it('empty / missing fields → empty fingerprint', () => {
        expect(payloadFieldFingerprint(undefined)).toBe('');
        expect(payloadFieldFingerprint([])).toBe('');
    });
});
