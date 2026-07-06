import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    scanCodeAccessorEnvVars,
    scanContentForAccessors,
    buildAccessorMatchers,
    clearAccessorScanCache,
} from '../../../../../src/ingestion/processors/connection-extractors/env-accessor-scanner.js';
import {
    scanCodeReferencedEnvVars,
    clearCodeEnvVarCache,
} from '../../../../../src/ingestion/processors/connection-extractors/code-env-scanner.js';
import type { EnvAccessor } from '../../../../../src/config/repo-hints.js';

const VAULT: EnvAccessor = { callee: 'Acme\\Platform\\EnvVault::fetch', keyArg: 0, defaultArg: 1 };

const PHP_SAMPLE = `<?php
use Acme\\Platform\\EnvVault;

class OrdersBusConfig {
    public function host(): string {
        return EnvVault::fetch('ORDERS_MQ_HOST', 'mq.acme-internal.consul');
    }
    public function port(): int {
        return (int) EnvVault::fetch('ORDERS_MQ_PORT', 5672);          // non-string default
    }
    public function pass(): string {
        return EnvVault::fetch('ORDERS_MQ_PASS', $this->fallback);     // dynamic default
    }
    public function dynamic(): string {
        return EnvVault::fetch($this->keyName, 'nope');                // dynamic key: ignored
    }
    public function fqn(): string {
        return \\Acme\\Platform\\EnvVault::fetch('ORDERS_DB_HOST', 'db.acme-prod.internal');
    }
    public function lowercase(): string {
        return EnvVault::fetch('not_an_env_key', 'x');                 // lowercase: ignored
    }
}
`;

describe('scanContentForAccessors (pure)', () => {
    const matchers = buildAccessorMatchers([VAULT]);

    it('harvests keys from short form and FQN form, filters non-keys', () => {
        const { keys } = scanContentForAccessors(PHP_SAMPLE, matchers);
        expect([...keys].sort()).toEqual([
            'ORDERS_DB_HOST', 'ORDERS_MQ_HOST', 'ORDERS_MQ_PASS', 'ORDERS_MQ_PORT',
        ]);
    });

    it('harvests defaults ONLY for string-literal default args', () => {
        const { defaults } = scanContentForAccessors(PHP_SAMPLE, matchers);
        const byKey = Object.fromEntries(defaults.map((d) => [d.key, d.value]));
        expect(byKey).toEqual({
            ORDERS_MQ_HOST: 'mq.acme-internal.consul',
            ORDERS_DB_HOST: 'db.acme-prod.internal',
        });
    });

    it('regex-escapes callees: backslashes and dollar signs never explode', () => {
        const weird: EnvAccessor = { callee: 'Acme\\Tools\\$Env::get', keyArg: 0 };
        const m = buildAccessorMatchers([weird]);
        const { keys } = scanContentForAccessors(`$Env::get('WEIRD_KEY')`, m);
        expect([...keys]).toEqual(['WEIRD_KEY']);
    });

    it('matches member-style accessors declared verbatim (TS)', () => {
        const ts: EnvAccessor = { callee: 'envVault.fetch', keyArg: 0, defaultArg: 1 };
        const m = buildAccessorMatchers([ts]);
        const { keys, defaults } = scanContentForAccessors(
            `const h = envVault.fetch('SHIPPING_API_URL', 'https://api.acme.test');`, m,
        );
        expect([...keys]).toEqual(['SHIPPING_API_URL']);
        expect(defaults).toEqual([{ key: 'SHIPPING_API_URL', value: 'https://api.acme.test' }]);
    });

    it('does not match unrelated identifiers that merely end with the tail', () => {
        const m = buildAccessorMatchers([VAULT]);
        const { keys } = scanContentForAccessors(
            `OtherEnvVault::fetch('SNEAKY_KEY')`, m,
        );
        expect(keys.size).toBe(0);
    });

    it('respects keyArg position beyond 0', () => {
        const positional: EnvAccessor = { callee: 'Cfg::read', keyArg: 1, defaultArg: 2 };
        const m = buildAccessorMatchers([positional]);
        const { keys, defaults } = scanContentForAccessors(
            `Cfg::read('scope', 'NOTIF_BROKER_URL', 'amqp://mq.acme.test')`, m,
        );
        expect([...keys]).toEqual(['NOTIF_BROKER_URL']);
        expect(defaults).toEqual([{ key: 'NOTIF_BROKER_URL', value: 'amqp://mq.acme.test' }]);
    });
});

describe('scanCodeAccessorEnvVars + cache safety (filesystem)', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-accessor-'));
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'OrdersBusConfig.php'), PHP_SAMPLE);
        clearAccessorScanCache();
        clearCodeEnvVarCache();
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        clearAccessorScanCache();
        clearCodeEnvVarCache();
    });

    it('walks the repo and returns keys + defaults', () => {
        const res = scanCodeAccessorEnvVars(tmp, [VAULT]);
        expect(res.keys.has('ORDERS_MQ_HOST')).toBe(true);
        expect(res.defaults.some((d) => d.key === 'ORDERS_DB_HOST')).toBe(true);
    });

    it('no accessors configured → empty result without walking', () => {
        const res = scanCodeAccessorEnvVars(tmp, []);
        expect(res.keys.size).toBe(0);
        expect(res.defaults).toEqual([]);
    });

    it('scanCodeReferencedEnvVars unions base patterns with accessor keys', () => {
        fs.writeFileSync(path.join(tmp, 'src', 'legacy.php'), `<?php getenv('PLAIN_KEY');`);
        const withAccessors = scanCodeReferencedEnvVars(tmp, [VAULT]);
        expect(withAccessors.has('PLAIN_KEY')).toBe(true);
        expect(withAccessors.has('ORDERS_MQ_HOST')).toBe(true);
    });

    it('cache is keyed on (path, accessors): different configs never bleed', () => {
        const a = scanCodeReferencedEnvVars(tmp, [VAULT]);
        expect(a.has('ORDERS_MQ_HOST')).toBe(true);

        const none = scanCodeReferencedEnvVars(tmp, []);
        expect(none.has('ORDERS_MQ_HOST')).toBe(false);

        const other: EnvAccessor = { callee: 'Other::get', keyArg: 0 };
        const b = scanCodeReferencedEnvVars(tmp, [other]);
        expect(b.has('ORDERS_MQ_HOST')).toBe(false);
    });

    it('clearCodeEnvVarCache(repoPath) clears every accessor variant for the path', () => {
        scanCodeReferencedEnvVars(tmp, [VAULT]);
        clearCodeEnvVarCache(tmp);
        clearAccessorScanCache(tmp);
        // After clearing, removing the file must be reflected (no stale cache).
        fs.rmSync(path.join(tmp, 'src', 'OrdersBusConfig.php'));
        const res = scanCodeReferencedEnvVars(tmp, [VAULT]);
        expect(res.has('ORDERS_MQ_HOST')).toBe(false);
    });
});
