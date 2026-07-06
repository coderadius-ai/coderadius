/**
 * Unit Tests — deterministic superset for prompt reject-list cuts
 *
 * Before cutting reject-list clauses from the system prompt, the
 * deterministic layer must cover every term the prompt no longer forbids:
 *   - 'influxdb'/'influx' as generic technology names (Database path)
 *   - bare 's3'/'gcs'/'bucket' as storage-mechanism tokens (ObjectStorage
 *     and Database paths both call isStorageTypeOrTransportToken)
 */

import { describe, it, expect } from 'vitest';
import {
    GENERIC_INFRA_NAMES,
    isHallucinatedTable,
    isStorageTypeOrTransportToken,
} from '../../../../src/ingestion/core/name-safety.js';

describe('GENERIC_INFRA_NAMES — technology names from the L4 prompt cut', () => {
    it.each(['mongodb', 'doctrine', 'prisma', 'mongoose', 'entitymanager'])(
        'contains %s',
        (name) => {
            expect(GENERIC_INFRA_NAMES.has(name)).toBe(true);
        },
    );

    // 'influxdb' is deliberately NOT in the wholesale set (a real datastore can
    // be named after its engine — see infra-drop-filter.test.ts). The prompt
    // cut for technology-names-as-tables is enforced by the evidence-mandatory
    // path instead: without SQL/ORM evidence in source, the table is dropped.
    it('influxdb-as-table is enforced by the evidence path, not the set', () => {
        const sourceWithoutSql = 'const client = new InfluxDB(url); client.writePoints(points);';
        expect(GENERIC_INFRA_NAMES.has('influxdb')).toBe(false);
        expect(isHallucinatedTable('influxdb', undefined, sourceWithoutSql)).toBe(true);
    });
});

describe('isStorageTypeOrTransportToken — bare cloud-storage tokens', () => {
    it.each(['s3', 'gcs', 'bucket', 'sftp', 'objectstorage'])('drops bare token %s', (name) => {
        expect(isStorageTypeOrTransportToken(name)).toBe(true);
    });

    it.each(['s3-uploads', 'gcs_exports', 'bucket_list', 'user_files'])(
        'keeps real container names containing the word (%s)',
        (name) => {
            expect(isStorageTypeOrTransportToken(name)).toBe(false);
        },
    );
});
