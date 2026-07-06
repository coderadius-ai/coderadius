/**
 * interpretMessageChannel — pure interpreter for the `MessageChannel` infra
 * kind, extracted from persistFunction's inline case.
 *
 * Decisions preserved verbatim:
 *   - operation mapping: READS → LISTENS_TO, WRITES → PUBLISHES_TO (direct,
 *     not the old global capability heuristic that misclassified sagas);
 *   - env-var name resolution (direct + camelCase→SCREAMING_SNAKE) BEFORE the
 *     yaml alias pass; a resolution demotes grounding via `applyFallback`;
 *   - `routingKey` participates in the broker-edge identity so two publish
 *     sites with different keys stay two edges (cross-service T2 pattern
 *     matching depends on it);
 *   - subscription channels with a configured topic emit the sibling topic
 *     node plus a ROUTES_TO edge (empty bindingKey identity);
 *   - schema linkage needs a DB lookup (DataStructure by source file), so it
 *     leaves the interpreter as a `SchemaLinkIntent` for the caller.
 *
 * The name-resolution helpers (`resolveMessageChannelName` & co.) moved here
 * from graph-writer.ts — the sanitizer and edge-reconciler import them from
 * this module now instead of reaching into the 1.5k-line writer.
 */
import { applyFallback, type GroundingFields } from '../../../../graph/grounding.js';
import {
    emptyDelta,
    type EdgeUpsert,
    type GraphDelta,
    type NodeRef,
    type NodeUpsert,
    type PropRecord,
} from '../../../../graph/write-model/delta.js';
import { buildMessageChannelUrn, type MessageChannelKind } from '../../../../graph/mutations/data-contracts.js';
import { resolveMessageChannelAlias, type RepoHints } from '../../../../config/repo-hints.js';
import type { EnvVarBinding } from '../../infra-manifest-resolver.js';
import { groundingForInfra, type InfraWithGrounding } from './infra-grounding.js';
import type { InterpretLog, PersistTrace } from './types.js';

export interface MessageChannelInfraItem extends InfraWithGrounding {
    name: string;
    operation: 'READS' | 'WRITES' | 'MAPS_TO';
    channelKind?: MessageChannelKind;
    schemaPath?: string;
    schemaFormat?: string;
    technology?: string;
    /** AMQP routing key / SNS topic ARN / Pub/Sub literal — edge identity. */
    routingKey?: string;
    /** Kafka partition key extracted from a producer call. */
    partitionKey?: string;
    /** Consumer-group (Kafka) or subscription name (Pub/Sub / SQS). */
    consumerGroup?: string;
}

export interface MessageChannelInterpretContext {
    functionId: string;
    commitHash: string;
    repoHints: RepoHints;
    envVarDict: Map<string, EnvVarBinding>;
}

/** Channel↔schema link requiring a DB lookup — resolved by the caller. */
export interface SchemaLinkIntent {
    channelName: string;
    channelUrn: string;
    schemaPath: string;
}

export interface MessageChannelInterpretOutcome {
    delta: GraphDelta;
    traces: PersistTrace[];
    schemaLinks: SchemaLinkIntent[];
    logs: InterpretLog[];
}

export function interpretMessageChannel(
    item: MessageChannelInfraItem,
    ctx: MessageChannelInterpretContext,
): MessageChannelInterpretOutcome {
    const brokerOp = item.operation === 'READS' ? 'LISTENS_TO' as const : 'PUBLISHES_TO' as const;
    const logs: InterpretLog[] = [];

    const envResolvedName = resolveMessageChannelName(item.name, ctx.envVarDict);
    const wasEnvResolved = envResolvedName !== item.name;
    if (wasEnvResolved) {
        logs.push({ level: 'info', message: `Env var resolved MessageChannel: "${item.name}" → "${envResolvedName}"` });
    }

    const resolved = resolveMessageChannelForWrite({
        name: envResolvedName,
        channelKind: item.channelKind,
        schemaPath: item.schemaPath,
        schemaFormat: item.schemaFormat,
        technology: item.technology,
    }, ctx.repoHints);
    // channelKind guaranteed by sanitizer universal inference; fallback kept
    // for cache replay of pre-inference data.
    const effectiveKind = resolved.channelKind ?? 'topic';

    let channelProv = groundingForInfra(item, 'graph-writer@v1');
    if (wasEnvResolved) {
        channelProv = applyFallback(channelProv, 'env-var-stem-normalize', 'envvar-resolver@v1');
    }

    const channelUrn = buildMessageChannelUrn(resolved.name, effectiveKind);
    const delta = emptyDelta();
    delta.nodes.push(channelNode(channelUrn, resolved.name, effectiveKind, resolved, channelProv, ctx.commitHash));
    delta.edges.push(brokerEdge(brokerOp, channelUrn, item, channelProv, ctx));

    const schemaLinks: SchemaLinkIntent[] = resolved.schemaPath
        ? [{ channelName: resolved.name, channelUrn, schemaPath: resolved.schemaPath }]
        : [];

    if (effectiveKind === 'subscription' && resolved.topic) {
        appendTopicRouting(delta, channelUrn, resolved.topic, resolved.technology, channelProv, ctx.commitHash);
    }

    const traces: PersistTrace[] = [{
        action: 'WRITE',
        target: `channel:${resolved.name}`,
        reason: 'MessageChannel merged',
        meta: {
            functionId: ctx.functionId,
            operation: brokerOp,
            resolvedVia: item.resolved_via,
            channelKind: effectiveKind,
            schemaPath: resolved.schemaPath,
            schemaFormat: resolved.schemaFormat,
            aliasFrom: resolved.name !== item.name ? item.name : undefined,
        },
    }];
    return { delta, traces, schemaLinks, logs };
}

