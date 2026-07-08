/**
 * Symfony Messenger Plugin — Structural extraction of `config/packages/messenger.yaml`.
 *
 * Symfony Messenger is a meta-broker: it wraps AMQP / Doctrine / Redis / SQS
 * with a uniform `dispatch(MessageClass)` API. The config we parse:
 *
 *   framework:
 *     messenger:
 *       transports:
 *         inventory: 'amqp://%env(RABBITMQ_URL)%/inventory'
 *         async-doctrine: 'doctrine://default'
 *       routing:
 *         'Acme\Inventory\Message\OrderRequested': inventory
 *         'Acme\Inventory\Message\OrderUpdated': [inventory, async-doctrine]
 *
 * Output (Phase 1):
 *   - One `MessageBroker{provider:'symfony-messenger'}` per repo (the framework
 *     virtual broker).
 *   - For each transport: one `MessageChannel{scope:'transport'}` plus an
 *     optional `BACKED_BY` edge to the physical channel inferred from the DSN.
 *   - For each routing entry: one `MessageChannel{scope:'logical'}` for the
 *     PHP message class, with `MANIFESTS_AS` edges to each routed transport.
 *
 * The underlying physical broker is resolved via `resolveBrokerFromDsn`, which
 * honours the customer's `coderadius.yaml.messageBrokers` declarations.
 */

import yaml from 'js-yaml';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../../types.js';
import { logger } from '../../../../utils/logger.js';
import { listRegisteredBrokers, computeBrokerFingerprint, makeBrokerUrn } from '../../../core/messaging/broker-registry.js';
import { buildBrokerEntity, parseAmqpDsn, resolveBrokerFromDsn } from './messaging-helpers.js';
import {
    MESSAGING_FILE_SIGNALS,
    isLikelyMessagingConfig,
    getPhpParser,
    stripTemplatePlaceholders,
} from '../../../core/config-value-providers/symfony-messenger-php.js';
import { extractMessageClassRoutingTable } from '../../../core/languages/php/message-class-routing-extractor.js';
import { buildUrn } from '../../../../graph/urn.js';
import { buildMessageChannelUrn } from '../../../../graph/mutations/data-contracts.js';

interface MessengerTransportConfig {
    dsn?: string;
    options?: Record<string, unknown>;
}

type RoutingValue = string | string[];

interface MessengerConfig {
    framework?: {
        messenger?: {
            transports?: Record<string, string | MessengerTransportConfig>;
            routing?: Record<string, RoutingValue>;
        };
    };
}

// Fix 8 P1.3: canonical URN builders via `buildMessageChannelUrn` instead of
// hardcoded `cr:channel:*` prefixes. Drift prevention if the URN scheme
// evolves centrally.
function buildLogicalChannelUrn(name: string): string {
    return buildMessageChannelUrn(name, 'topic');
}

function buildTransportChannelUrn(name: string): string {
    // Transport channels are a Symfony-Messenger-specific scope between logical
    // and physical. `buildMessageChannelUrn` only supports the canonical kinds
    // (topic/sub/queue/exchange), so the 'transport' scope is built via the
    // generic `buildUrn` helper to stay consistent with other URN segments.
    return buildUrn('channel', 'transport', name);
}

