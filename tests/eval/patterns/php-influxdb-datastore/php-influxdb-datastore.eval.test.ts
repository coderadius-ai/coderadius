/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-influxdb-datastore
 *
 * Pins the InfluxDB datastore False Negative. A PHP service connects to InfluxDB
 * via the `influxdb/influxdb-php` client constructed with POSITIONAL host/port
 * args from an INFLUXDB_* env trio (no DSN URI, no ORM entity, write I/O one hop
 * away in a wrapper). The connection extractor must recover it as a `timeseries`
 * datastore — a datastore FN is a blast-radius safety break.
 *
 * Fixture (anonymised acme):
 *   - composer.json (influxdb/influxdb-php + doctrine/dbal)
 *   - .env (INFLUXDB_HOST/PORT/SCHEMA + DB_* + MEMCACHED_* contrasts)
 *   - config/values.php (getenv() refs make the vars code-referenced)
 *   - config/containerBuilder.php (new \InfluxDB\Client positional ctor)
 *   - classes/Acme/Monitoring/InfluxDbMonitoring.php (write one hop away)
 *
 * Asserts (deterministic, zero LLM, zero graph DB):
 *   ✓ extractAllPhysicalHints recovers an influxdb hint (host=influxdb, port=8086,
 *     db=acme) from the env trio
 *   ✓ influxdb resolves to the `timeseries` physical family (not opaque)
 *   ✓ selectivity: the mysql (DB_* trio) and memcached (MEMCACHED_* trio) hints
 *     coexist, proving the influx descriptor did not poison the other paths
 *   ✓ the influx schema name collides with the MySQL DB name (both 'acme') yet
 *     canonicalization keeps them as separate identities (the acme-legacy monolith repro)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAllPhysicalHints } from '../../../../src/ingestion/processors/connection-extractors/registry.js';
import { canonicalizeDatastoreIdentities } from '../../../../src/ingestion/processors/connection-extractors/canonicalizer.js';
import { familyFor } from '../../../../src/ingestion/processors/physical-fingerprint.js';
import { selectPromotableDatastores, readDeclaredPackages } from '../../../../src/ingestion/processors/datastore-promotion.js';
import { runStaticPipelineOnFixture, runStaticBypassForMethod } from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-influxdb-datastore', () => {
    let stagedRepo: string;

    beforeAll(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-php-influx-eval-'));
        stagedRepo = path.join(tmp, 'metrics-writer');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('influxdb resolves to the timeseries family', () => {
        expect(familyFor('influxdb')).toBe('timeseries');
    });

    it('recovers the InfluxDB datastore from the INFLUXDB_* env trio', () => {
        const { hints } = extractAllPhysicalHints(stagedRepo);
        const influx = hints.find(h => h.technology === 'influxdb');
        expect(influx, 'an influxdb physical hint must be recovered').toBeDefined();
        expect(influx!.host).toBe('influxdb');
        expect(influx!.port).toBe(8086);
        // INFLUXDB_SCHEMA is the app name 'acme' — deliberately colliding with the
        // MySQL DB_SCHEMA. The hint preserves it verbatim; the canonicalizer keeps
        // the two stores separate (asserted below).
        expect(influx!.dbName).toBe('acme');
    });

    it('selectivity: mysql and memcached hints coexist (influx trio did not poison them)', () => {
        const { hints } = extractAllPhysicalHints(stagedRepo);
        const byTech = new Set(hints.map(h => h.technology));
        expect(byTech.has('influxdb')).toBe(true);
        expect(byTech.has('mysql')).toBe(true);
        expect(byTech.has('memcached')).toBe(true);
    });

    // Regression: the influx schema (INFLUXDB_SCHEMA=acme) shares the MySQL DB
    // name (DB_SCHEMA=acme). dbName-only canonicalization collapsed both into one
    // identity and let influxdb overwrite the relational store. Distinct families
    // sharing a logical name must yield distinct datastore identities.
    it('canonicalization keeps the MySQL DB and the InfluxDB schema as SEPARATE identities', () => {
        const { hints } = extractAllPhysicalHints(stagedRepo);
        const identities = canonicalizeDatastoreIdentities(hints);
        const mysql = identities.find(i => i.canonicalHint.technology === 'mysql');
        const influx = identities.find(i => i.canonicalHint.technology === 'influxdb');
        expect(mysql, 'the MySQL identity must survive the influx collision').toBeDefined();
        expect(influx, 'the InfluxDB identity must be its own node').toBeDefined();
        // RDBMS keeps its logical-db identity; timeseries is keyed by technology.
        expect(mysql!.identityKey).toBe('acme');
        expect(influx!.identityKey).toBe('influxdb');
    });

    it('the InfluxDB identity clears the high-confidence promotion gate (client lib declared)', () => {
        const { hints } = extractAllPhysicalHints(stagedRepo);
        const identities = canonicalizeDatastoreIdentities(hints);
        const pkgs = readDeclaredPackages(stagedRepo);  // composer.json has influxdb/influxdb-php
        const promotable = selectPromotableDatastores(identities, pkgs);
        expect(promotable.some(i => i.canonicalHint.technology === 'influxdb')).toBe(true);
    });

    // Root-cause path: the standard InfluxDB write method must be a recognized
    // datastore sink so the calling function survives the gate and carries a
    // timeseries Database infra signal (-> binds function->Datastore via the
    // existing path, no DataContainer, attributed to the containing service).
    it('writePoints is a recognized timeseries datastore sink (function->datastore signal)', () => {
        const result = runStaticPipelineOnFixture(FIXTURE_DIR, 'acme/metrics-writer');
        const { staticAnalysis } = runStaticBypassForMethod(
            result, 'Acme\\Monitoring\\InfluxDbMonitoring', 'addEvent',
        );
        const influx = staticAnalysis?.infrastructure.find(
            i => i.type === 'Database' && i.kindFamily === 'timeseries',
        );
        expect(influx, 'addEvent->writePoints must yield a timeseries Database infra signal').toBeDefined();
    });
});
