/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-influxdb-datastore
 *
 * TypeScript counterpart to php-influxdb-datastore. A TS service uses the
 * InfluxDB v2 client (`@influxdata/influxdb-client`) configured with a SINGLE
 * connection URL (`INFLUXDB_URL=http://influxdb:8086`) read from process.env —
 * the dominant modern TS shape. There is no host/port trio and no ORM entity,
 * so the datastore must be recovered from the connection URL keyed on the env
 * var NAME (the http scheme alone is not enough to identify the technology).
 *
 * A datastore FN here is a blast-radius safety break, so the influx URL must be
 * classified as a `timeseries` datastore while the standard postgres:// DSN
 * contrast is unaffected.
 *
 * Full deterministic path: real files → loadRepoContext (extractAllPhysicalHints
 * → canonicalizeDatastoreIdentities). Zero LLM, zero graph DB.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { loadRepoContext, clearRepoContextCache } from '../../../../src/config/repo-context.js';
import { familyForTechnology } from '../../../../src/ingestion/processors/db-scope-resolver.js';
import { selectPromotableDatastores, readDeclaredPackages } from '../../../../src/ingestion/processors/datastore-promotion.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-influxdb-datastore', () => {
    let ctx: ReturnType<typeof loadRepoContext>;

    beforeAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
        ctx = loadRepoContext(FIXTURE_DIR);
    });

    afterAll(() => {
        clearRepoContextCache(FIXTURE_DIR);
    });

    it('influxdb resolves to the timeseries family', () => {
        expect(familyForTechnology('influxdb')).toBe('timeseries');
    });

    it('recovers an InfluxDB datastore from the v2 INFLUXDB_URL connection', () => {
        const influx = ctx.identities.find(id => id.canonicalHint.technology === 'influxdb');
        expect(influx, 'an influxdb identity must be recovered from INFLUXDB_URL').toBeDefined();
        expect(influx!.canonicalHint.host).toBe('influxdb');
        expect(influx!.canonicalHint.port).toBe(8086);
    });

    it('selectivity: the postgres contrast (DATABASE_URL) coexists', () => {
        const techs = new Set(ctx.identities.map(id => id.canonicalHint.technology));
        expect(techs.has('influxdb')).toBe(true);
        expect(techs.has('postgres')).toBe(true);
    });

    it('the InfluxDB identity clears the high-confidence promotion gate (client lib declared)', () => {
        const pkgs = readDeclaredPackages(FIXTURE_DIR);  // package.json has @influxdata/influxdb-client
        const promotable = selectPromotableDatastores(ctx.identities, pkgs);
        expect(promotable.some(i => i.canonicalHint.technology === 'influxdb')).toBe(true);
        // the postgres contrast is also promotable via its unambiguous DSN scheme
        expect(promotable.some(i => i.canonicalHint.technology === 'postgres')).toBe(true);
    });
});
