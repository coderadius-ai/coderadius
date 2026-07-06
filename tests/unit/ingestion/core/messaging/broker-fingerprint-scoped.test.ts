import { describe, expect, it } from 'vitest';
import {
    computeBrokerFingerprint,
    classifyBrokerFingerprintScope,
    makeBrokerUrn,
} from '../../../../../src/ingestion/core/messaging/broker-registry';

describe('computeBrokerFingerprint — scoped vs global', () => {
    it('FQDN host: fingerprint is identical regardless of repoUrn (global welding)', () => {
        const fpA = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq.prod.acme.com', port: 5672, vhost: 'orders',
            repoUrn: 'acme/repo-A',
        });
        const fpB = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq.prod.acme.com', port: 5672, vhost: 'orders',
            repoUrn: 'acme/repo-B',
        });
        expect(fpA).toBe(fpB);
    });

    it('compose service-name host: fingerprint includes repoUrn, differs across repos', () => {
        const fpA = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672, vhost: 'orders',
            repoUrn: 'acme/repo-A',
        });
        const fpB = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672, vhost: 'orders',
            repoUrn: 'acme/repo-B',
        });
        expect(fpA).not.toBe(fpB);
    });

    it('loopback host (localhost): fingerprint includes repoUrn', () => {
        const fpA = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'localhost', port: 5672,
            repoUrn: 'acme/repo-A',
        });
        const fpB = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'localhost', port: 5672,
            repoUrn: 'acme/repo-B',
        });
        expect(fpA).not.toBe(fpB);
    });

    it('same compose host within same repo: fingerprint identical (intra-repo welding works)', () => {
        const fp1 = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672,
            repoUrn: 'acme/orders-monorepo',
        });
        const fp2 = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672,
            repoUrn: 'acme/orders-monorepo',
        });
        expect(fp1).toBe(fp2);
    });

    it('override takes precedence over both host+repoUrn', () => {
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672,
            repoUrn: 'acme/repo-A',
            override: 'manual-override-fp',
        });
        expect(fp).toBe('manual-override-fp');
    });

    it('omitting repoUrn for FQDN host: still produces global fingerprint (backwards compat)', () => {
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq.prod.acme.com', port: 5672,
        });
        // 8-char sha256 hex, deterministic
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
    });

    it('omitting repoUrn for compose host: falls back to legacy fingerprint (no scoping)', () => {
        // When the caller doesn't provide repoUrn, we cannot scope. The function
        // must still return a deterministic value (legacy behaviour) so it can
        // be called from contexts that don't know the repo (e.g. coderadius.yaml
        // declared brokers, where the customer accepts global collision risk).
        const fp = computeBrokerFingerprint({
            provider: 'rabbitmq', host: 'rabbitmq', port: 5672,
        });
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('classifyBrokerFingerprintScope', () => {
    it('FQDN host with at least one dot → global', () => {
        expect(classifyBrokerFingerprintScope('rabbitmq.prod.acme.com')).toBe('global');
        expect(classifyBrokerFingerprintScope('kafka.cluster.svc.example.com')).toBe('global');
    });

    it('compose service-name (single label) → repo', () => {
        expect(classifyBrokerFingerprintScope('rabbitmq')).toBe('repo');
        expect(classifyBrokerFingerprintScope('kafka')).toBe('repo');
    });

    it('loopback hosts → repo', () => {
        expect(classifyBrokerFingerprintScope('localhost')).toBe('repo');
        expect(classifyBrokerFingerprintScope('127.0.0.1')).toBe('repo');
        expect(classifyBrokerFingerprintScope('::1')).toBe('repo');
    });

    it('empty / undefined host → repo (defensive)', () => {
        expect(classifyBrokerFingerprintScope('')).toBe('repo');
        expect(classifyBrokerFingerprintScope(undefined)).toBe('repo');
    });
});

describe('makeBrokerUrn — URN shape preserved regardless of scope', () => {
    it('global-scope broker: URN unchanged', () => {
        const urn = makeBrokerUrn('rabbitmq', 'abc12345', 'orders');
        expect(urn).toBe('cr:broker:rabbitmq:abc12345:orders');
    });

    it('repo-scope broker: same URN shape, no :repo-scoped suffix', () => {
        // Test critique from codex: the URN slot after fingerprint is the vhost slug.
        // Adding ':repo-scoped' would collide with that slot. URN shape stays
        // invariant; the scope lives on the node as a property.
        const urn = makeBrokerUrn('rabbitmq', 'def67890', 'orders');
        expect(urn).toBe('cr:broker:rabbitmq:def67890:orders');
        expect(urn).not.toContain('repo-scoped');
    });
});
