/**
 * Channel-to-infra-broker convergence.
 *
 * Problem: `cr analyze code` infers a MessageBroker from runtime config
 * (`host=rabbitmq.example.com`, no vhost — the .env / coderadius.yaml only
 * carries the host endpoint). `cr analyze infra` reads a `definitions.json`
 * exported from RabbitMQ's Management API which carries the vhost topology
 * but NO host (the export is purely structural). The two end up as separate
 * `:MessageBroker` nodes on the graph, blocking cross-kind dedup (which
 * requires `brokerUrn` parity).
 *
 * This pass rewires code-derived MessageChannels to the infra-derived broker
 * when the channel's name uniquely matches an infra-derived channel on a
 * broker of the same provider. After the rewire, cross-kind dedup sees the
 * shared `brokerUrn` and collapses the pair.
 *
 * Safety guards:
 *   1. Only rewires channels whose current broker is "host-only" (host set,
 *      vhost null/empty) — the code-side broker shape. Skips channels already
 *      pinned to a fully-qualified (host + vhost) broker.
 *   2. Only rewires when the name maps UNAMBIGUOUSLY to a single infra
 *      broker (size of distinct candidate set = 1). Ambiguous names (same
 *      name in 2 vhosts) are left untouched.
 *   3. Provider must match. A channel on a kafka broker is never moved onto
 *      a rabbitmq broker.
 *
 * Idempotent: a second run is a no-op because the channel's brokerUrn is
 * already the infra broker, breaking the "host-only" guard.
 */

import { run, runInTransaction } from '../../graph/mutations/_run.js';

export interface ChannelBrokerConvergenceResult {
    /** Channels whose brokerUrn was rewired from a host-only broker to an infra-fingerprinted one. */
    rewired: number;
    /** Service→broker links created from ownership of rewired channels. */
    serviceLinks: number;
}

export async function runChannelBrokerConvergence(commitHash: string): Promise<ChannelBrokerConvergenceResult> {
    // Phase 1 — discover candidates. One row per code-side channel whose name
    // resolves to a UNIQUE infra-derived broker on the same provider.
    const candidates = await run(
        `MATCH (codeCh:MessageChannel)
         WHERE codeCh.valid_to_commit IS NULL
           AND codeCh.brokerUrn IS NOT NULL
           AND (codeCh.discoverySource IS NULL OR codeCh.discoverySource <> 'config')
         MATCH (codeBroker:MessageBroker {id: codeCh.brokerUrn})
         WHERE codeBroker.valid_to_commit IS NULL
           AND codeBroker.host IS NOT NULL
           AND codeBroker.host <> ''
           AND (codeBroker.vhost IS NULL OR codeBroker.vhost = '')
         MATCH (infraCh:MessageChannel)
         WHERE infraCh.valid_to_commit IS NULL
           AND infraCh.discoverySource = 'config'
           AND infraCh.name = codeCh.name
           AND infraCh.brokerUrn IS NOT NULL
           AND infraCh.brokerUrn <> codeCh.brokerUrn
         MATCH (infraBroker:MessageBroker {id: infraCh.brokerUrn})
         WHERE infraBroker.valid_to_commit IS NULL
           AND infraBroker.provider = codeBroker.provider
         WITH codeCh, codeBroker, collect(DISTINCT infraBroker.id) AS infraBrokerUrns
         WHERE size(infraBrokerUrns) = 1
         RETURN codeCh.id AS codeChannelUrn,
                codeBroker.id AS codeBrokerUrn,
                head(infraBrokerUrns) AS infraBrokerUrn`,
        {},
    );
    if (candidates.records.length === 0) {
        return { rewired: 0, serviceLinks: 0 };
    }

    // Phase 2 — apply each rewire in a separate, scoped statement. This avoids
    // the row-fanout that an aggregated SET + MERGE produces when count(DISTINCT)
    // is mixed with OPTIONAL MATCH on a pre-existing HOSTED_ON edge.
    let rewired = 0;
    let serviceLinks = 0;
    for (const rec of candidates.records) {
        const codeChannelUrn = rec.get('codeChannelUrn') as string;
        const codeBrokerUrn = rec.get('codeBrokerUrn') as string;
        const infraBrokerUrn = rec.get('infraBrokerUrn') as string;
        await runInTransaction([
            tx => tx.run(
                `MATCH (codeCh:MessageChannel {id: $codeChannelUrn})
                 SET codeCh.brokerUrn = $infraBrokerUrn,
                     codeCh.evidence_extractors = reduce(_acc = [], _x IN coalesce(codeCh.evidence_extractors, []) + ['channel-broker-convergence@v1'] |
                        CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
                { codeChannelUrn, infraBrokerUrn },
            ),
            tx => tx.run(
                `MATCH (codeCh:MessageChannel {id: $codeChannelUrn})-[oldH:HOSTED_ON]->(:MessageBroker {id: $codeBrokerUrn})
                 WHERE oldH.valid_to_commit IS NULL
                 SET oldH.valid_to_commit = $commit`,
                { codeChannelUrn, codeBrokerUrn, commit: commitHash },
            ),
            tx => tx.run(
                `MATCH (codeCh:MessageChannel {id: $codeChannelUrn}), (infraBroker:MessageBroker {id: $infraBrokerUrn})
                 MERGE (codeCh)-[newH:HOSTED_ON]->(infraBroker)
                 ON CREATE SET newH.valid_from_commit = $commit, newH.valid_to_commit = null
                 ON MATCH SET newH.valid_to_commit = null`,
                { codeChannelUrn, infraBrokerUrn, commit: commitHash },
            ),
            async tx => {
                const linked = await tx.run(
                    `MATCH (codeCh:MessageChannel {id: $codeChannelUrn})
                     MATCH (svc:Service)-[:CONTAINS]->(:Function)-[edge:PUBLISHES_TO|LISTENS_TO]->(codeCh)
                     WHERE edge.valid_to_commit IS NULL
                     WITH DISTINCT svc
                     MATCH (infraBroker:MessageBroker {id: $infraBrokerUrn})
                     MERGE (svc)-[rel:CONNECTS_TO {source: 'channel-convergence'}]->(infraBroker)
                     ON CREATE SET rel.valid_from_commit = $commit,
                                   rel.valid_to_commit = null,
                                   rel.via = 'channel-broker-convergence@v1'
                     ON MATCH SET rel.valid_to_commit = null,
                                  rel.via = coalesce(rel.via, 'channel-broker-convergence@v1')
                     RETURN count(rel) AS linked`,
                    { codeChannelUrn, infraBrokerUrn, commit: commitHash },
                ) as { records: Array<{ get(k: string): unknown }> };
                serviceLinks += Number(linked.records[0]?.get('linked') ?? 0);
            },
        ]);
        rewired++;
    }
    return { rewired, serviceLinks };
}