function channelNode(
    urn: string,
    name: string,
    channelKind: MessageChannelKind,
    opts: { technology?: string; schemaPath?: string; schemaFormat?: string; tags?: string[] },
    grounding: GroundingFields,
    commitHash: string,
): NodeUpsert {
    const props: PropRecord = { valid_to_commit: null, channelKind, scope: 'logical' };
    if (opts.technology) props.technology = opts.technology;
    if (opts.schemaPath) props.schemaPath = opts.schemaPath;
    if (opts.schemaFormat) props.schemaFormat = opts.schemaFormat;
    if (opts.tags && opts.tags.length > 0) props.tags = opts.tags;
    return {
        label: 'MessageChannel',
        urn,
        propsOnce: { name, valid_from_commit: commitHash },
        props,
        grounding,
    };
}

function brokerEdge(
    operation: 'PUBLISHES_TO' | 'LISTENS_TO',
    channelUrn: string,
    item: MessageChannelInfraItem,
    grounding: GroundingFields,
    ctx: MessageChannelInterpretContext,
): EdgeUpsert {
    const props: PropRecord = { valid_to_commit: null };
    if (operation === 'PUBLISHES_TO' && item.partitionKey) props.partitionKey = item.partitionKey;
    if (operation === 'LISTENS_TO' && item.consumerGroup) props.consumerGroup = item.consumerGroup;
    return {
        type: operation,
        from: { label: 'Function', urn: ctx.functionId },
        to: { label: 'MessageChannel', urn: channelUrn },
        keyProps: { routingKey: item.routingKey ?? null },
        propsOnce: { valid_from_commit: ctx.commitHash },
        props,
        grounding,
    };
}

function appendTopicRouting(
    delta: GraphDelta,
    subscriptionUrn: string,
    topicName: string,
    technology: string | undefined,
    grounding: GroundingFields,
    commitHash: string,
): void {
    const topicUrn = buildMessageChannelUrn(topicName, 'topic');
    delta.nodes.push(channelNode(topicUrn, topicName, 'topic', { technology }, grounding, commitHash));
    const subRef: NodeRef = { label: 'MessageChannel', urn: subscriptionUrn };
    const topicRef: NodeRef = { label: 'MessageChannel', urn: topicUrn };
    delta.edges.push({
        type: 'ROUTES_TO',
        from: subRef,
        to: topicRef,
        keyProps: { bindingKey: '' },
        propsOnce: { valid_from_commit: commitHash },
        props: { valid_to_commit: null },
        grounding,
    });
}

// ─── Channel-name resolution (moved from graph-writer.ts) ───────────────────

function inferSchemaFormatFromPath(schemaPath?: string): 'avro' | 'json-schema' | 'protobuf' | undefined {
    const lower = schemaPath?.toLowerCase();
    if (!lower) return undefined;
    if (lower.endsWith('.avsc')) return 'avro';
    if (lower.endsWith('.proto')) return 'protobuf';
    if (lower.endsWith('.schema.json') || lower.endsWith('.jsonschema')) return 'json-schema';
    return undefined;
}

function resolveMessageChannelForWrite(
    infra: { name: string; channelKind?: MessageChannelKind; schemaPath?: string; schemaFormat?: string; technology?: string },
    repoHints: RepoHints,
): {
    name: string;
    channelKind?: MessageChannelKind;
    technology?: string;
    schemaPath?: string;
    schemaFormat?: string;
    topic?: string;
    tags?: string[];
} {
    const alias = resolveMessageChannelAlias(repoHints, infra.name);
    if (!alias) {
        return {
            name: infra.name,
            channelKind: infra.channelKind,
            technology: infra.technology,
            schemaPath: infra.schemaPath,
            schemaFormat: infra.schemaFormat ?? inferSchemaFormatFromPath(infra.schemaPath),
        };
    }

    const schemaPath = alias.schemaPath ?? infra.schemaPath;
    return {
        name: alias.name,
        channelKind: alias.channelKind,
        technology: alias.technology ?? infra.technology,
        schemaPath,
        schemaFormat: alias.schemaFormat ?? infra.schemaFormat ?? inferSchemaFormatFromPath(schemaPath),
        topic: alias.topic,
        tags: alias.tags,
    };
}

/**
 * Convert camelCase or PascalCase to SCREAMING_SNAKE_CASE.
 * e.g. "myTopicName" → "MY_TOPIC_NAME"
 *      "MY_TOPIC_NAME" → "MY_TOPIC_NAME" (no-op)
 */
function camelToScreamingSnake(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toUpperCase();
}

/**
 * Attempt to resolve a MessageChannel name against the env var dictionary.
 *
 * Resolution cascade:
 *   1. Direct match: name (uppercased) is an env var key
 *      e.g. "MY_TOPIC_NAME" → "Acme-OrderCreated"
 *   2. camelCase→SCREAMING_SNAKE conversion:
 *      e.g. "myTopicName" → "MY_TOPIC_NAME" → "Acme-OrderCreated"
 *   3. No match → return original name unchanged
 */
export function resolveMessageChannelName(
    name: string,
    envVarDict: Map<string, EnvVarBinding>,
): string {
    if (envVarDict.size === 0) return name;

    const upper = name.toUpperCase();
    const direct = envVarDict.get(upper);
    if (direct) return direct.value;

    const snake = camelToScreamingSnake(name);
    if (snake !== upper) {
        const snakeMatch = envVarDict.get(snake);
        if (snakeMatch) return snakeMatch.value;
    }

    return name;
}
