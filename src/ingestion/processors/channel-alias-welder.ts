/**
 * Channel Alias Welder — customer-declared logical/physical convergence.
 *
 * Reads `coderadius.yaml.message_channels.mirrors[]` from the broker registry
 * and creates `(LogicalChannel)-[:MANIFESTS_AS]->(PhysicalChannel)` edges for
 * every declared mirror entry.
 *
 * Strict-isolation rule (memory: "no welding euristico cross-broker"): this
 * welder is the ONLY way two physical channels on different brokers get tied
 * together. Without an explicit `coderadius.yaml.mirrors[]` declaration, the
 * graph keeps separate nodes for each broker.
 *
 * Idempotent. Safe to call once per repo or globally at the end of the workflow.
 */

import { run } from '../../graph/mutations/_run.js';
import {
    manifestChannelAs,
    mergeMessageChannelWithKind,
    type MessageChannelKind,
} from '../../graph/mutations/data-contracts.js';
import { listMirrors, getBrokerById, type RegisteredBroker } from '../core/messaging/broker-registry.js';
import { logger } from '../../utils/logger.js';

export interface ChannelAliasWeldResult {
    /** Logical channels created or refreshed by the welder. */
    logicalChannels: number;
    /** MANIFESTS_AS edges created. */
    manifestsAsEdges: number;
    /** Mirror entries skipped because the referenced broker id was not declared. */
    danglingMirrors: number;
    /**
     * Customer-declared MANIFESTS_AS edges tombstoned in the sweep pass.
     * These are aliases that existed in a previous run but are no longer
     * declared in `coderadius.yaml.message_channels.mirrors[]`.
     */
    tombstonedAliases: number;
}

/**
 * Build the physical channel URN consistent with the structural plugins.
 *
 * Keep in sync with `makePhysicalChannelUrn` in
 * `src/ingestion/structural/plugins/messaging/messaging-helpers.ts`.
 */
function physicalChannelUrn(
    name: string,
    kind: MessageChannelKind,
    fingerprint: string,
): string {
    const kindSegment = kind === 'subscription' ? 'sub' : kind;
    return `cr:channel:${kindSegment}:${name}@${fingerprint}`;
}

export async function weldChannelAliases(commitHash: string): Promise<ChannelAliasWeldResult> {
    const mirrors = listMirrors();
    let logicalChannels = 0;
    let manifestsAsEdges = 0;
    let danglingMirrors = 0;

    // Mark phase: track every (logicalUrn, physicalUrn) pair materialized in
    // this run. These are the customer-declared aliases that MUST survive the
    // sweep below.
    const keptPairs: string[] = [];

    for (const mirror of mirrors) {
        const logicalUrn = await mergeMessageChannelWithKind(
            mirror.logical,
            mirror.kind as MessageChannelKind,
            'logical-channel',
            commitHash,
            { scope: 'logical', confidence: 1.0 },
        );
        logicalChannels++;

        for (const physical of mirror.physical) {
            const broker = getBrokerById(physical.broker);
            if (!broker) {
                logger.debug(
                    `[ChannelAliasWelder] Dangling mirror: broker id "${physical.broker}" ` +
                    `referenced by mirror "${mirror.logical}" is not declared in messageBrokers[]`,
                );
                danglingMirrors++;
                continue;
            }

            const physicalUrn = physicalChannelUrn(physical.channel, physical.kind, broker.fingerprint);

            await ensurePhysicalChannelNode(physicalUrn, {
                name: physical.channel,
                channelKind: physical.kind,
                brokerUrn: broker.urn,
                fingerprint: broker.fingerprint,
                technology: broker.provider,
                commitHash,
            });

            await manifestChannelAs(logicalUrn, physicalUrn, commitHash, 'coderadius.yaml', 1.0);
            manifestsAsEdges++;
            keptPairs.push(`${logicalUrn}|${physicalUrn}`);
        }
    }

    // Sweep phase (Gotcha #3 fix): tombstone any customer-declared MANIFESTS_AS
    // edge that is no longer present in the current `coderadius.yaml`. Without
    // this, a mirror removed from the yaml leaves a "zombie" alias edge alive
    // forever, because the per-edge MERGE in `manifestChannelAs` is unaware of
    // edges it does NOT touch.
    //
    // The query scopes the tombstone to `declaredVia = 'coderadius.yaml'` so
    // LLM-inferred MANIFESTS_AS edges (handled by a different welder, with
    // their own provenance) are never affected.
    const tombstonedAliases = await tombstoneStaleAliases(commitHash, keptPairs);

    return { logicalChannels, manifestsAsEdges, danglingMirrors, tombstonedAliases };
}

async function tombstoneStaleAliases(commitHash: string, keptPairs: string[]): Promise<number> {
    const result = await run(
        `MATCH (l:MessageChannel)-[r:MANIFESTS_AS]->(p:MessageChannel)
         WHERE r.declaredVia = 'coderadius.yaml'
           AND (r.valid_to_commit IS NULL)
           AND NOT (l.id + '|' + p.id) IN $keptPairs
         SET r.valid_to_commit = $commitHash
         RETURN count(r) AS tombstoned`,
        { commitHash, keptPairs },
    );
    // The mock returns `{ records: [] }` in tests; the real driver wraps the
    // count in an Integer. Be tolerant of both.
    const rec = (result as any)?.records?.[0];
    if (!rec) return 0;
    const v = typeof rec.get === 'function' ? rec.get('tombstoned') : rec.tombstoned;
    if (v == null) return 0;
    return typeof v === 'number' ? v : (typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
}

/**
 * Idempotent MERGE for a physical MessageChannel referenced by a customer
 * mirror declaration. Touches only properties the welder is responsible for
 * (scope='physical', brokerUrn). Other fields are left for the structural
 * plugin to populate authoritatively.
 */
async function ensurePhysicalChannelNode(
    urn: string,
    args: {
        name: string;
        channelKind: 'topic' | 'subscription' | 'queue' | 'exchange';
        brokerUrn: string;
        fingerprint: string;
        technology: string;
        commitHash: string;
    },
): Promise<void> {
    await run(
        `MERGE (ch:MessageChannel {id: $urn})
         ON CREATE SET ch.name = $name,
                       ch.channelKind = $channelKind,
                       ch.scope = 'physical',
                       ch.brokerUrn = $brokerUrn,
                       ch.technology = $technology,
                       ch.valid_from_commit = $commitHash,
                       ch.valid_to_commit = null,
                       ch.discoverySource = 'coderadius.yaml',
                       ch.createdAt = timestamp()
         ON MATCH SET ch.valid_to_commit = null,
                      ch.scope = coalesce(ch.scope, 'physical'),
                      ch.brokerUrn = coalesce(ch.brokerUrn, $brokerUrn),
                      ch.technology = coalesce(ch.technology, $technology)`,
        {
            urn,
            name: args.name,
            channelKind: args.channelKind,
            brokerUrn: args.brokerUrn,
            technology: args.technology,
            commitHash: args.commitHash,
        },
    );
}
