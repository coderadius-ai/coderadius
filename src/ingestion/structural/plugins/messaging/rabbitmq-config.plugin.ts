/**
 * RabbitMQ Config Plugin — Structural extraction of broker topology.
 *
 * Parses two file shapes:
 *   1. `rabbitmq-definitions.json` (RabbitMQ Management Plugin export):
 *      `exchanges[]`, `queues[]`, `bindings[]`.
 *   2. `rabbitmq.conf` (presence-only: exists → register an inferred broker).
 *
 * Output:
 *   - `MessageBroker{provider:'rabbitmq'}` (one per definitions file).
 *   - `MessageChannel{scope:'physical', channelKind:'exchange'|'queue', brokerUrn}`.
 *   - `ROUTES_TO` edges between exchange/queue with `bindingKey`, `isPattern`,
 *     `patternSyntax`, `patternRegex`.
 *
 * Strict isolation: the broker fingerprint uses `(host:port:vhost)` from the
 * declaration file when available; otherwise a stable salt based on the repo
 * is used so two separate rabbitmq-definitions.json files in the same repo
 * still produce distinct broker nodes if they describe distinct clusters.
 */

import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../../types.js';
import { compileAmqpTopicPattern } from '../../../core/messaging/amqp-topic-pattern.js';
import { logger } from '../../../../utils/logger.js';
import { listRegisteredBrokers, computeBrokerFingerprint, makeBrokerUrn, getBrokerByFingerprint, registerBrokerDeclaration } from '../../../core/messaging/broker-registry.js';
import { buildBrokerEntity, buildPhysicalChannelEntity, findDeclaredBrokerForDsn, makePhysicalChannelUrn, type ResolvedBroker } from './messaging-helpers.js';

interface RabbitMqExchange {
    name: string;
    vhost?: string;
    type?: string;       // 'direct' | 'topic' | 'fanout' | 'headers'
    durable?: boolean;
    auto_delete?: boolean;
}

interface RabbitMqQueue {
    name: string;
    vhost?: string;
    durable?: boolean;
    auto_delete?: boolean;
}

interface RabbitMqBinding {
    source: string;
    destination: string;
    destination_type?: string;   // 'queue' | 'exchange'
    vhost?: string;
    routing_key?: string;
    arguments?: Record<string, unknown>;
}

interface RabbitMqDefinitions {
    exchanges?: RabbitMqExchange[];
    queues?: RabbitMqQueue[];
    bindings?: RabbitMqBinding[];
}


/**
 * Resolve the broker for this definitions file, prioritising a customer
 * declaration. When none matches, register a synthetic broker keyed by the
 * file path so subsequent calls deduplicate idempotently.
 */
function resolveBrokerForDefinitions(
    relativePath: string,
    defaultVhost: string,
): ResolvedBroker {
    const declared = listRegisteredBrokers();
    const fakeParsed = {
        provider: 'rabbitmq' as const,
        host: undefined,
        port: undefined,
        vhost: defaultVhost,
        hasUnresolvedPlaceholders: false,
        rawDsn: '',
    };
    const declaredMatch = findDeclaredBrokerForDsn(fakeParsed, declared);
    if (declaredMatch) {
        return {
            urn: declaredMatch.urn,
            fingerprint: declaredMatch.fingerprint,
            provider: declaredMatch.provider,
            host: declaredMatch.host,
            port: declaredMatch.port,
            vhost: declaredMatch.vhost,
            region: declaredMatch.region,
            env: declaredMatch.env,
            cluster: declaredMatch.cluster,
            declaredVia: 'coderadius.yaml',
            confidence: 1.0,
        };
    }

    // Synthetic fallback: fingerprint derived from the relative path so that
    // re-runs are idempotent, but two distinct definitions files in the same
    // repo produce distinct broker nodes.
    const fingerprint = computeBrokerFingerprint({
        provider: 'rabbitmq',
        host: `local:${relativePath}`,
        vhost: defaultVhost,
    });
    const existing = getBrokerByFingerprint(fingerprint);
    if (existing) {
        return {
            urn: existing.urn,
            fingerprint: existing.fingerprint,
            provider: 'rabbitmq',
            vhost: existing.vhost,
            declaredVia: 'inferred',
            confidence: 0.5,
        };
    }
    const urn = makeBrokerUrn('rabbitmq', fingerprint, defaultVhost);
    // Also register so subsequent files (e.g. an env-specific overlay)
    // converge on the same node.
    registerBrokerDeclaration({
        id: `auto:${relativePath}`,
        provider: 'rabbitmq',
        vhost: defaultVhost,
        fingerprint,
    });
    return {
        urn,
        fingerprint,
        provider: 'rabbitmq',
        vhost: defaultVhost,
        declaredVia: 'inferred',
        confidence: 0.5,
    };
}

