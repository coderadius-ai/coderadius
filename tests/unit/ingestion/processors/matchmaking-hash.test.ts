/**
 * Unit Tests — matchmaking idempotency hash
 *
 * The matchmaker skips a service when the (functions, endpoints) state hash
 * matches the one stored on the Service node. Memgraph returns rows in
 * storage order (no ORDER BY), and any write reshuffles it, so the hash MUST
 * be order-independent — otherwise a no-op resync re-runs the full LLM
 * matchmaking on identical content (observed: 3 consecutive runs of the same repo,
 * the second re-spent 11,391 input tokens on byte-identical candidates).
 */

import { describe, it, expect } from 'vitest';
import { computeMatchmakingStateHash } from '../../../../src/ingestion/processors/matchmaking.js';

const fnA = { urn: 'cr:function:acme:a', name: 'createOrder', intent: 'creates an order', embedding: [0.1, 0.2] };
const fnB = { urn: 'cr:function:acme:b', name: 'getOrder', intent: 'reads an order', embedding: [0.3, 0.4] };
const epX = { urn: 'cr:endpoint:acme:x', path: '/orders', method: 'POST', operationId: 'createOrder', summary: null, embedding: null };
const epY = { urn: 'cr:endpoint:acme:y', path: '/orders/{id}', method: 'GET', operationId: 'getOrder', summary: null, embedding: null };

describe('computeMatchmakingStateHash()', () => {
    it('is invariant to row order (the DB gives no ordering guarantee)', () => {
        const h1 = computeMatchmakingStateHash([fnA, fnB], [epX, epY]);
        const h2 = computeMatchmakingStateHash([fnB, fnA], [epY, epX]);
        expect(h1).toBe(h2);
    });

    it('changes when candidate content changes', () => {
        const h1 = computeMatchmakingStateHash([fnA, fnB], [epX, epY]);
        const h2 = computeMatchmakingStateHash(
            [{ ...fnA, intent: 'creates an order AND notifies' }, fnB],
            [epX, epY],
        );
        expect(h1).not.toBe(h2);
    });

    it('changes when a candidate is added or removed', () => {
        const h1 = computeMatchmakingStateHash([fnA, fnB], [epX, epY]);
        const h2 = computeMatchmakingStateHash([fnA], [epX, epY]);
        expect(h1).not.toBe(h2);
    });

    it('does not mutate its inputs', () => {
        const functions = [fnB, fnA];
        const endpoints = [epY, epX];
        computeMatchmakingStateHash(functions, endpoints);
        expect(functions[0]).toBe(fnB);
        expect(endpoints[0]).toBe(epY);
    });
});
