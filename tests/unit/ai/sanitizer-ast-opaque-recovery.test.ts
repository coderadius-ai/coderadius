/**
 * Phase 2 (Fix #3) — sanitizer AST opaque-recovery.
 *
 * When the LLM emits `_opaque_reference` for a payload AND the AST has
 * walked the literal class definition, the sanitizer should overwrite the
 * opaque fields with the AST-resolved ones. Match is direct on `basename`.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';

describe('sanitizer AST opaque-recovery', () => {
    it('replaces _opaque_reference fields on produced payload when AST resolves the basename', () => {
        const analysis: any = {
            has_io: true,
            intent: 'dispatches a renewal request',
            infrastructure: [],
            capabilities: [],
            emergent_api_calls: [],
            produced_payloads: [
                {
                    name: 'RenewalRequest',
                    fields: [{ name: '_opaque_reference', type: 'object' }],
                },
            ],
            consumed_payloads: [],
        };
        const out = sanitizeAnalysis(analysis, {
            astResolvedPayloads: [
                {
                    direction: 'produced',
                    basename: 'RenewalRequest',
                    fields: [
                        { name: 'renewalId', type: 'string' },
                        { name: 'customerId', type: 'int' },
                    ],
                },
            ],
        });
        expect(out.produced_payloads).toHaveLength(1);
        expect(out.produced_payloads![0].fields).toEqual([
            { name: 'renewalId', type: 'string', required: true },
            { name: 'customerId', type: 'int', required: true },
        ]);
    });

    it('replaces _opaque_reference fields on consumed payload symmetrically', () => {
        const analysis: any = {
            has_io: true,
            intent: 'consumes a payload',
            infrastructure: [],
            capabilities: [],
            emergent_api_calls: [],
            produced_payloads: [],
            consumed_payloads: [
                {
                    name: 'ShipmentProposal',
                    fields: [{ name: '_opaque_reference', type: 'object' }],
                },
            ],
        };
        const out = sanitizeAnalysis(analysis, {
            astResolvedPayloads: [
                {
                    direction: 'consumed',
                    basename: 'ShipmentProposal',
                    fields: [{ name: 'amount', type: 'int' }],
                },
            ],
        });
        expect(out.consumed_payloads![0].fields).toEqual([
            { name: 'amount', type: 'int', required: true },
        ]);
    });

    it('leaves payload untouched when no AST match exists for the basename', () => {
        const analysis: any = {
            has_io: true,
            intent: 'opaque',
            infrastructure: [],
            capabilities: [],
            emergent_api_calls: [],
            produced_payloads: [
                {
                    name: 'UnknownPayload',
                    fields: [{ name: '_opaque_reference', type: 'object' }],
                },
            ],
            consumed_payloads: [],
        };
        const out = sanitizeAnalysis(analysis, {
            astResolvedPayloads: [
                {
                    direction: 'produced',
                    basename: 'DifferentName',
                    fields: [{ name: 'id', type: 'string' }],
                },
            ],
        });
        expect(out.produced_payloads![0].fields).toEqual([
            { name: '_opaque_reference', type: 'object' },
        ]);
    });

    it('does not touch payloads without `_opaque_reference` marker', () => {
        const analysis: any = {
            has_io: true,
            intent: 'concrete',
            infrastructure: [],
            capabilities: [],
            emergent_api_calls: [],
            produced_payloads: [
                {
                    name: 'OrderEvent',
                    fields: [
                        { name: 'orderId', type: 'string' },
                        { name: 'total', type: 'number' },
                    ],
                },
            ],
            consumed_payloads: [],
        };
        const out = sanitizeAnalysis(analysis, {
            astResolvedPayloads: [
                {
                    direction: 'produced',
                    basename: 'OrderEvent',
                    fields: [
                        { name: 'WRONG', type: 'string' },
                    ],
                },
            ],
        });
        // Non-opaque payloads are NOT recovered — they pass through unchanged.
        expect(out.produced_payloads![0].fields).toEqual([
            { name: 'orderId', type: 'string' },
            { name: 'total', type: 'number' },
        ]);
    });

    it('does not cross directions (produced AST does not recover consumed opaque)', () => {
        const analysis: any = {
            has_io: true,
            intent: 'mismatch',
            infrastructure: [],
            capabilities: [],
            emergent_api_calls: [],
            produced_payloads: [],
            consumed_payloads: [
                {
                    name: 'RenewalRequest',
                    fields: [{ name: '_opaque_reference', type: 'object' }],
                },
            ],
        };
        const out = sanitizeAnalysis(analysis, {
            astResolvedPayloads: [
                {
                    direction: 'produced',
                    basename: 'RenewalRequest',
                    fields: [{ name: 'id', type: 'string' }],
                },
            ],
        });
        // produced AST does not match consumed payload → fields stay opaque.
        expect(out.consumed_payloads![0].fields).toEqual([
            { name: '_opaque_reference', type: 'object' },
        ]);
    });
});