export const rabbitmqConfigPlugin: StructuralPlugin = {
    name: 'rabbitmq-config',
    label: 'RabbitMQ Definitions',
    managedLabels: [],

    // Wide discovery: every .json + rabbitmq.conf. The plugin manager filters
    // them via `contentSignatures` (regex on exchanges/queues/bindings keys),
    // so non-rabbit JSON (package.json, tsconfig.json, ...) is rejected
    // without ever entering `extract()`. This decouples recognition from the
    // filename, so a Management API export named `custom_definitions.json`,
    // `prod-rabbit.json`, or anything else is picked up by content.
    discoveryGlobs: ['**/*.json', '**/rabbitmq.conf'],

    contentSignatures: [
        /"exchanges"\s*:/m,
        /"bindings"\s*:/m,
        /"queues"\s*:/m,
        /^\s*listeners\.tcp\.default/m,    // rabbitmq.conf signature
    ],

    matchFile(_relativePath: string, basename: string): boolean {
        // Filename-only filter: accept rabbitmq.conf + any .json. The real
        // gate is `contentSignatures`.
        if (basename === 'rabbitmq.conf') return true;
        if (basename.endsWith('.json')) return true;
        return false;
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const empty: StructuralExtractionResult = { entities: [], summary: '' };

        // rabbitmq.conf: presence-only, register an inferred broker if none was declared.
        if (context.relativePath.endsWith('rabbitmq.conf')) {
            const resolved = resolveBrokerForDefinitions(context.relativePath, '/');
            return {
                entities: [buildBrokerEntity(resolved)],
                summary: `RabbitMQ broker inferred from rabbitmq.conf at ${context.relativePath}`,
            };
        }

        // Parse JSON definitions.
        let parsed: RabbitMqDefinitions;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            logger.debug(`[rabbitmq-config] Failed to parse ${context.relativePath}: ${(err as Error).message}`);
            return empty;
        }

        const exchanges = Array.isArray(parsed.exchanges) ? parsed.exchanges : [];
        const queues = Array.isArray(parsed.queues) ? parsed.queues : [];
        const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
        if (exchanges.length === 0 && queues.length === 0 && bindings.length === 0) return empty;

        // Pick the dominant vhost referenced by the file (most-frequent value),
        // used to fingerprint the broker when no customer declaration matches.
        const vhostCounts = new Map<string, number>();
        for (const items of [exchanges, queues, bindings]) {
            for (const item of items) {
                const v = item.vhost ?? '/';
                vhostCounts.set(v, (vhostCounts.get(v) ?? 0) + 1);
            }
        }
        const dominantVhost = Array.from(vhostCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '/';
        const broker = resolveBrokerForDefinitions(context.relativePath, dominantVhost);

        const entities: StructuralEntity[] = [];
        entities.push(buildBrokerEntity(broker));

        // Skip the AMQP default direct exchange (every vhost has it implicitly).
        const skipExchange = (name: string) => name === '' || name === 'amq.default';

        for (const ex of exchanges) {
            if (skipExchange(ex.name)) continue;
            const kind: 'exchange' | 'topic' = ex.type === 'topic' ? 'topic' : 'exchange';
            entities.push(buildPhysicalChannelEntity({
                channelName: ex.name,
                channelKind: kind,
                brokerUrn: broker.urn,
                brokerFingerprint: broker.fingerprint,
                technology: 'rabbitmq',
                durable: ex.durable,
                autoDelete: ex.auto_delete,
            }));
        }

        for (const q of queues) {
            entities.push(buildPhysicalChannelEntity({
                channelName: q.name,
                channelKind: 'queue',
                brokerUrn: broker.urn,
                brokerFingerprint: broker.fingerprint,
                technology: 'rabbitmq',
                durable: q.durable,
                autoDelete: q.auto_delete,
            }));
        }

        // ROUTES_TO edges with pattern compilation. We emit the edges on the
        // SOURCE entity (exchange) since the StructuralExtractionResult shape
        // permits arbitrary `edges[]` per entity.
        const routesByExchange = new Map<string, Array<{ source: string; target: string; props: Record<string, unknown> }>>();
        for (const binding of bindings) {
            if (skipExchange(binding.source)) continue;
            const destKind: 'queue' | 'exchange' | 'topic' =
                binding.destination_type === 'exchange'
                    ? 'exchange'
                    : 'queue';
            // Determine the source kind by looking at the exchange list.
            const sourceExchange = exchanges.find(e => e.name === binding.source);
            const sourceKind: 'topic' | 'exchange' = sourceExchange?.type === 'topic' ? 'topic' : 'exchange';
            const sourceUrn = makePhysicalChannelUrn(binding.source, sourceKind, broker.fingerprint);
            const targetUrn = makePhysicalChannelUrn(binding.destination, destKind, broker.fingerprint);
            const routingKey = binding.routing_key ?? '';
            const { regex, isPattern } = compileAmqpTopicPattern(routingKey);
            const props = {
                bindingKey: routingKey,
                isPattern,
                patternSyntax: sourceKind === 'topic' ? 'amqp-topic' : 'exact',
                patternRegex: regex,
            };
            const arr = routesByExchange.get(sourceUrn) ?? [];
            arr.push({ source: sourceUrn, target: targetUrn, props });
            routesByExchange.set(sourceUrn, arr);
        }

        for (const [exchangeUrn, edges] of routesByExchange) {
            const ent = entities.find(e => e.id === exchangeUrn);
            if (!ent) continue;
            const out = ent.edges ?? [];
            for (const e of edges) {
                out.push({
                    sourceUrn: e.source,
                    targetUrn: e.target,
                    type: 'ROUTES_TO',
                    properties: e.props,
                });
            }
            ent.edges = out;
        }

        return {
            entities,
            summary: `${exchanges.length} exchange(s), ${queues.length} queue(s), ${bindings.length} binding(s) on broker ${broker.urn}`,
        };
    },
};
