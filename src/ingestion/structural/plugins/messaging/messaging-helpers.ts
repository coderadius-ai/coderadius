/**
 * Common helpers shared by messaging structural plugins (RabbitMQ, Symfony
 * Messenger, Kafka, Pulsar, Azure Service Bus, ...).
 *
 * Scope: declarative + offline. No network I/O, no env-var resolution
 * (env-var resolution lives in the orchestrator). When the DSN contains
 * unresolvable variables we return a broker with `declaredVia: 'inferred'`
 * and `confidence: 0.3`, leaving cross-plugin matching to the downstream welder.
 */

import { computeBrokerFingerprint, getBrokerById, makeBrokerUrn, type RegisteredBroker } from '../../../core/messaging/broker-registry.js';
import type { MessageBrokerProvider } from '../../../../graph/mutations/data-contracts.js';
import type { StructuralEntity } from '../../types.js';
import { normalizeHost } from '../../../processors/physical-fingerprint.js';
import { areUrnsTransparent } from '../../../../utils/urn-transparency.js';

export interface ParsedAmqpDsn {
    /** Provider identifier as inferred from the DSN scheme. */
    provider: MessageBrokerProvider;
    /** Resolved host, or undefined when the DSN had `%env(...)%` placeholders. */
    host?: string;
    port?: number;
    vhost?: string;
    /** True when the DSN contained env-var placeholders we deliberately did not resolve. */
    hasUnresolvedPlaceholders: boolean;
    /** The original DSN string (raw), useful for debugging in trace logs. */
    rawDsn: string;
}

const SCHEME_TO_PROVIDER: Record<string, MessageBrokerProvider> = {
    'amqp': 'rabbitmq',
    'amqps': 'rabbitmq',
    'kafka': 'kafka',
    'kafka+ssl': 'kafka',
    'sqs': 'sqs',
    'sns': 'sns',
    'pubsub': 'pubsub',
    'redis': 'redis-streams',
    'rediss': 'redis-streams',
    'nats': 'nats',
    'pulsar': 'pulsar',
    'pulsar+ssl': 'pulsar',
    'mqtt': 'mqtt',
    'mqtts': 'mqtt',
    'tcp': 'mqtt',
    'sb': 'azure-service-bus',
};

/**
 * Parse an AMQP-like DSN. Handles `%env(VAR)%` and `${VAR}` placeholders by
 * returning the broker shape with the placeholder text preserved in `rawDsn`
 * and `hasUnresolvedPlaceholders = true`. The orchestrator is responsible for
 * env-var resolution; this function is pure.
 *
 * Examples:
 *   `amqp://guest:guest@rabbit.example.com:5672/prod`
 *   `amqp://%env(RABBITMQ_USER)%:%env(RABBITMQ_PASS)%@%env(RABBITMQ_HOST)%/`
 *   `kafka+ssl://kafka-1.example.com:9093,kafka-2.example.com:9093/`
 */
