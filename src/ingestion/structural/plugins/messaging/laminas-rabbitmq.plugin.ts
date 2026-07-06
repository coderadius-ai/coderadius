/**
 * Laminas RabbitMqModule Plugin — structural extraction of the published
 * `return ['rabbitmq' => ...]` module contract.
 *
 * Shape (a Laminas/Mezzio autoload config):
 *
 *   return [
 *     'rabbitmq' => [
 *       'connection' => [ 'default' => ['host' => ..., 'vhost' => ...] ],
 *       'producer'   => [ '<name>' => [ 'exchange' => ['name' => 'acme.x', 'type' => 'fanout'],
 *                                       'queue'    => ['name' => 'acme.q'] (queue optional) ] ],
 *       'consumer'   => [ '<name>' => [ 'exchange' => [...], 'queue' => [...] ] ],
 *     ],
 *   ];
 *
 * Output: one MessageChannel{channelKind:'exchange'} per producer/consumer
 * exchange and one MessageChannel{channelKind:'queue'} per declared queue,
 * technology 'rabbitmq', discoverySource 'config'. Names come ONLY from literal
 * `exchange.name` / `queue.name`; non-literal values (Secret::read, getenv) are
 * UNRESOLVED and skipped.
 *
 * Broker binding: the connection host is typically `Secret::read(...)` which we
 * leave unresolved, so channels are emitted UNBOUND (no broker node, no
 * brokerUrn). The channel-broker-convergence welder binds them by name overlap
 * against an infra-declared broker downstream — we NEVER fabricate a host.
 *
 * House rule (content-signature-is-the-gate): `matchFile` accepts any `.php`;
 * the real recognition is `contentSignatures` on the rabbitmq/producer/consumer
 * /exchange keywords, so a renamed config file is still picked up by content.
 */

import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../../types.js';
import { parsePhpReturnConfig } from '../../../core/languages/php/config-array.js';
import { buildUnboundChannelEntity } from './messaging-helpers.js';

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function literalName(spec: unknown): string | null {
    const dict = asDict(spec);
    const name = dict?.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * Collect exchange + queue channel entities for one producer/consumer entry.
 * Pushes at most one exchange and one queue, both keyed by literal names.
 * `connectionRef` carries the entry's declared connection (module default:
 * 'default') — the join key of the channel-connection binding pass.
 */
function collectEntryChannels(entry: unknown, out: StructuralEntity[], ctx: { sourcePath: string; repoUrn: string }): void {
    const dict = asDict(entry);
    if (!dict) return;
    const connectionRef = typeof dict.connection === 'string' && dict.connection.length > 0
        ? dict.connection
        : 'default';

    const exchangeName = literalName(dict.exchange);
    if (exchangeName) {
        out.push(buildUnboundChannelEntity({
            sourcePath: ctx.sourcePath,
            channelName: exchangeName,
            channelKind: 'exchange',
            technology: 'rabbitmq',
            connectionRef,
            repoUrn: ctx.repoUrn,
        }));
    }

    const queueName = literalName(dict.queue);
    if (queueName) {
        out.push(buildUnboundChannelEntity({
            sourcePath: ctx.sourcePath,
            channelName: queueName,
            channelKind: 'queue',
            technology: 'rabbitmq',
            connectionRef,
            repoUrn: ctx.repoUrn,
        }));
    }
}

function collectRoleChannels(role: unknown, out: StructuralEntity[], ctx: { sourcePath: string; repoUrn: string }): void {
    const dict = asDict(role);
    if (!dict) return;
    for (const entry of Object.values(dict)) {
        collectEntryChannels(entry, out, ctx);
    }
}

export const laminasRabbitmqPlugin: StructuralPlugin = {
    name: 'laminas-rabbitmq',
    label: 'Laminas RabbitMqModule',
    managedLabels: [],

    // Permissive discovery; the content signature is the real gate.
    discoveryGlobs: ['**/*.php'],

    contentSignatures: [
        /'rabbitmq'/,
        /'producer'|'consumer'/,
        /'exchange'/,
    ],

    matchFile(_relativePath: string, basename: string): boolean {
        return basename.endsWith('.php');
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const empty: StructuralExtractionResult = { entities: [], summary: '' };

        const config = asDict(parsePhpReturnConfig(content));
        const rabbitmq = asDict(config?.rabbitmq);
        if (!rabbitmq) return empty;

        const entities: StructuralEntity[] = [];
        const channelCtx = { sourcePath: context.relativePath, repoUrn: context.repoUrn };
        collectRoleChannels(rabbitmq.producer, entities, channelCtx);
        collectRoleChannels(rabbitmq.consumer, entities, channelCtx);
        if (entities.length === 0) return empty;

        const exchanges = entities.filter(e => e.properties.channelKind === 'exchange').length;
        const queues = entities.filter(e => e.properties.channelKind === 'queue').length;
        return {
            entities,
            summary: `Laminas RabbitMqModule: ${exchanges} exchange(s), ${queues} queue(s)`,
        };
    },
};
