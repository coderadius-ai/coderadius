import { describe, it, expect, beforeEach } from 'vitest';
import { computeBrokerFingerprint, makeBrokerUrn } from '../../../../../src/ingestion/core/messaging/broker-registry.js';
import { resetUrnTransparencyForTesting, setUrnsTransparent } from '../../../../../src/utils/urn-transparency.js';

describe('broker-registry — broker identity stability under transparent display mode', () => {
    beforeEach(() => {
        resetUrnTransparencyForTesting();
    });

    it('returns sha256-trunc8 fingerprint regardless of transparent mode', () => {
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.prod.acme.local',
            port: 5672,
            vhost: 'orders',
        });
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
        setUrnsTransparent(true);
        const transparentFp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.prod.acme.local',
            port: 5672,
            vhost: 'orders',
        });
        expect(transparentFp).toBe(fp);
        expect(transparentFp).not.toContain('~');
    });

    it('makeBrokerUrn is stable across transparent mode toggles', () => {
        const opaqueFp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.prod.acme.local',
            port: 5672,
            vhost: 'orders',
        });
        const opaqueUrn = makeBrokerUrn('rabbitmq', opaqueFp, 'orders');

        setUrnsTransparent(true);
        const transparentFp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.prod.acme.local',
            port: 5672,
            vhost: 'orders',
        });
        const transparentUrn = makeBrokerUrn('rabbitmq', transparentFp, 'orders');

        expect(transparentUrn).toBe(opaqueUrn);
        // Segments: cr / broker / rabbitmq / <fingerprint> / <vhost> = 5 segments.
        expect(transparentUrn.split(':')).toHaveLength(5);
        expect(transparentUrn).toMatch(/^cr:broker:rabbitmq:[0-9a-f]{8}:orders$/);
    });

    it('idempotency: same input returns same identity (no randomness)', () => {
        setUrnsTransparent(true);
        const fp1 = computeBrokerFingerprint({
            provider: 'kafka',
            host: 'broker-a.kafka.example',
            port: 9092,
        });
        const fp2 = computeBrokerFingerprint({
            provider: 'kafka',
            host: 'broker-a.kafka.example',
            port: 9092,
        });
        expect(fp1).toBe(fp2);
        expect(fp1).toMatch(/^[0-9a-f]{8}$/);
    });

    it('transparent mode preserves repoUrn folding for repo-scoped loopback hosts without transparent identity', () => {
        setUrnsTransparent(true);
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'localhost',
            port: 5672,
            vhost: '/',
            repoUrn: 'cr:repository:acme/inventory',
        });
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
        const otherRepo = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'localhost',
            port: 5672,
            vhost: '/',
            repoUrn: 'cr:repository:acme/orders',
        });
        expect(otherRepo).not.toBe(fp);
    });

    it('explicit override takes precedence over transparent mode', () => {
        setUrnsTransparent(true);
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'should-be-ignored',
            override: 'customer-pinned-fingerprint',
        });
        expect(fp).toBe('customer-pinned-fingerprint');
    });

    it('Fix 11: strips trailing dot from FQDN host (opaque mode)', () => {
        // FQDN canonical form includes trailing dot. normalizeHost should remove
        // it so the fingerprint is stable across runs that input the same FQDN
        // with/without the trailing dot.
        const fp1 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.service.acme.consul.',
            port: 5672,
        });
        const fp2 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.service.acme.consul',
            port: 5672,
        });
        expect(fp1).toBe(fp2);
    });

    it('Fix 11: strips trailing dot from FQDN host (transparent mode)', () => {
        setUrnsTransparent(true);
        const fp1 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.service.acme.consul.',
            port: 5672,
        });
        const fp2 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: 'rabbitmq.service.acme.consul',
            port: 5672,
        });
        expect(fp1).toBe(fp2);
        expect(fp1).toMatch(/^[0-9a-f]{8}$/);
    });

    it('Fix P1.1: IPv6 loopback [::1] folds repoUrn (no cross-repo collision)', () => {
        // Real failing case before P1.1: raw `[::1]` classified as global,
        // repoUrn ignored, two repos collided on the same fingerprint.
        const fpA = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '[::1]',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-a',
        });
        const fpB = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '[::1]',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-b',
        });
        expect(fpA).not.toBe(fpB);
    });

    it('Fix P1.1: IPv6 loopback folds repoUrn also in transparent mode', () => {
        setUrnsTransparent(true);
        const fpA = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '[::1]',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-a',
        });
        const fpB = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '[::1]',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-b',
        });
        expect(fpA).not.toBe(fpB);
        expect(fpA).toMatch(/^[0-9a-f]{8}$/);
        expect(fpB).toMatch(/^[0-9a-f]{8}$/);
    });

    it('Fix P1.1: same loopback + same repoUrn → same fingerprint (idempotent)', () => {
        const fp1 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '127.0.0.1',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-a',
        });
        const fp2 = computeBrokerFingerprint({
            provider: 'rabbitmq',
            host: '127.0.0.1',
            port: 5672,
            repoUrn: 'cr:repository:acme/repo-a',
        });
        expect(fp1).toBe(fp2);
    });
});
