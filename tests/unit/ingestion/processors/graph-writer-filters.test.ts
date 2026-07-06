/**
 * Unit Tests — Graph Writer Deterministic Filters
 *
 * Tests the Layer 2 defense filters added to graph-writer.ts:
 *   - DataContainer name pollution filter (Bug 2)
 *   - MessageChannel name pollution filter (Bug 3)
 *   - Noisy endpoint filter (existing, Addendum 3)
 *
 * These filters are the last line of defense — even if the LLM hallucinates
 * polluted names, the graph writer MUST reject them.
 */

import { describe, it, expect } from 'vitest';

// ─── DataContainer Name Pollution Filter (Bug 2) ────────────────────────────────
//
// Regex: /unknown|placeholder/i
// Applied in graph-writer.ts case 'Database'

/** Reproduce the DataContainer pollution filter from graph-writer.ts */
function isDataContainerNamePolluted(name: string): boolean {
    return /unknown|placeholder/i.test(name);
}

describe('DataContainer Name Pollution Filter (Bug 2)', () => {
    it('should reject "database-unknown-db"', () => {
        expect(isDataContainerNamePolluted('database-unknown-db')).toBe(true);
    });

    it('should reject "mysql-unknown-db"', () => {
        expect(isDataContainerNamePolluted('mysql-unknown-db')).toBe(true);
    });

    it('should reject "db-unknown-db"', () => {
        expect(isDataContainerNamePolluted('db-unknown-db')).toBe(true);
    });

    it('should reject "unknown_table"', () => {
        expect(isDataContainerNamePolluted('unknown_table')).toBe(true);
    });

    it('should reject "UNKNOWN-DB"', () => {
        expect(isDataContainerNamePolluted('UNKNOWN-DB')).toBe(true);
    });

    it('should reject names with "placeholder"', () => {
        expect(isDataContainerNamePolluted('placeholder-table')).toBe(true);
    });

    it('should accept legitimate table names', () => {
        expect(isDataContainerNamePolluted('users')).toBe(false);
        expect(isDataContainerNamePolluted('orders')).toBe(false);
        expect(isDataContainerNamePolluted('loyalty_audits')).toBe(false);
        expect(isDataContainerNamePolluted('risk_factors')).toBe(false);
        expect(isDataContainerNamePolluted('trip_quotes')).toBe(false);
        expect(isDataContainerNamePolluted('telemetry')).toBe(false);
    });

    it('should accept table names that happen to contain "own" (substring of unknown)', () => {
        // Regression: make sure we don't over-filter
        expect(isDataContainerNamePolluted('owners')).toBe(false);
        expect(isDataContainerNamePolluted('town_data')).toBe(false);
    });
});

// ─── MessageChannel Name Pollution Filter (Bug 3) ────────────────────────────
//
// Set: NOISY_BROKER_NAMES
// Applied in graph-writer.ts case 'MessageChannel'

/** Reproduce the MessageChannel pollution filter from graph-writer.ts */
function isBrokerNamePolluted(name: string): boolean {
    const NOISY_BROKER_NAMES = new Set([
        'messagebus', 'message-bus', 'message_bus', 'messagebusinterface',
        'bus', 'amqp', 'rabbitmq', 'kafka', 'queue', 'notificationsender',
        'message_bus.sender', 'cmbnotificationsender',
    ]);
    return NOISY_BROKER_NAMES.has(name.toLowerCase());
}

