import { describe, it, expect } from 'vitest';
import {
    isSqlReservedTokenName,
    isUnsafeContainerName,
    isNoisyBrokerName,
} from '../../../../src/ingestion/core/name-safety.js';

// Framework DI-handle shapes (doctrine.*, rabbitmq.producer.*, *_transport)
// are PHP-ecosystem grammar and live in the PHP plugin — see
// tests/unit/ingestion/core/languages/php/framework-di-handles.test.ts.
// This file pins ONLY the language-agnostic predicates: a Node.js Kafka
// topic named `messenger.events.dispatched` must survive these guards.

describe('isSqlReservedTokenName (published SQL reserved words, full-token only)', () => {
    it.each(['from', 'and', 'to', 'limit', 'select', 'where', 'order', 'group', 'join'])(
        'rejects bare reserved word %s', (w) => {
            expect(isSqlReservedTokenName(w)).toBe(true);
            expect(isSqlReservedTokenName(w.toUpperCase())).toBe(true);
        });

    it.each(['operations', 'yesterday', 'order_limit', 'from_address', 'users', 'now', 'storage'])(
        'keeps plausible identifier %s (never substring-match)', (w) => {
            expect(isSqlReservedTokenName(w)).toBe(false);
        });
});

describe('isUnsafeContainerName composition (agnostic guards only)', () => {
    it('rejects SQL reserved tokens and spaced fragments', () => {
        expect(isUnsafeContainerName('from')).toBe(true);
        expect(isUnsafeContainerName('limit')).toBe(true);
        expect(isUnsafeContainerName('select 1')).toBe(true);   // space: not an unquoted identifier
    });

    it('keeps real tables', () => {
        expect(isUnsafeContainerName('acme_orders')).toBe(false);
        expect(isUnsafeContainerName('operations')).toBe(false);
        expect(isUnsafeContainerName('inventory.orders')).toBe(false);
    });

    it('does NOT reject framework-DI-shaped names (plugin-owned grammar, composed by callers)', () => {
        expect(isUnsafeContainerName('doctrine.entitymanager.orm_default')).toBe(false);
    });
});

describe('isNoisyBrokerName (agnostic guards only)', () => {
    it.each(['email', 'message', 'mailer', 'producer', 'websocket', 'websocket-channel', 'message-queue', 'email-service', 'docs'])(
        'rejects generic tech word %s', (n) => {
            expect(isNoisyBrokerName(n)).toBe(true);
        });

    it('rejects spaced fragments and backslash identifiers', () => {
        expect(isNoisyBrokerName('data backbone nest')).toBe(true);
        expect(isNoisyBrokerName('Acme\\Inventory\\OrderOrchestrator')).toBe(true);
    });

    it.each([
        'ha.messenger_normal',                 // real exchange (contains "messenger" but not the DI namespace)
        'ha.emails',
        'renewals',
        'acme.snapshot.ready',
        'acme.catalog.delete.request',
        'order.created.result.preferred',
        'messenger.events.dispatched',         // legitimate topic in a non-PHP ecosystem
        'email_direct_transport',              // *_transport is PHP-plugin grammar, not agnostic shape
    ])('keeps channel name %s (framework grammar is plugin-owned)', (n) => {
        expect(isNoisyBrokerName(n)).toBe(false);
    });
});
