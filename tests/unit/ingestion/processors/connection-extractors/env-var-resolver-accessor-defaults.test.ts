import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRepoEnvMap } from '../../../../../src/ingestion/processors/connection-extractors/env-var-resolver.js';

describe('buildRepoEnvMap accessorDefaults source', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-envmap-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('appends LAST: any file-based source wins over an accessor default', () => {
        fs.mkdirSync(path.join(tmp, 'charts'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, 'charts', 'values-production.yaml'),
            'app:\n  customEnvs:\n    ORDERS_MQ_HOST: mq.acme-prod.consul\n    UNRELATED: x\n',
        );
        const map = buildRepoEnvMap(tmp, {
            accessorDefaults: [{ key: 'ORDERS_MQ_HOST', value: 'mq.acme-internal.consul' }],
        });
        expect(map.vars.get('ORDERS_MQ_HOST')?.value).toBe('mq.acme-prod.consul');
    });

    it('fills the gap when no file source declares the key, at confidence low', () => {
        const map = buildRepoEnvMap(tmp, {
            accessorDefaults: [{ key: 'ORDERS_DB_HOST', value: 'db.acme-prod.internal' }],
        });
        const entry = map.vars.get('ORDERS_DB_HOST');
        expect(entry?.value).toBe('db.acme-prod.internal');
        expect(entry?.confidence).toBe('low');
        expect(entry?.sourceFile).toBe('<accessor-default>');
    });

    it('accessor defaults bypass the codeReferencedFilter (their keys ARE code-referenced by construction)', () => {
        const map = buildRepoEnvMap(tmp, {
            codeReferencedFilter: new Set(['SOMETHING_ELSE']),
            accessorDefaults: [{ key: 'NOTIF_BROKER_HOST', value: 'mq.acme.test' }],
        });
        expect(map.vars.get('NOTIF_BROKER_HOST')?.value).toBe('mq.acme.test');
    });
});