describe('MessageChannel Name Pollution Filter (Bug 3)', () => {
    it('should reject "MessageBus"', () => {
        expect(isBrokerNamePolluted('MessageBus')).toBe(true);
    });

    it('should reject "message-bus"', () => {
        expect(isBrokerNamePolluted('message-bus')).toBe(true);
    });

    it('should reject "message_bus"', () => {
        expect(isBrokerNamePolluted('message_bus')).toBe(true);
    });

    it('should reject "MessageBusInterface"', () => {
        expect(isBrokerNamePolluted('MessageBusInterface')).toBe(true);
    });

    it('should reject "bus"', () => {
        expect(isBrokerNamePolluted('bus')).toBe(true);
    });

    it('should reject "amqp"', () => {
        expect(isBrokerNamePolluted('amqp')).toBe(true);
    });

    it('should reject "rabbitmq"', () => {
        expect(isBrokerNamePolluted('rabbitmq')).toBe(true);
    });

    it('should reject "kafka"', () => {
        expect(isBrokerNamePolluted('kafka')).toBe(true);
    });

    it('should reject "queue"', () => {
        expect(isBrokerNamePolluted('queue')).toBe(true);
    });

    it('should reject "notificationSender" (case-insensitive)', () => {
        expect(isBrokerNamePolluted('notificationSender')).toBe(true);
    });

    it('should reject "cmbNotificationSender" (case-insensitive)', () => {
        expect(isBrokerNamePolluted('cmbNotificationSender')).toBe(true);
    });

    it('should accept legitimate queue/topic names', () => {
        expect(isBrokerNamePolluted('order-events')).toBe(false);
        expect(isBrokerNamePolluted('loyalty_events')).toBe(false);
        expect(isBrokerNamePolluted('orders_exchange')).toBe(false);
        expect(isBrokerNamePolluted('notification.send')).toBe(false);
        expect(isBrokerNamePolluted('booking.confirmed')).toBe(false);
        expect(isBrokerNamePolluted('order.created')).toBe(false);
    });

    it('should accept names that are NOT generic broker technology names', () => {
        // The LLM might use specific exchange names — these are valid
        expect(isBrokerNamePolluted('payment-gateway-exchange')).toBe(false);
        expect(isBrokerNamePolluted('dead-letter-queue-orders')).toBe(false);
    });
});

// ─── Noisy Endpoint Filter (Existing Addendum 3) ────────────────────────────

/** Reproduce the noisy endpoint filter from sanitizer.ts */
function parseGraphQLPath(path: string): { operation: string; operationName: string } | null {
    const m = path.match(/^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+(\S+)$/i);
    if (!m) return null;
    return { operation: m[1].toUpperCase(), operationName: m[2] };
}
function isNoisyEndpoint(path: string): boolean {
    if (path.includes(' ')) {
        const parsed = parseGraphQLPath(path);
        if (!parsed) return true;
        if (parsed.operationName.startsWith('__')) return true; // introspection
        return false; // canonical GQL = legitimate
    }
    if (/^\{[^}]+\}$/.test(path)) return true;
    if (/^https?:\/\/[^/]+\/?$/i.test(path)) return true;
    return false;
}

describe('Noisy Endpoint Filter (Addendum 3)', () => {
    it('should accept canonical GraphQL paths (not noisy — structured identifiers)', () => {
        expect(isNoisyEndpoint('GRAPHQL QUERY getUser')).toBe(false);
        expect(isNoisyEndpoint('GRAPHQL MUTATION createOrder')).toBe(false);
        expect(isNoisyEndpoint('GRAPHQL SUBSCRIPTION onEvent')).toBe(false);
    });

    it('should reject GraphQL introspection paths', () => {
        expect(isNoisyEndpoint('GRAPHQL QUERY __schema')).toBe(true);
        expect(isNoisyEndpoint('GRAPHQL QUERY __type')).toBe(true);
    });

    it('should reject non-canonical paths with spaces', () => {
        expect(isNoisyEndpoint('some random string with spaces')).toBe(true);
        expect(isNoisyEndpoint('GRAPHQL { user { id } }')).toBe(true); // inline body, no op type
    });

    it('should reject pure template variable paths', () => {
        expect(isNoisyEndpoint('{url}')).toBe(true);
        expect(isNoisyEndpoint('{path}')).toBe(true);
        expect(isNoisyEndpoint('{baseUrl}')).toBe(true);
    });

    it('should reject raw URLs without a path', () => {
        expect(isNoisyEndpoint('http://example.com')).toBe(true);
        expect(isNoisyEndpoint('https://api.example.com/')).toBe(true);
    });

    it('should accept legitimate API paths', () => {
        expect(isNoisyEndpoint('/api/v1/charge')).toBe(false);
        expect(isNoisyEndpoint('/api/v2/returns/submit')).toBe(false);
        expect(isNoisyEndpoint('/api/users/{id}')).toBe(false);
        expect(isNoisyEndpoint('/orders/{id}/items')).toBe(false);
        expect(isNoisyEndpoint('/booking-confirmed')).toBe(false);
    });
});