export function parseAmqpDsn(dsn: string): ParsedAmqpDsn | null {
    if (!dsn || typeof dsn !== 'string') return null;
    const hasUnresolved = /%env\(|\$\{/.test(dsn);

    // Match `<scheme>://[userinfo@]host[:port][/vhost]`.
    // Match scheme greedily up to `://` (no `://` in scheme).
    const match = dsn.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]+@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?/);
    if (!match) return null;
    const [, scheme, hostRaw, portRaw, vhostRaw] = match;
    const provider = SCHEME_TO_PROVIDER[scheme.toLowerCase()];
    if (!provider) return null;

    // If host or port carry env-var syntax, leave them as undefined so the
    // fingerprint is computed from the literal placeholder rather than a
    // random value.
    const hostHasPlaceholder = /%env\(|\$\{/.test(hostRaw);
    const host = hostHasPlaceholder ? undefined : hostRaw;
    const port = portRaw && !/%env\(|\$\{/.test(portRaw) ? Number(portRaw) : undefined;
    // The capture group is undefined when the URL has no trailing slash, but
    // it is `''` when the URL ends with `/` (vhost present but empty = root).
    let vhost: string | undefined;
    if (vhostRaw === undefined) {
        vhost = undefined;
    } else if (vhostRaw === '') {
        vhost = '/';
    } else if (/%env\(|\$\{/.test(vhostRaw)) {
        vhost = undefined;
    } else {
        vhost = `/${vhostRaw}`;
    }

    return {
        provider,
        host,
        port,
        vhost,
        hasUnresolvedPlaceholders: hasUnresolved,
        rawDsn: dsn,
    };
}

/**
 * Find a registered (customer-declared) broker that matches the parsed DSN.
 * Matching priority:
 *   1. Exact host+port+vhost on the declared broker (best).
 *   2. host-only match when port/vhost are unknown from the DSN.
 *   3. Provider-only fallback when nothing else matches AND only one broker of
 *      that provider is declared (single-broker shortcut for monocluster repos).
 */
export function findDeclaredBrokerForDsn(
    parsed: ParsedAmqpDsn,
    declared: RegisteredBroker[],
): RegisteredBroker | undefined {
    const sameProvider = declared.filter(b => b.provider === parsed.provider);
    if (sameProvider.length === 0) return undefined;

    if (parsed.host) {
        const exact = sameProvider.find(b =>
            b.host === parsed.host
            && (parsed.port === undefined || b.port === undefined || b.port === parsed.port)
            && (parsed.vhost === undefined || b.vhost === undefined || b.vhost === parsed.vhost),
        );
        if (exact) return exact;
        const hostOnly = sameProvider.find(b => b.host === parsed.host);
        if (hostOnly) return hostOnly;
    }

    // Single-provider shortcut: when only one broker of this provider is declared
    // AND both sides agree on vhost (or one of them is unspecified), collapse on it.
    if (sameProvider.length === 1) {
        const only = sameProvider[0];
        if (parsed.vhost === undefined || only.vhost === undefined || parsed.vhost === only.vhost) {
            return only;
        }
    }
    return undefined;
}

export interface ResolvedBroker {
    urn: string;
    fingerprint: string;
    provider: MessageBrokerProvider;
    host?: string;
    port?: number;
    vhost?: string;
    region?: string;
    env?: string;
    cluster?: string;
    declaredVia: 'config' | 'inferred' | 'coderadius.yaml';
    confidence: number;
    /**
     * 'network' (default): host is a DNS name / IP and gets canonicalized via
     * `normalizeHost`. 'synthetic': host is a non-network identity (e.g. the
     * repo name 'acme/inventory-service' on a Symfony Messenger meta-broker)
     * and is stored verbatim — URL-based normalization would truncate it at
     * the first '/'.
     */
    hostKind?: 'network' | 'synthetic';
}

/**
 * Resolve a broker identity from a parsed DSN, biased toward the customer's
 * `coderadius.yaml.messageBrokers[]` declarations when ambiguous.
 *
 * Returns `null` when the DSN is fully unresolved AND no declared broker
 * matches. In that case the plugin should skip emitting a broker node and
 * fall back to scope='logical' for channels carried by this DSN.
 */
export function resolveBrokerFromDsn(
    parsed: ParsedAmqpDsn,
    declaredBrokers: RegisteredBroker[],
): ResolvedBroker | null {
    const declared = findDeclaredBrokerForDsn(parsed, declaredBrokers);
    if (declared) {
        return {
            urn: declared.urn,
            fingerprint: declared.fingerprint,
            provider: declared.provider,
            host: declared.host,
            port: declared.port,
            vhost: declared.vhost,
            region: declared.region,
            env: declared.env,
            cluster: declared.cluster,
            declaredVia: 'coderadius.yaml',
            confidence: 1.0,
        };
    }

    if (parsed.hasUnresolvedPlaceholders && !parsed.host) {
        return null;
    }

    const fingerprint = computeBrokerFingerprint({
        provider: parsed.provider,
        host: parsed.host,
        port: parsed.port,
        vhost: parsed.vhost,
    });
    return {
        urn: makeBrokerUrn(parsed.provider, fingerprint, parsed.vhost),
        fingerprint,
        provider: parsed.provider,
        host: parsed.host,
        port: parsed.port,
        vhost: parsed.vhost,
        declaredVia: parsed.hasUnresolvedPlaceholders ? 'inferred' : 'config',
        confidence: parsed.hasUnresolvedPlaceholders ? 0.3 : 0.9,
    };
}

/**
 * Resolve a broker by id (referenced in `channelAliases[].physical[].broker`)
 * from the registry. Returns undefined if the broker id is not declared.
 */
export function resolveBrokerById(id: string): RegisteredBroker | undefined {
    return getBrokerById(id);
}

/**
 * Build a `StructuralEntity` for a MessageBroker node. Idempotent: the URN
 * dedupes across all observation sites.
 *
 * Fix P2: stores normalized host (lowercase, no trailing dot, IPv6 brackets
 * stripped) to match the canonical form used by `computeBrokerFingerprint`.
 * In transparent URN mode, populates `displayHost` / `displayVhost` with the
 * case-preserved originals for UI debug. In opaque mode the same keys are
 * emitted with `null` values (NOT omitted): generic structural merge writes
 * the props verbatim, so `SET n.displayHost = null` acts as an explicit
 * removal of any stale value left by a previous transparent run. Mirrors the
 * `mergeMessageBroker` direct-mutator path so structural-plugin brokers and
 * synthesized brokers carry the same shape.
 */
export function buildBrokerEntity(resolved: ResolvedBroker, relationshipType: string = 'DEFINES'): StructuralEntity {
    // Synthetic hosts (repo-scoped meta-broker identities) are stored verbatim:
    // they are not DNS names and URL-parsing would truncate 'org/repo' → 'org'.
    const normalizedHost = resolved.host
        ? (resolved.hostKind === 'synthetic' ? resolved.host : normalizeHost(resolved.host))
        : null;
    const transparent = areUrnsTransparent();
    const properties: Record<string, unknown> = {
        provider: resolved.provider,
        fingerprint: resolved.fingerprint,
        host: normalizedHost,
        port: resolved.port ?? null,
        vhost: resolved.vhost ?? null,
        region: resolved.region ?? null,
        env: resolved.env ?? null,
        cluster: resolved.cluster ?? null,
        declaredVia: resolved.declaredVia,
        confidence: resolved.confidence,
    };
    // Fix P2.2: always populate displayHost/displayVhost keys so generic
    // structural merge (which writes the props verbatim) explicitly nullifies
    // stale values left over from a previous transparent run. In transparent
    // mode the originals are preserved; in opaque mode they are nullified
    // (Memgraph treats `SET n.prop = null` as removal). Mirrors the
    // mergeMessageBroker direct-mutator behaviour.
    properties.displayHost = transparent ? (resolved.host ?? null) : null;
    properties.displayVhost = transparent ? (resolved.vhost ?? null) : null;
    return {
        id: resolved.urn,
        labels: ['MessageBroker'],
        properties,
        relationshipType,
    };
}

/**
 * Build a `StructuralEntity` for a physical (broker-bound) MessageChannel.
 * Includes the `@brokerFp8` URN suffix so two same-name channels on different
 * brokers stay strictly distinct.
 */
export function buildPhysicalChannelEntity(args: {
    channelName: string;
    channelKind: 'topic' | 'queue' | 'subscription' | 'exchange';
    brokerUrn: string;
    brokerFingerprint: string;
    technology: string;
    durable?: boolean;
    autoDelete?: boolean;
    ordered?: boolean;
    relationshipType?: string;
}): StructuralEntity {
    const urn = makePhysicalChannelUrn(args.channelName, args.channelKind, args.brokerFingerprint);
    return {
        id: urn,
        labels: ['MessageChannel'],
        properties: {
            name: args.channelName,
            channelKind: args.channelKind,
            scope: 'physical',
            brokerUrn: args.brokerUrn,
            technology: args.technology,
            discoverySource: 'config',
            durable: args.durable ?? null,
            autoDelete: args.autoDelete ?? null,
            ordered: args.ordered ?? null,
        },
        relationshipType: args.relationshipType ?? 'DEFINES',
        edges: [{
            sourceUrn: urn,
            targetUrn: args.brokerUrn,
            type: 'HOSTED_ON',
        }],
    };
}

/**
 * Build a physical MessageChannel that is NOT bound to a resolved broker.
 *
 * Some config shapes (Laminas RabbitMqModule, Symfony-Messenger-as-PHP-array)
 * declare channel names but resolve the host via `Secret::read(...)` / `getenv`
 * which we deliberately leave UNRESOLVED. In that case we still emit the
 * channel so blast-radius sees the topology, but with NO `brokerUrn` and NO
 * `HOSTED_ON` edge — a synthetic host would be a fabricated identity. The
 * channel-broker-convergence welder later binds these by name overlap against
 * an infra-declared broker when one exists.
 *
 * URN omits the `@fingerprint` suffix (there is no broker fingerprint), so two
 * same-named unbound channels across files converge on one node by design.
 */
export function buildUnboundChannelEntity(args: {
    channelName: string;
    channelKind: 'topic' | 'queue' | 'exchange' | 'subscription';
    technology: string;
    /** Repo-relative path of the defining config file: resolves the
     *  StructuralFile DEFINES provenance edge (findStructuralFileUrn generic
     *  fallback) which is also the orphan-GC liveness signal. */
    sourcePath: string;
    /**
     * Config-level connection name this channel is declared under (oldsound
     * producer/consumer `connection`, messenger transport name). Join key of
     * the channel-connection binding pass: paired with `_sourcePath` it
     * resolves the channel onto the broker minted from the SAME file's
     * connection. NOTE the channel URN converges same-named channels across
     * files — connectionRef/_sourcePath are last-writer-wins but always a
     * consistent pair (single merge write).
     */
    connectionRef?: string;
    /** Repository URN of the declaring repo (cross-repo join guard). */
    repoUrn?: string;
    relationshipType?: string;
}): StructuralEntity {
    const kindSegment = args.channelKind === 'subscription' ? 'sub' : args.channelKind;
    const urn = `cr:channel:${kindSegment}:${args.channelName}`;
    return {
        id: urn,
        labels: ['MessageChannel'],
        properties: {
            name: args.channelName,
            channelKind: args.channelKind,
            scope: 'physical',
            technology: args.technology,
            discoverySource: 'config',
            _sourcePath: args.sourcePath,
            ...(args.connectionRef !== undefined ? { connectionRef: args.connectionRef } : {}),
            ...(args.repoUrn !== undefined ? { _repoUrn: args.repoUrn } : {}),
        },
        relationshipType: args.relationshipType ?? 'DEFINES',
    };
}

/**
 * Build a physical-channel URN. Kept inline to avoid pulling the graph
 * mutation layer into structural plugins.
 */
export function makePhysicalChannelUrn(
    name: string,
    kind: 'topic' | 'queue' | 'subscription' | 'exchange',
    brokerFingerprint: string,
): string {
    const kindSegment = kind === 'subscription' ? 'sub' : kind;
    return `cr:channel:${kindSegment}:${name}@${brokerFingerprint}`;
}
