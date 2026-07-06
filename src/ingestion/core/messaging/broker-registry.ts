import { createHash } from 'node:crypto';
import { normalizeHost } from '../../processors/physical-fingerprint.js';
import type { MessageBrokerDeclaration, MessageChannelMirror } from '../../../config/repo-hints.js';
import type { MessageBrokerProvider } from '../../../graph/mutations/data-contracts.js';
import { isUnfingerprintableHost } from '../../processors/physical-fingerprint.js';

/**
 * In-memory registry of customer-declared brokers + cross-broker mirrors loaded
 * from `coderadius.yaml`. Populated once per repo at the start of the workflow
 * (the same way `registerCustomMessageConsumerDecorator` is wired) and consulted
 * by:
 *   1. Structural plugins (RabbitMQ / Symfony Messenger / Kafka / …) to resolve
 *      a DSN with unresolved env-vars against a customer-declared broker.
 *   2. The channel-alias welder to materialize MANIFESTS_AS edges from the
 *      LogicalChannel of each `mirrors[].logical` to the declared physical
 *      channels.
 *
 * Strict-isolation rule (memory: "no welding euristico cross-broker"): the
 * registry never derives a mirror from heuristics. Only entries declared by
 * the customer in `coderadius.yaml` produce MANIFESTS_AS edges across brokers.
 */

export interface RegisteredBroker {
    /** Customer-declared id used to anchor mirror entries. */
    id: string;
    provider: MessageBrokerProvider;
    /** sha256_trunc8 fingerprint over (provider:host:port:vhost[:repoUrn]). Stable across runs. */
    fingerprint: string;
    /**
     * 'global' when the fingerprint is stable across repos (FQDN hosts that
     * point to a real shared broker), 'repo' when the fingerprint is scoped
     * to a single repo (loopback / compose service name / single-label host).
     * The URN shape is identical in both cases (`cr:broker:{provider}:{fp}[:{vhost-slug}]`);
     * scope is a property on the node, not part of the URN.
     */
    fingerprintScope: 'global' | 'repo';
    /** When fingerprintScope='repo', the qualifiedRepoName that scoped this broker. */
    repoScope?: string;
    /** Full URN (`cr:broker:{provider}:{fingerprint}[:{vhost-slug}]`). */
    urn: string;
    cluster?: string;
    host?: string;
    port?: number;
    vhost?: string;
    region?: string;
    env?: string;
    /**
     * Other hosts observed across multi-env config files (e.g. .env vs
     * .env.production vs helm values-staging). Production-priority wins;
     * the rest are tracked here as governance hint without producing
     * phantom broker nodes.
     */
    alternateHostsSeen?: string[];
}

const brokersById = new Map<string, RegisteredBroker>();
const brokersByFingerprint = new Map<string, RegisteredBroker>();
const mirrors: MessageChannelMirror[] = [];

/**
 * Decide whether the fingerprint of a broker with `host` should be repo-scoped.
 * `repo` scope is for hosts that are NOT publicly addressable (loopback,
 * single-label compose service names): two repos that both declare a local
 * RabbitMQ would otherwise collide on `cr:broker:rabbitmq:99f129a3`. By
 * incorporating `repoUrn` into the hash material we ensure cross-repo
 * isolation while preserving intra-repo welding.
 *
 * URN shape stays identical in both scopes — the scope is reflected on the
 * `:MessageBroker` node as a `fingerprintScope` property, not in the URN
 * suffix (which is reserved for the vhost slug).
 */
export function classifyBrokerFingerprintScope(host: string | undefined): 'global' | 'repo' {
    if (!host) return 'repo';
    return isUnfingerprintableHost(host) ? 'repo' : 'global';
}

/**
 * Compute a stable broker fingerprint from connection identity. When the
 * customer provides an explicit `fingerprint` override (e.g. to distinguish
 * functionally separate brokers behind the same DNS), it takes precedence.
 *
 * When `repoUrn` is provided AND the host is not publicly addressable
 * (loopback, compose service name), `repoUrn` is folded into the hash
 * material to scope the fingerprint to that repo, preventing cross-repo
 * collisions on common local-dev broker hostnames. When the host is a
 * publicly addressable FQDN, `repoUrn` is ignored so that cross-repo welding
 * on the same physical broker works as expected.
 */
