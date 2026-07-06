/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit — groupEmergentDuplicates (S2.1b, cross-function REST dedup)
 *
 * Emergent REST endpoints are keyed by (method, lossless-path), so a function
 * calling `/users/123` and another calling `/users/456` or `/users/{userId}`
 * land as DISTINCT nodes for one logical endpoint. This pins the grouping that
 * `weldDuplicateEmergentEndpoints` uses to collapse them: same method + same
 * canonical key → one group, survivor = most-templated path.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { groupEmergentDuplicates, type EmergentEndpointRow } from '../../../../src/ingestion/processors/api-path-utils.js';

describe('groupEmergentDuplicates', () => {
    it('collapses literal + named variants of one endpoint, survivor = most templated', () => {
        const rows: EmergentEndpointRow[] = [
            { id: 'cr:endpoint:emergent:GET:/users/123', method: 'GET', path: '/users/123' },
            { id: 'cr:endpoint:emergent:GET:/users/456', method: 'GET', path: '/users/456' },
            { id: 'cr:endpoint:emergent:GET:/users/{userId}', method: 'GET', path: '/users/{userId}' },
        ];
        const groups = groupEmergentDuplicates(rows);
        expect(groups).toHaveLength(1);
        expect(groups[0].survivorId).toBe('cr:endpoint:emergent:GET:/users/{userId}');
        expect(groups[0].loserIds.sort()).toEqual([
            'cr:endpoint:emergent:GET:/users/123',
            'cr:endpoint:emergent:GET:/users/456',
        ]);
    });

    it('does NOT group across different HTTP methods', () => {
        const rows: EmergentEndpointRow[] = [
            { id: 'a', method: 'GET', path: '/users/{id}' },
            { id: 'b', method: 'POST', path: '/users/{id}' },
        ];
        expect(groupEmergentDuplicates(rows)).toHaveLength(0);
    });

    it('does NOT group across different resources', () => {
        const rows: EmergentEndpointRow[] = [
            { id: 'a', method: 'GET', path: '/users/123' },
            { id: 'b', method: 'GET', path: '/orders/123' },
        ];
        expect(groupEmergentDuplicates(rows)).toHaveLength(0);
    });

    it('ignores singletons (nothing to collapse)', () => {
        const rows: EmergentEndpointRow[] = [
            { id: 'a', method: 'GET', path: '/health' },
        ];
        expect(groupEmergentDuplicates(rows)).toHaveLength(0);
    });

    it('all-literal group: survivor is the lexicographically smallest id (deterministic)', () => {
        const rows: EmergentEndpointRow[] = [
            { id: 'z-id', method: 'GET', path: '/orders/999' },
            { id: 'a-id', method: 'GET', path: '/orders/111' },
        ];
        const groups = groupEmergentDuplicates(rows);
        expect(groups).toHaveLength(1);
        expect(groups[0].survivorId).toBe('a-id');
        expect(groups[0].loserIds).toEqual(['z-id']);
    });

    it('collapses ${} / :param / numeric / {name} into one group; pure literal is never survivor', () => {
        const rows: EmergentEndpointRow[] = [
            { id: '1', method: 'GET', path: '/api/orders/${orderId}' },
            { id: '2', method: 'GET', path: '/api/orders/:orderId' },
            { id: '3', method: 'GET', path: '/api/orders/789' },
            { id: '4', method: 'GET', path: '/api/orders/{orderId}' },
        ];
        const groups = groupEmergentDuplicates(rows);
        expect(groups).toHaveLength(1);
        expect(groups[0].loserIds).toHaveLength(3);
        expect(groups[0].loserIds).toContain('3');   // the pure literal is always a loser
        expect(groups[0].survivorId).not.toBe('3');  // survivor is a templated form
    });
});