export const symfonyMessengerPlugin: StructuralPlugin = {
    name: 'symfony-messenger',
    label: 'Symfony Messenger',
    managedLabels: [],

    contentSignatures: [
        // YAML (Symfony Framework standard config).
        /^\s*messenger\s*:/m,
        /^\s*transports\s*:/m,
        // PHP-Factory pattern (Fix 8): routing array + messaging class/interface
        // signatures. The fail-safe `isLikelyMessagingConfig` inside the
        // extractor filters out RBAC/audit configs that share the
        // `Class::class => 'dotted.string'` shape.
        /\w+::class\s*=>/,
        /\bclass\s+\w*(?:AmqpConfig|MessageMap|MessageBus|MessageRegistry|RoutingTable|Messenger\w*)\b/,
        /\binterface\s+MessageBusInterface\b/,
    ],

    discoveryGlobs: [
        // YAML — same as `matchFile` but exposed declaratively (Fix 8).
        '**/config/packages/messenger.yaml',
        '**/config/packages/messenger.yml',
        '**/config/packages/*/messenger.yaml',
        '**/config/packages/*/messenger.yml',
        // PHP-Factory shape (Fix 8 — applications without messenger.yaml).
        '**/AmqpConfig.php',
        '**/MessengerConfig.php',
        '**/MessageMap.php',
        '**/MessageRegistry.php',
        '**/MessageBus.php',
        '**/RoutingTable.php',
        '**/*Amqp*Config*.php',
        '**/*Messenger*Config*.php',
    ],

    matchFile(relativePath: string, basename: string): boolean {
        if (basename === 'messenger.yaml' || basename === 'messenger.yml') return true;
        // Symfony often puts the file under `config/packages/messenger.yaml`,
        // but env-specific overlays live in `config/packages/<env>/messenger.yaml`.
        if (/\/config\/packages\/.*messenger\.(yaml|yml)$/.test(relativePath)) return true;
        // PHP-Factory pattern: applications that use symfony/messenger without
        // a messenger.yaml. The structural extraction is gated by the same
        // file-context signals the value-provider uses (see extract()).
        if (basename.endsWith('.php')) return true;
        return false;
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        if (context.relativePath.endsWith('.php')) {
            return extractFromPhpFactory(content, context);
        }
        const empty: StructuralExtractionResult = { entities: [], summary: '' };
        let parsed: MessengerConfig;
        try {
            parsed = (yaml.load(content) as MessengerConfig) ?? {};
        } catch (err) {
            logger.debug(`[symfony-messenger] Failed to parse YAML ${context.relativePath}: ${(err as Error).message}`);
            return empty;
        }
        const messenger = parsed.framework?.messenger;
        if (!messenger) return empty;

        const transports = messenger.transports ?? {};
        const routing = messenger.routing ?? {};
        if (Object.keys(transports).length === 0 && Object.keys(routing).length === 0) return empty;

        const entities: StructuralEntity[] = [];
        const summaries: string[] = [];

        // 1. The Symfony Messenger meta-broker (one per repo, idempotent).
        const metaFingerprint = computeBrokerFingerprint({
            provider: 'symfony-messenger',
            host: `repo:${context.repoName}`,
        });
        const metaUrn = makeBrokerUrn('symfony-messenger', metaFingerprint);
        const metaBroker = buildBrokerEntity({
            urn: metaUrn,
            fingerprint: metaFingerprint,
            provider: 'symfony-messenger',
            host: context.repoName,
            hostKind: 'synthetic', // repo identity, not a DNS host — skip normalizeHost
            declaredVia: 'config',
            confidence: 1.0,
        });
        entities.push(metaBroker);

        const declared = listRegisteredBrokers();

        // 2. Transports → MessageChannel(scope='transport') plus BACKED_BY edges.
        const transportPhysicalByName = new Map<string, string>();   // transportName → physical channel URN
        for (const [transportName, raw] of Object.entries(transports)) {
            const dsn = typeof raw === 'string' ? raw : raw.dsn ?? '';
            const transportUrn = buildTransportChannelUrn(transportName);
            const transportEntity: StructuralEntity = {
                id: transportUrn,
                labels: ['MessageChannel'],
                properties: {
                    name: transportName,
                    channelKind: 'topic',
                    scope: 'transport',
                    technology: 'symfony-messenger',
                    discoverySource: 'config',
                    brokerUrn: metaUrn,
                },
                relationshipType: 'DEFINES',
                edges: [
                    { sourceUrn: transportUrn, targetUrn: metaUrn, type: 'HOSTED_ON' },
                ],
            };
            entities.push(transportEntity);

            // Resolve underlying physical broker + channel from the DSN.
            const parsedDsn = parseAmqpDsn(dsn);
            if (!parsedDsn) {
                summaries.push(`Transport ${transportName} (no parseable DSN)`);
                continue;
            }
            const physBroker = resolveBrokerFromDsn(parsedDsn, declared);
            if (!physBroker) {
                summaries.push(`Transport ${transportName} → ${parsedDsn.provider} (unresolved)`);
                continue;
            }

            // Emit the physical broker entity.
            entities.push(buildBrokerEntity(physBroker));

            // Emit a physical channel for the transport (queue-shape on the
            // underlying broker). Name conventionally matches the transport name,
            // but is opaque to us; use it as the physical channel name.
            const physChannelUrn = buildMessageChannelUrn(transportName, 'queue', physBroker.fingerprint);
            entities.push({
                id: physChannelUrn,
                labels: ['MessageChannel'],
                properties: {
                    name: transportName,
                    channelKind: 'queue',
                    scope: 'physical',
                    brokerUrn: physBroker.urn,
                    technology: physBroker.provider,
                    discoverySource: 'config',
                },
                relationshipType: 'DEFINES',
                edges: [
                    { sourceUrn: physChannelUrn, targetUrn: physBroker.urn, type: 'HOSTED_ON' },
                ],
            });
            transportPhysicalByName.set(transportName, physChannelUrn);

            // Hook the transport channel up to the underlying physical channel.
            transportEntity.edges!.push({
                sourceUrn: transportUrn,
                targetUrn: physChannelUrn,
                type: 'BACKED_BY',
                properties: { declaredVia: 'config' },
            });
            summaries.push(`Transport ${transportName} → ${physBroker.urn}`);
        }

        // 3. Routing → MessageChannel(scope='logical') per MessageClass plus
        // MANIFESTS_AS edges toward the routed transport(s).
        for (const [messageClassFqn, routedTo] of Object.entries(routing)) {
            const targets = Array.isArray(routedTo) ? routedTo : [routedTo];
            const logicalUrn = buildLogicalChannelUrn(messageClassFqn);
            const logicalEntity: StructuralEntity = {
                id: logicalUrn,
                labels: ['MessageChannel'],
                properties: {
                    name: messageClassFqn,
                    channelKind: 'topic',
                    scope: 'logical',
                    technology: 'symfony-messenger',
                    discoverySource: 'config',
                },
                relationshipType: 'DEFINES',
                edges: [],
            };
            for (const transportName of targets) {
                const transportUrn = buildTransportChannelUrn(transportName);
                logicalEntity.edges!.push({
                    sourceUrn: logicalUrn,
                    targetUrn: transportUrn,
                    type: 'MANIFESTS_AS',
                    properties: { declaredVia: 'config', confidence: 1.0 },
                });
                // Also surface a direct MANIFESTS_AS to the underlying physical
                // channel so cross-service blast radius can traverse without a
                // second hop through the transport.
                const physUrn = transportPhysicalByName.get(transportName);
                if (physUrn) {
                    logicalEntity.edges!.push({
                        sourceUrn: logicalUrn,
                        targetUrn: physUrn,
                        type: 'MANIFESTS_AS',
                        properties: { declaredVia: 'config', confidence: 0.9 },
                    });
                }
            }
            entities.push(logicalEntity);
            summaries.push(`Routing ${messageClassFqn} → [${targets.join(', ')}]`);
        }

        return {
            entities,
            summary: summaries.join('; '),
        };
    },
};

