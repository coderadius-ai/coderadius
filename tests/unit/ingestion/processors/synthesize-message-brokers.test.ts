import { describe, expect, it } from 'vitest';
import {
    synthesizeBrokerCandidateHints,
    type RepoEnvMap,
} from '../../../../src/ingestion/processors/connection-extractors/env-var-resolver';

// COD broker-grounded discovery: env vars no longer mint MessageBroker nodes
// directly. Every recognizer emits a BrokerCandidateHint; brokers are born
// only in `bindBrokerCandidates()` (anchor / scheme / convergence). Three
// emission lanes, priority s1 > s3 > s0 per env key:
//   s1 — scheme DSN in the VALUE (contract: amqp://, kafka://, ...)
//   s3 — legacy key-name trigger (convention-guess, demoted, @guess)
//   s0 — host-shaped VALUE under an arbitrary key (the RBMQ_H antidote)

type Entry = { value: string; sourceFile: string; confidence: 'high' | 'medium' | 'low' };

function makeEnv(entries: Record<string, string | Entry>): RepoEnvMap {
    const vars = new Map<string, Entry>();
    for (const [k, v] of Object.entries(entries)) {
        if (typeof v === 'string') {
            vars.set(k, { value: v, sourceFile: '.env', confidence: 'high' });
        } else {
            vars.set(k, v);
        }
    }
    return { vars };
}

