import { describe, it, expect } from 'vitest';
import {
    interpretPayloads,
    type PayloadsInterpretContext,
} from '../../../src/ingestion/processors/code-pipeline/interpret/payloads.js';

// interpretPayloads pins the produced/consumed payload + ORM entity
// sections of persistFunction — AST/LLM merge tagging, opaque governance,
// template-name and fingerprint guards, deep-scan field materialisation.

function ctx(over: Partial<PayloadsInterpretContext> = {}): PayloadsInterpretContext {
    return {
        functionName: 'createOrder',
        relativePath: 'src/orders.ts',
        isDeepScan: false,
        writtenFingerprints: new Set<string>(),
        ...over,
    };
}

const orderPayload = { name: 'OrderCreated', fields: [{ name: 'orderId', type: 'string' }] };

describe('interpretPayloads — produced and consumed', () => {
    it('LLM-only produced payload → produces intent, llm grounding, stub fields on fast scan', () => {
        const { schemas, telemetry } = interpretPayloads({ produced: [orderPayload] }, ctx());
        expect(schemas).toEqual([{
            kind: 'payload',
            schemaName: 'OrderCreated',
            fields: [],
            link: 'produces',
            isOpaque: false,
            withFieldLineage: false,
            grounding: expect.objectContaining({ source: 'llm' }),
        }]);
        expect(telemetry).toEqual({ astResolved: 0, astLlmConverged: 0, llmOnly: 1 });
    });

    it('consumed payloads link as consumes; deep scan materialises fields and enables lineage', () => {
        const { schemas } = interpretPayloads({ consumed: [orderPayload] }, ctx({ isDeepScan: true }));
        expect(schemas[0]).toMatchObject({
            link: 'consumes',
            fields: [{ name: 'orderId', type: 'string', required: true }],
            withFieldLineage: true,
        });
    });

    it('AST-resolved payloads pass through with ast grounding; AST+LLM convergence is composite', () => {
        const ast = [{
            basename: 'OrderCreated',
            direction: 'produced' as const,
            fields: [{ name: 'orderId', type: 'string' }, { name: 'total', type: 'number' }],
        }];
        const { schemas, telemetry } = interpretPayloads(
            { produced: [orderPayload], astResolved: ast as never },
            ctx(),
        );
        expect(schemas[0].grounding.source).toBe('composite');
        expect(telemetry.astLlmConverged).toBe(1);

        const astOnly = interpretPayloads({ astResolved: ast as never }, ctx());
        expect(astOnly.schemas[0].grounding.source).toBe('ast');
        expect(astOnly.telemetry.astResolved).toBe(1);
    });

    it('opaque payloads emit the governance warning; opaque-only persists as a stub without lineage', () => {
        const opaqueOnly = { name: 'PassThrough', fields: [{ name: '_opaque_reference', type: 'unknown' }] };
        const { schemas, logs } = interpretPayloads({ produced: [opaqueOnly] }, ctx({ isDeepScan: true }));
        expect(logs.some(l => l.level === 'warn' && l.message.includes('Opaque I/O Payload'))).toBe(true);
        expect(logs.some(l => l.level === 'info' && l.message.includes('opaque-only'))).toBe(true);
        expect(schemas[0]).toMatchObject({ isOpaque: true, fields: [], withFieldLineage: false });
    });

    it('skips templated names and fingerprint duplicates of already-written request bodies', () => {
        const dupe = { name: 'OrderBody', fields: [{ name: 'b', type: 's' }, { name: 'a', type: 's' }] };
        const { schemas, logs, telemetry } = interpretPayloads(
            { produced: [{ name: '${dynamic}Payload', fields: [{ name: 'x', type: 's' }] }, dupe] },
            ctx({ writtenFingerprints: new Set(['a|b']) }),
        );
        expect(schemas).toEqual([]);
        expect(logs.some(l => l.message.includes('unresolved template name'))).toBe(true);
        expect(logs.some(l => l.message.includes('duplicate of payload_schema'))).toBe(true);
        // Telemetry counts ALL merged payloads, including later-skipped ones.
        expect(telemetry.llmOnly).toBe(2);
    });
});

describe('interpretPayloads — ORM entity schemas', () => {
    it('entity schemas become database_table intents with static ORM grounding', () => {
        const { schemas } = interpretPayloads(
            { entitySchemas: [{ name: 'orders', fields: [{ name: 'id', type: 'uuid', required: true }] }] },
            ctx(),
        );
        expect(schemas).toEqual([{
            kind: 'entity-table',
            schemaName: 'orders',
            fields: [{ name: 'id', type: 'uuid', required: true }],
            grounding: expect.objectContaining({ source: 'ast' }),
        }]);
    });
});