// ─── PHP-Factory extraction ──────────────────────────────────────────────────

const NAMESPACE_DECLARATION_RE = /^\s*namespace\s+([\w\\]+)\s*[;{]/m;
// Factory-method shape: `function getMessageMap()`, `getRouting()`,
// `buildRoutes()`, `getQueueMap()`, etc. Used to detect a messaging file
// where the routing map is built dynamically (G7 edge case).
const FACTORY_METHOD_SHAPE = /function\s+(?:get|build)\w*(?:Map|Routing|Routes|Registry|Queue)\w*\s*\(/i;
// Captures `use Foo\Bar\Baz;` and `use Foo\Bar\Baz as Qux;` (also tolerates
// leading/trailing whitespace). Function/const aliases are out of scope.
const USE_STATEMENT_RE = /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/mg;

function buildUseAliasMap(content: string): Map<string, string> {
    const map = new Map<string, string>();
    let match: RegExpExecArray | null;
    USE_STATEMENT_RE.lastIndex = 0;
    while ((match = USE_STATEMENT_RE.exec(content)) !== null) {
        const fqcn = match[1].replace(/^\\+/, '');
        const alias = match[2] ?? (fqcn.split('\\').pop() ?? fqcn);
        map.set(alias, fqcn);
    }
    return map;
}

function resolveFqcn(shortName: string, useAliases: Map<string, string>, fileNamespace: string): string {
    const aliased = useAliases.get(shortName);
    if (aliased) return aliased;
    if (fileNamespace) return `${fileNamespace}\\${shortName}`;
    return shortName;
}

function extractFromPhpFactory(content: string, context: PluginContext): StructuralExtractionResult {
    const empty: StructuralExtractionResult = { entities: [], summary: '' };
    if (!isLikelyMessagingConfig(content)) return empty;

    let tree;
    try {
        tree = getPhpParser().parse(content);
    } catch (err) {
        logger.debug(`[symfony-messenger] Failed to parse PHP ${context.relativePath}: ${(err as Error).message}`);
        return empty;
    }
    if (!tree?.rootNode) return empty;

    const routingTable = extractMessageClassRoutingTable(tree.rootNode);
    if (routingTable.size === 0) {
        // G7 edge case: file is messaging-shaped (passed isLikelyMessagingConfig)
        // but the routing array is built dynamically (loop / external loader /
        // config service) — the static extractor cannot recover the map. To
        // avoid a silent false-negative on a file the customer expects to be
        // recognised, stamp `needsReview=true` on the SourceFile so it surfaces
        // in `cr doctor`. No MessageChannel/Broker emitted (a partial
        // graph would be worse than the miss).
        if (FACTORY_METHOD_SHAPE.test(content)) {
            const sourceFileUrn = buildUrn('sourcefile', context.repoName, context.relativePath);
            return {
                entities: [{
                    id: sourceFileUrn,
                    labels: ['SourceFile'],
                    properties: {
                        path: context.relativePath,
                        needsReview: true,
                        evidence_extractors: ['symfony-messenger-dynamic-routing@v1'],
                    },
                    relationshipType: 'DEFINES',
                    edges: [],
                }],
                summary: `Dynamic messenger routing in ${context.relativePath} — flagged for review`,
            };
        }
        return empty;
    }

    const nsMatch = NAMESPACE_DECLARATION_RE.exec(content);
    const fileNamespace = nsMatch?.[1] ?? '';
    const useAliases = buildUseAliasMap(content);

    const entities: StructuralEntity[] = [];
    const summaries: string[] = [];

    // 1. Meta-broker (one per repo, idempotent: same URN as the YAML path).
    const metaFingerprint = computeBrokerFingerprint({
        provider: 'symfony-messenger',
        host: `repo:${context.repoName}`,
    });
    const metaUrn = makeBrokerUrn('symfony-messenger', metaFingerprint);
    entities.push(buildBrokerEntity({
        urn: metaUrn,
        fingerprint: metaFingerprint,
        provider: 'symfony-messenger',
        host: context.repoName,
        hostKind: 'synthetic', // repo identity, not a DNS host — skip normalizeHost
        declaredVia: 'config',
        confidence: 1.0,
    }));

    // 2 & 3. For each MessageClass routed, emit transport channel +
    // logical channel + MANIFESTS_AS. Transports are keyed by the stripped
    // (env-placeholder-free) routing key, which matches how the autopromoter
    // and the value-resolution layer canonicalise the channel identity.
    const transportsEmitted = new Set<string>();
    for (const [shortName, rawRoutingKey] of routingTable) {
        const transportName = stripTemplatePlaceholders(rawRoutingKey);
        if (!transportName) continue;

        const transportUrn = buildTransportChannelUrn(transportName);
        if (!transportsEmitted.has(transportUrn)) {
            entities.push({
                id: transportUrn,
                labels: ['MessageChannel'],
                properties: {
                    name: transportName,
                    channelKind: 'topic',
                    scope: 'transport',
                    technology: 'symfony-messenger',
                    discoverySource: 'config',
                    brokerUrn: metaUrn,
                },
                relationshipType: 'DEFINES',
                edges: [
                    { sourceUrn: transportUrn, targetUrn: metaUrn, type: 'HOSTED_ON' },
                ],
            });
            transportsEmitted.add(transportUrn);
        }

        const messageFqcn = resolveFqcn(shortName, useAliases, fileNamespace);
        const logicalUrn = buildLogicalChannelUrn(messageFqcn);
        entities.push({
            id: logicalUrn,
            labels: ['MessageChannel'],
            properties: {
                name: messageFqcn,
                channelKind: 'topic',
                scope: 'logical',
                technology: 'symfony-messenger',
                discoverySource: 'config',
            },
            relationshipType: 'DEFINES',
            edges: [{
                sourceUrn: logicalUrn,
                targetUrn: transportUrn,
                type: 'MANIFESTS_AS',
                properties: { declaredVia: 'config', confidence: 1.0 },
            }],
        });

        summaries.push(`Routing ${messageFqcn} → ${transportName}`);
    }

    return { entities, summary: summaries.join('; ') };
}
