/**
 * Laminas Symfony-Messenger-bridge Plugin — structural extraction of Symfony
 * Messenger config expressed as a plain PHP `return [...]` array (the Laminas
 * bridge form, as opposed to messenger.yaml).
 *
 * Shape (top-level 'symfony' wrapper optional):
 *
 *   return [
 *     'symfony' => [ 'messenger' => [
 *       'transports' => [
 *         'messenger.transport.async' => [
 *           'dsn'     => 'amqp://',
 *           'options' => [ 'exchange' => ['name' => 'acme.x'],
 *                          'queues'  => ['acme.q' => []] ],
 *         ],
 *         'messenger.transport.sync' => 'sync://',   // string transport: SKIP
 *       ],
 *     ]],
 *   ];
 *
 * Output: one MessageChannel{channelKind:'exchange'} from `options.exchange.name`
 * and one MessageChannel{channelKind:'queue'} per key of `options.queues`, per
 * array-shaped transport, technology 'rabbitmq', discoverySource 'config'.
 *
 * Rules:
 *   - String transports (e.g. 'sync://') are skipped.
 *   - Transports without amqp `options` (no exchange / queues) are skipped.
 *   - The transport NAME itself (e.g. 'messenger.transport.async') is a DI id
 *     and is NEVER emitted as a channel.
 *   - Channels are UNBOUND (no broker node): the DSN is typically a bare
 *     `amqp://` with no host; the welder binds by name overlap downstream.
 */

import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../../types.js';
import { parsePhpReturnConfig } from '../../../core/languages/php/config-array.js';
import { buildUnboundChannelEntity } from './messaging-helpers.js';

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

/**
 * Locate the `messenger` config block whether or not it is wrapped in the
 * top-level `symfony` key.
 */
function findMessengerBlock(config: Dict): Dict | null {
    const direct = asDict(config.messenger);
    if (direct) return direct;
    const symfony = asDict(config.symfony);
    return symfony ? asDict(symfony.messenger) : null;
}

/**
 * Collect exchange + queue channels for a single transport entry. String
 * transports and option-less transports contribute nothing. The TRANSPORT
 * NAME is the connection identity (each transport carries its own DSN) —
 * stamped as `connectionRef` for the channel-connection binding pass.
 */
function collectTransportChannels(
    transportName: string,
    transport: unknown,
    out: StructuralEntity[],
    ctx: { sourcePath: string; repoUrn: string },
): void {
    const options = asDict(asDict(transport)?.options);
    if (!options) return;

    const exchangeName = asDict(options.exchange)?.name;
    if (typeof exchangeName === 'string' && exchangeName.length > 0) {
        out.push(buildUnboundChannelEntity({
            sourcePath: ctx.sourcePath,
            channelName: exchangeName,
            channelKind: 'exchange',
            technology: 'rabbitmq',
            connectionRef: transportName,
            repoUrn: ctx.repoUrn,
        }));
    }

    const queues = asDict(options.queues);
    for (const queueName of Object.keys(queues ?? {})) {
        if (queueName.length === 0) continue;
        out.push(buildUnboundChannelEntity({
            sourcePath: ctx.sourcePath,
            channelName: queueName,
            channelKind: 'queue',
            technology: 'rabbitmq',
            connectionRef: transportName,
            repoUrn: ctx.repoUrn,
        }));
    }
}

export const laminasMessengerPhpPlugin: StructuralPlugin = {
    name: 'laminas-messenger-php',
    label: 'Laminas Symfony-Messenger (PHP array)',
    managedLabels: [],

    discoveryGlobs: ['**/*.php'],

    contentSignatures: [
        /'messenger'/,
        /'transports'/,
    ],

    matchFile(_relativePath: string, basename: string): boolean {
        return basename.endsWith('.php');
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const empty: StructuralExtractionResult = { entities: [], summary: '' };

        const config = asDict(parsePhpReturnConfig(content));
        const messenger = config ? findMessengerBlock(config) : null;
        const transports = asDict(messenger?.transports);
        if (!transports) return empty;

        const entities: StructuralEntity[] = [];
        const channelCtx = { sourcePath: context.relativePath, repoUrn: context.repoUrn };
        for (const [transportName, transport] of Object.entries(transports)) {
            collectTransportChannels(transportName, transport, entities, channelCtx);
        }
        if (entities.length === 0) return empty;

        const exchanges = entities.filter(e => e.properties.channelKind === 'exchange').length;
        const queues = entities.filter(e => e.properties.channelKind === 'queue').length;
        return {
            entities,
            summary: `Laminas messenger bridge: ${exchanges} exchange(s), ${queues} queue(s)`,
        };
    },
};