describe('synthesizeBrokerCandidateHints — s1 scheme DSN values (contract)', () => {
    it('amqp:// DSN under an ARBITRARY key name → s1 hint with provider from scheme', () => {
        const env = makeEnv({
            NOTIF_BROKER_URL: 'amqp://acme-svc:fixture-secret@mq.acme-internal.consul:5672/inventory',
        });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s1-scheme');
        expect(h.provider).toBe('rabbitmq');
        expect(h.providerSource).toBe('scheme');
        expect(h.host).toBe('mq.acme-internal.consul');
        expect(h.port).toBe(5672);
        expect(h.vhost).toBe('inventory');
        expect(h.sourceEnvKey).toBe('NOTIF_BROKER_URL');
    });

    it('amqp:// without explicit vhost → vhost is the KNOWN AMQP default "/"', () => {
        const env = makeEnv({ MQ: 'amqp://mq.acme.example.com' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.vhost).toBe('/');
        expect(hints[0]!.port).toBe(5672);
    });

    it('amqps:// → default port 5671', () => {
        const env = makeEnv({ MQ: 'amqps://mq.acme.example.com' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.provider).toBe('rabbitmq');
        expect(hints[0]!.port).toBe(5671);
    });

    it('URL-encoded vhost %2F is decoded', () => {
        const env = makeEnv({ MQ: 'amqp://mq.acme.example.com:5672/%2F' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.vhost).toBe('/');
    });

    it('kafka:// and nats:// schemes map to their providers', () => {
        const env = makeEnv({
            A_URL: 'kafka://kafka.acme.example.com:9092',
            B_URL: 'nats://nats.acme.example.com:4222',
        });
        const hints = synthesizeBrokerCandidateHints(env);
        const byKey = new Map(hints.map(h => [h.sourceEnvKey, h]));
        expect(byKey.get('A_URL')!.provider).toBe('kafka');
        expect(byKey.get('B_URL')!.provider).toBe('nats');
        expect(byKey.get('A_URL')!.source).toBe('s1-scheme');
    });

    it('credentials NEVER appear anywhere in the hint', () => {
        const env = makeEnv({ MQ: 'amqp://user:hyper-secret@mq.acme.example.com:5672/orders' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const blob = JSON.stringify(hints[0]);
        expect(blob).not.toContain('hyper-secret');
        expect(blob).not.toContain('user:');
    });

    it('unresolved template values are skipped', () => {
        const env = makeEnv({ MQ: 'amqp://${MQ_HOST}:5672/orders' });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });
});

describe('synthesizeBrokerCandidateHints — s3 legacy key-name triggers (demoted guess)', () => {
    it('RABBITMQ_HOST + port + vhost → s3 hint, providerSource=key-name', () => {
        const env = makeEnv({
            RABBITMQ_HOST: 'rabbitmq.prod.acme.com',
            RABBITMQ_PORT: '5672',
            RABBITMQ_VHOST: 'orders',
        });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s3-key-name');
        expect(h.provider).toBe('rabbitmq');
        expect(h.providerSource).toBe('key-name');
        expect(h.host).toBe('rabbitmq.prod.acme.com');
        expect(h.port).toBe(5672);
        expect(h.vhost).toBe('orders');
        expect(h.sourceEnvKey).toBe('RABBITMQ_HOST');
    });

    it('KAFKA_BOOTSTRAP_SERVERS host:port → s3 kafka', () => {
        const env = makeEnv({ KAFKA_BOOTSTRAP_SERVERS: 'kafka.prod.acme.com:9092' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.source).toBe('s3-key-name');
        expect(hints[0]!.provider).toBe('kafka');
        expect(hints[0]!.port).toBe(9092);
    });

    it('plain REDIS_HOST without stream companion keys → nothing (cache, not broker)', () => {
        const env = makeEnv({ REDIS_HOST: 'redis.prod.acme.com', REDIS_PORT: '6379' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints.filter(h => h.source === 's3-key-name')).toHaveLength(0);
    });

    it('REDIS_HOST + REDIS_STREAM_* companion → s3 redis-streams', () => {
        const env = makeEnv({
            REDIS_HOST: 'redis-streams.prod.acme.com',
            REDIS_STREAM_NAME: 'orders.events',
        });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.provider).toBe('redis-streams');
        expect(hints[0]!.source).toBe('s3-key-name');
    });

    it('a NATS_URL with scheme is claimed by s1 (priority s1 > s3, no duplicate hint)', () => {
        const env = makeEnv({ NATS_URL: 'nats://nats.prod.acme.com:4222' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.source).toBe('s1-scheme');
        expect(hints[0]!.provider).toBe('nats');
    });
});

describe('synthesizeBrokerCandidateHints — s0 host-shaped values (arbitrary key names)', () => {
    it('internal-TLD FQDN under arbitrary key → s0 hint, provider undefined', () => {
        const env = makeEnv({ INVENTORY_MQ_HOSTNAME: 'mq.acme-internal.consul.' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        const h = hints[0]!;
        expect(h.source).toBe('s0-host-shape');
        expect(h.provider).toBeUndefined();
        expect(h.providerSource).toBeUndefined();
        // Raw value preserved; normalization (trailing dot) is the mutation
        // layer's job so fingerprint inputs stay in one place.
        expect(h.host).toBe('mq.acme-internal.consul.');
        expect(h.vhost).toBeUndefined();
        expect(h.sourceEnvKey).toBe('INVENTORY_MQ_HOSTNAME');
    });

    it('host:port value under arbitrary key → s0 with port', () => {
        const env = makeEnv({ EVENTS_TARGET: 'events.acme-prod.internal:5672' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.source).toBe('s0-host-shape');
        expect(hints[0]!.host).toBe('events.acme-prod.internal');
        expect(hints[0]!.port).toBe(5672);
    });

    it('single-label values NEVER emit, regardless of key name (no shape evidence)', () => {
        // 'rabbitmq' as a bare word carries zero host evidence — only the
        // value SHAPE (multi-label FQDN or host:port) is contract-grade.
        // The production value of the same key is an FQDN and WILL candidate.
        expect(synthesizeBrokerCandidateHints(makeEnv({ SHIPPING_MQ_HOST: 'rabbitmq' }))).toHaveLength(0);
        expect(synthesizeBrokerCandidateHints(makeEnv({ SHIPPING_MODE: 'rabbitmq' }))).toHaveLength(0);
    });

    it('http(s):// values are NEVER s0 candidates (API/datastore territory)', () => {
        const env = makeEnv({
            PAYMENT_URL: 'https://payment.acme.example.com',
            METRICS_ENDPOINT: 'http://metrics.acme-internal.consul:8086',
        });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('keys claimed by datastore extractors are excluded via claimedEnvKeys (explicit set, no parallel regex)', () => {
        const env = makeEnv({
            DB_HOST: 'mysql.acme-internal.consul',
            INVENTORY_MQ_HOSTNAME: 'mq.acme-internal.consul',
        });
        const hints = synthesizeBrokerCandidateHints(env, {
            claimedEnvKeys: new Set(['DB_HOST']),
        });
        expect(hints).toHaveLength(1);
        expect(hints[0]!.sourceEnvKey).toBe('INVENTORY_MQ_HOSTNAME');
    });

    it('plain words / sentinels / templates are not host-shaped', () => {
        const env = makeEnv({
            APP_ENV_HOST: 'production',
            CACHE_HOST: '<host>',
            QUEUE_HOST: '${BROKER_HOST}',
            FEATURE_FLAGS: 'a,b,c',
        });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('a key already claimed by s3 does NOT double-emit as s0', () => {
        const env = makeEnv({ RABBITMQ_HOST: 'rabbitmq.prod.acme.com' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.source).toBe('s3-key-name');
    });
});

describe('s0 anti-noise: value/key shapes that are NOT broker hosts', () => {
    it('dotted FILENAMES never candidate (last label is a file extension)', () => {
        const env = makeEnv({
            STORAGE_KEY_FILE_PATH: 'acme-prod-12345-ab12cd34ef56.json',
            BACKUP_TARGET: 'nightly.archive.tar.gz',
        });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('path-bearing values never candidate', () => {
        const env = makeEnv({ CERT_LOCATION: 'etc/ssl/acme.internal' });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('channel-name keys (published AMQP vocabulary suffixes) are emission-filtered from s0', () => {
        const env = makeEnv({
            ACME_EXCHANGE: 'ha.orders',                 // exchange NAME, not a host
            ACME_ROUTING_KEY: 'acme.order.created',
            ACME_QUEUE_NAME: 'ha.orders.import',
            ACME_TOPIC: 'orders.events',
        });
        expect(synthesizeBrokerCandidateHints(env)).toHaveLength(0);
    });

    it('control: a host-shaped value under a non-channel key still candidates', () => {
        const env = makeEnv({ ACME_MQ_HOSTNAME: 'mq.acme-internal.consul' });
        const hints = synthesizeBrokerCandidateHints(env);
        expect(hints).toHaveLength(1);
        expect(hints[0]!.source).toBe('s0-host-shape');
    });
});
