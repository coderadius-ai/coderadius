import { describe, it, expect } from 'vitest';
import {
    selectPromotableDatastores,
    matchesDatastoreClient,
} from '../../../../src/ingestion/processors/datastore-promotion.js';
import type { DatastoreIdentity } from '../../../../src/ingestion/processors/db-scope-resolver.js';
import type { PhysicalEndpointHint } from '../../../../src/ingestion/processors/connection-extractors/types.js';

// Standalone promotion is the recall fix for datastores whose I/O function is
// dropped (e.g. InfluxDB via a wrapper). It MUST NOT blindly promote a tech-named
// connection: the high-confidence gate is (datastore-family tech) AND (a declared
// client library OR an unambiguous datastore DSN scheme). A bare host/URL with no
// client library and no datastore scheme is refused — that is the FP guard.

function identity(over: Partial<PhysicalEndpointHint> & { technology: string }): DatastoreIdentity {
    const canonicalHint: PhysicalEndpointHint = {
        host: 'h', port: 0, dbName: 'd', confidence: 'medium',
        templateSyntax: 'none', sourceFile: 'config', ...over,
    };
    return { identityKey: over.technology + ':' + (over.host ?? 'h'), canonicalHint, environments: [] };
}

const has = (ids: DatastoreIdentity[], tech: string) => ids.some(i => i.canonicalHint.technology === tech);

describe('selectPromotableDatastores (high-confidence gate / FP guard)', () => {
    it('promotes a datastore-family tech corroborated by a declared client library', () => {
        const ids = [identity({ technology: 'influxdb', host: 'influxdb', port: 8086 })];
        const out = selectPromotableDatastores(ids, new Set(['@influxdata/influxdb-client']));
        expect(has(out, 'influxdb')).toBe(true);
    });

    it('REFUSES a tech-named connection with no client library and no DSN scheme (FP guard)', () => {
        const ids = [identity({ technology: 'influxdb', host: 'influxdb', port: 8086 })];
        const out = selectPromotableDatastores(ids, new Set(['symfony/runtime', 'guzzlehttp/guzzle']));
        expect(out).toHaveLength(0);
    });

    it('promotes an unambiguous datastore DSN scheme even without a declared client', () => {
        const ids = [identity({ technology: 'mysql', host: 'db', port: 3306, viaDsnScheme: true })];
        const out = selectPromotableDatastores(ids, new Set());
        expect(has(out, 'mysql')).toBe(true);
    });

    it('REFUSES a non-datastore family (broker) even with a client library', () => {
        const ids = [identity({ technology: 'rabbitmq', host: 'rabbit', port: 5672 })];
        const out = selectPromotableDatastores(ids, new Set(['php-amqplib/php-amqplib']));
        expect(out).toHaveLength(0);
    });

    it('REFUSES an unknown technology', () => {
        const ids = [identity({ technology: 'mystery', host: 'x', port: 1234, viaDsnScheme: true })];
        const out = selectPromotableDatastores(ids, new Set(['some/client']));
        expect(out).toHaveLength(0);
    });

    it('matchesDatastoreClient maps influxdb to its PHP and npm clients', () => {
        expect(matchesDatastoreClient('influxdb', new Set(['influxdb/influxdb-php']))).toBe(true);
        expect(matchesDatastoreClient('influxdb', new Set(['@influxdata/influxdb-client']))).toBe(true);
        expect(matchesDatastoreClient('influxdb', new Set(['influx']))).toBe(true);
        expect(matchesDatastoreClient('influxdb', new Set(['unrelated/pkg']))).toBe(false);
    });
});