export function computeBrokerFingerprint(parts: {
    provider: string;
    host?: string;
    port?: number;
    vhost?: string;
    override?: string;
    repoUrn?: string;
}): string {
    if (parts.override) return parts.override;
    // normalizeHost before computing fingerprint/transparent identity.
    // Strips the FQDN trailing dot (`rabbitmq.acme.consul.` → `rabbitmq.acme.consul`),
    // decodes IDN, unwraps IPv6 brackets. Guarantees cross-run stability.
    const host = normalizeHost(parts.host ?? '');
    // Fix P1.1: scope classification on NORMALIZED host. Raw `[::1]` (IPv6) and
    // FQDN trailing dot would otherwise be classified as global → repoUrn not
    // folded → cross-repo collision on common loopback hosts.
    const scope = classifyBrokerFingerprintScope(host);
    // MessageBroker identity must be stable across CLI processes. The
    // `--transparent-urns` flag controls displayHost/displayVhost only here; it
    // must never change broker URN material.
    const segments = [
        parts.provider,
        host,
        parts.port ?? '',
        parts.vhost ?? '',
    ];
    if (scope === 'repo' && parts.repoUrn) {
        segments.push(parts.repoUrn);
    }
    return createHash('sha256').update(segments.join(':')).digest('hex').slice(0, 8);
}

/**
 * Build the broker URN. Mirrors `buildBrokerUrn` from `graph/urn.ts` but kept
 * inline-friendly for plugins that import only from the messaging core.
 */
export function makeBrokerUrn(provider: string, fingerprint: string, vhost?: string): string {
    const base = `cr:broker:${provider}:${fingerprint}`;
    if (!vhost || vhost === '/' || vhost === '') return base;
    const slug = vhost.replace(/^\/+/, '').replace(/[/:]/g, '-');
    return slug ? `${base}:${slug}` : base;
}

export function registerBrokerDeclaration(decl: MessageBrokerDeclaration, opts?: { repoUrn?: string }): RegisteredBroker {
    const fingerprint = computeBrokerFingerprint({
        provider: decl.provider,
        host: decl.host,
        port: decl.port,
        vhost: decl.vhost,
        override: decl.fingerprint,
        repoUrn: opts?.repoUrn,
    });
    // Fix P1.1: scope on normalized host (see computeBrokerFingerprint).
    const fingerprintScope = classifyBrokerFingerprintScope(normalizeHost(decl.host ?? ''));
    const urn = makeBrokerUrn(decl.provider, fingerprint, decl.vhost);
    const broker: RegisteredBroker = {
        id: decl.id,
        provider: decl.provider,
        fingerprint,
        fingerprintScope,
        repoScope: fingerprintScope === 'repo' ? opts?.repoUrn : undefined,
        urn,
        cluster: decl.cluster,
        host: decl.host,
        port: decl.port,
        vhost: decl.vhost,
        region: decl.region,
        env: decl.env,
    };
    brokersById.set(decl.id, broker);
    brokersByFingerprint.set(fingerprint, broker);
    return broker;
}

export function registerMirror(mirror: MessageChannelMirror): void {
    mirrors.push(mirror);
}

export function getBrokerById(id: string): RegisteredBroker | undefined {
    return brokersById.get(id);
}

export function getBrokerByFingerprint(fingerprint: string): RegisteredBroker | undefined {
    return brokersByFingerprint.get(fingerprint);
}

export function listRegisteredBrokers(): RegisteredBroker[] {
    return Array.from(brokersById.values());
}

export function listMirrors(): MessageChannelMirror[] {
    return mirrors.slice();
}

/**
 * Clear all registrations. MUST be called between repo ingestions to prevent
 * a multi-repo run from leaking declarations across customers (mirrors the
 * `clearCustomMessageConsumerDecorators` pattern).
 */
export function clearMessageBrokerRegistry(): void {
    brokersById.clear();
    brokersByFingerprint.clear();
    mirrors.length = 0;
}