// ─── Unresolved Template Name Filter ────────────────────────────────────────

/** Reproduce the unresolved template name filter from graph-writer.ts */
function isUnresolvedTemplateName(name: string): boolean {
    return /\$\w|\{\$|\$\{|%[sd]/.test(name);
}

describe('Unresolved Template Name Filter (Schema Naming Sanitization)', () => {
    it('should reject PHP template variable names like "loyalty.{$eventType}"', () => {
        expect(isUnresolvedTemplateName('loyalty.{$eventType}')).toBe(true);
    });

    it('should reject PHP variable names like "$tableName"', () => {
        expect(isUnresolvedTemplateName('$tableName')).toBe(true);
    });

    it('should reject JS/TS template literal names like "queue_${name}"', () => {
        expect(isUnresolvedTemplateName('queue_${name}')).toBe(true);
    });

    it('should reject Python format strings like "event_%s"', () => {
        expect(isUnresolvedTemplateName('event_%s')).toBe(true);
    });

    it('should accept legitimate payload names', () => {
        expect(isUnresolvedTemplateName('order.created')).toBe(false);
        expect(isUnresolvedTemplateName('OrderCreatedEvent')).toBe(false);
        expect(isUnresolvedTemplateName('payment-request')).toBe(false);
        expect(isUnresolvedTemplateName('booking.confirmed')).toBe(false);
    });

    it('should accept names with dots (routing keys)', () => {
        expect(isUnresolvedTemplateName('order.context_created')).toBe(false);
        expect(isUnresolvedTemplateName('notification.send')).toBe(false);
    });
});

// ─── Combined Database Filter (Real-World Acme Core Hallucinations) ────────

/** Reproduce the combined Database infra filter from graph-writer.ts */
function shouldRejectDatabaseName(name: string): boolean {
    return /unknown|placeholder/i.test(name) || isUnresolvedTemplateName(name);
}

describe('Combined Database Infra Filter (Acme Core Dynamic Table Names)', () => {
    it('should reject PHP variable interpolation', () => {
        expect(shouldRejectDatabaseName('delivery_history_$type')).toBe(true);
        expect(shouldRejectDatabaseName('delivery_history_{$tipo}')).toBe(true);
    });

    it('should reject unknown/placeholder names', () => {
        expect(shouldRejectDatabaseName('unknown_table')).toBe(true);
        expect(shouldRejectDatabaseName('placeholder-db')).toBe(true);
    });

    it('should accept the three known concrete tables', () => {
        expect(shouldRejectDatabaseName('delivery_history_auto')).toBe(false);
        expect(shouldRejectDatabaseName('delivery_history_moto')).toBe(false);
        expect(shouldRejectDatabaseName('delivery_history_autocarro')).toBe(false);
    });

    it('should accept other legitimate table names', () => {
        expect(shouldRejectDatabaseName('delivery_result')).toBe(false);
        expect(shouldRejectDatabaseName('delivery_result_moto')).toBe(false);
        expect(shouldRejectDatabaseName('cached_query_result')).toBe(false);
        expect(shouldRejectDatabaseName('quotation_results')).toBe(false);
        expect(shouldRejectDatabaseName('comuni_soppressi')).toBe(false);
    });
});
