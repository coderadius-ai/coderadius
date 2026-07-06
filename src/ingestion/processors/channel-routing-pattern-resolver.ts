/**
 * Channel routing-key → infra-queue welder.
 *
 * The LLM emits MessageChannel nodes whose name is the routing key the
 * publisher uses (`inventory.motor.save.ready`, `acme.shipping.update`).
 * The RabbitMQ topology (definitions.json) exposes those routing keys as
 * BINDINGS — `(exchange) -[:ROUTES_TO {bindingKey, patternRegex, patternSyntax}]->
 * (queue)` — not as channel names. So `channel-broker-convergence` (which
 * matches names exactly) can't rewire them, and the channels stay
 * `needsReview=true`.
 *
 * This welder closes the gap. For every code-side channel whose name has
 * NO exact infra counterpart (broker-convergence + cross-kind dedup already
 * handle that case), test the name against every live `ROUTES_TO` binding
 * on a broker with the same provider. When exactly ONE binding matches:
 *
 *   1. Move PUBLISHES_TO + LISTENS_TO edges (3-way branched by identity
 *      key: routingKey > consumerGroup > bare) onto the destination queue,
 *      preserving all edge properties via `properties()`.
 *   2. Move HAS_SCHEMA, CARRIED_BY, and live MANIFESTS_AS edges onto the
 *      queue so logical/schema chains aren't lost.
 *   3. Stamp `channel-routing-pattern-resolver@v1` on the queue.
 *   4. DETACH DELETE the code-channel (routing-key placeholder, no
 *      archival value).
 *
 * Reviewer-validated invariants (v1→v8):
 *   - Welder is COMPLETE: does not delegate the final merge to cross-kind
 *     dedup, which requires `name` parity that this case lacks.
 *   - Phase 1 + Phase 2: candidate discovery uniform, per-row apply atomic
 *     via `runInTransaction` (no Memgraph row-fanout, all-or-nothing).
 *   - Idempotent: post-rewire the code-channel is DETACHed, so the second
 *     run finds zero candidates.
 *   - Provider-guarded everywhere (codeBroker.provider == infraBroker.provider)
 *     to prevent cross-tech contamination (Kafka topic → RabbitMQ queue).
 *   - patternSyntax-branched: `'amqp-topic'` uses regex `=~`, `'exact'` uses
 *     literal `bindingKey = name` (rabbitmq plugin emits regex uniformly
 *     even for direct exchanges, so `=~` on `'exact'` would falso-match
 *     wildcards literali).
 *   - Exact-counterpart guard: if an exact-name infra channel exists on a
 *     same-provider broker, skip — broker-convergence + cross-kind own that
 *     case. Without this, a wildcard binding could rewire the code channel
 *     onto the wrong queue.
 *   - Ambiguity stamp: when 2+ bindings match, stamp
 *     `channel-routing-pattern-ambiguous@v1` + `needsReview=true` so the
 *     reviewer sees it in `cr review pending`.
 */

import { runInTransaction, run } from '../../graph/mutations/_run.js';

export interface ChannelRoutingPatternResolverResult {
    /** Code channels successfully rewired onto an infra queue. */
    rewired: number;
    /** Code channels marked ambiguous (multiple bindings matched). */
    ambiguousMarked: number;
}

interface Candidate {
    codeChannelUrn: string;
    queueUrn: string;
}

export async function runChannelRoutingPatternResolver(commitHash: string): Promise<ChannelRoutingPatternResolverResult> {
    const candidates = await discoverCandidates();
    if (candidates.length === 0) {
        const ambiguousMarked = await markAmbiguousCandidates(commitHash);
        return { rewired: 0, ambiguousMarked };
    }

    let rewired = 0;
    for (const c of candidates) {
        await applyRewire(c, commitHash);
        rewired++;
    }
    const ambiguousMarked = await markAmbiguousCandidates(commitHash);
    return { rewired, ambiguousMarked };
}

/**
 * Phase 1 — Discover code channels whose name resolves to a UNIQUE infra
 * queue via an `amqp-topic` or `exact` binding on a same-provider broker,
 * with no exact-name infra counterpart already covering the case.
 */
async function discoverCandidates(): Promise<Candidate[]> {
    const r = await run(
        `MATCH (codeCh:MessageChannel)
         WHERE codeCh.valid_to_commit IS NULL
           AND codeCh.scope = 'physical'
           AND codeCh.brokerUrn IS NOT NULL
           AND (codeCh.discoverySource IS NULL OR codeCh.discoverySource <> 'config')
         MATCH (codeBroker:MessageBroker {id: codeCh.brokerUrn})
         WHERE codeBroker.valid_to_commit IS NULL
           AND codeBroker.host IS NOT NULL AND codeBroker.host <> ''
           AND (codeBroker.vhost IS NULL OR codeBroker.vhost = '')
         // Exact-counterpart guard via OPTIONAL MATCH (Memgraph EXISTS{}
         // subqueries trip the engine on this shape). If any infra-derived
         // channel has the same name on a same-provider broker, defer to
         // broker-convergence + cross-kind dedup.
         OPTIONAL MATCH (other:MessageChannel)
         WHERE other.valid_to_commit IS NULL
           AND other.id <> codeCh.id
           AND other.name = codeCh.name
           AND other.discoverySource = 'config'
           AND other.scope = 'physical'
           AND other.brokerUrn IS NOT NULL
         OPTIONAL MATCH (otherBroker:MessageBroker {id: other.brokerUrn})
         WITH codeCh, codeBroker,
              collect(DISTINCT CASE
                  WHEN otherBroker.valid_to_commit IS NULL AND otherBroker.provider = codeBroker.provider THEN other.id
                  ELSE null
              END) AS exactIds
         WITH codeCh, codeBroker, [x IN exactIds WHERE x IS NOT NULL] AS exactCounterparts
         WHERE size(exactCounterparts) = 0
         MATCH (exch:MessageChannel)-[bind:ROUTES_TO]->(queue:MessageChannel)
         WHERE bind.valid_to_commit IS NULL
           AND exch.valid_to_commit IS NULL
           AND exch.discoverySource = 'config'
           AND exch.brokerUrn = queue.brokerUrn
           AND queue.valid_to_commit IS NULL
           AND queue.discoverySource = 'config'
           AND queue.channelKind = 'queue'
           AND queue.brokerUrn IS NOT NULL
           AND queue.brokerUrn <> codeCh.brokerUrn
           AND (
                (bind.patternSyntax = 'amqp-topic' AND bind.patternRegex IS NOT NULL AND codeCh.name =~ bind.patternRegex)
                OR
                (bind.patternSyntax = 'exact' AND bind.bindingKey = codeCh.name)
           )
         MATCH (infraBroker:MessageBroker {id: queue.brokerUrn})
         WHERE infraBroker.valid_to_commit IS NULL
           AND infraBroker.provider = codeBroker.provider
         WITH codeCh, collect(DISTINCT queue.id) AS matchedQueues
         WHERE size(matchedQueues) = 1
         RETURN codeCh.id AS codeChannelUrn, head(matchedQueues) AS queueUrn`,
        {},
    );
    return r.records.map(rec => ({
        codeChannelUrn: rec.get('codeChannelUrn') as string,
        queueUrn: rec.get('queueUrn') as string,
    }));
}

/**
 * Stamp the ambiguity marker on every code channel whose name matches 2+
 * bindings. Reviewer can pin the intended one via the alias workflow.
 * Idempotent via the reduce() dedup.
 */
async function markAmbiguousCandidates(commitHash: string): Promise<number> {
    const r = await run(
        `MATCH (codeCh:MessageChannel)
         WHERE codeCh.valid_to_commit IS NULL
           AND codeCh.scope = 'physical'
           AND codeCh.brokerUrn IS NOT NULL
           AND (codeCh.discoverySource IS NULL OR codeCh.discoverySource <> 'config')
         MATCH (codeBroker:MessageBroker {id: codeCh.brokerUrn})
         WHERE codeBroker.valid_to_commit IS NULL
           AND codeBroker.host IS NOT NULL AND codeBroker.host <> ''
           AND (codeBroker.vhost IS NULL OR codeBroker.vhost = '')
         OPTIONAL MATCH (other:MessageChannel)
         WHERE other.valid_to_commit IS NULL
           AND other.id <> codeCh.id
           AND other.name = codeCh.name
           AND other.discoverySource = 'config'
           AND other.scope = 'physical'
           AND other.brokerUrn IS NOT NULL
         OPTIONAL MATCH (otherBroker:MessageBroker {id: other.brokerUrn})
         WITH codeCh, codeBroker,
              collect(DISTINCT CASE
                  WHEN otherBroker.valid_to_commit IS NULL AND otherBroker.provider = codeBroker.provider THEN other.id
                  ELSE null
              END) AS exactIds
         WITH codeCh, codeBroker, [x IN exactIds WHERE x IS NOT NULL] AS exactCounterparts
         WHERE size(exactCounterparts) = 0
         MATCH (exch:MessageChannel)-[bind:ROUTES_TO]->(queue:MessageChannel)
         WHERE bind.valid_to_commit IS NULL
           AND exch.valid_to_commit IS NULL
           AND exch.discoverySource = 'config'
           AND exch.brokerUrn = queue.brokerUrn
           AND queue.valid_to_commit IS NULL
           AND queue.discoverySource = 'config'
           AND queue.channelKind = 'queue'
           AND queue.brokerUrn IS NOT NULL
           AND queue.brokerUrn <> codeCh.brokerUrn
           AND (
                (bind.patternSyntax = 'amqp-topic' AND bind.patternRegex IS NOT NULL AND codeCh.name =~ bind.patternRegex)
                OR
                (bind.patternSyntax = 'exact' AND bind.bindingKey = codeCh.name)
           )
         MATCH (infraBroker:MessageBroker {id: queue.brokerUrn})
         WHERE infraBroker.valid_to_commit IS NULL
           AND infraBroker.provider = codeBroker.provider
         WITH codeCh, collect(DISTINCT queue.id) AS matchedQueues
         WHERE size(matchedQueues) > 1
           AND NOT ('channel-routing-pattern-ambiguous@v1' IN coalesce(codeCh.evidence_extractors, []))
         SET codeCh.evidence_extractors = reduce(_acc = [], _x IN coalesce(codeCh.evidence_extractors, []) + ['channel-routing-pattern-ambiguous@v1'] |
            CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
             codeCh.needsReview = true
         RETURN count(codeCh) AS ambiguous`,
        {},
    );
    return Number(r.records[0]?.get('ambiguous') ?? 0);
}

/**
 * Phase 2 — Apply one rewire atomically. Six sub-steps inside ONE Memgraph
 * transaction (via runInTransaction). On any failure mid-tx, Memgraph rolls
 * back and the code-channel stays untouched → next run retries cleanly.
 */
async function applyRewire(c: Candidate, commitHash: string): Promise<void> {
    await runInTransaction([
        // 2a — PUBLISHES_TO with routingKey identity.
        tx => moveLikeEdges(tx, c, commitHash, 'PUBLISHES_TO', 'routingKey'),
        // 2a — PUBLISHES_TO without routingKey (bare merge).
        tx => moveLikeEdgesBare(tx, c, commitHash, 'PUBLISHES_TO', 'routingKey'),
        // 2b — LISTENS_TO with routingKey identity.
        tx => moveLikeEdges(tx, c, commitHash, 'LISTENS_TO', 'routingKey'),
        // 2b — LISTENS_TO with consumerGroup identity (no routingKey).
        tx => moveLikeEdgesConsumerGroup(tx, c, commitHash, 'LISTENS_TO'),
        // 2b — LISTENS_TO bare (no routingKey, no consumerGroup).
        tx => moveLikeEdgesBareNoConsumerGroup(tx, c, commitHash, 'LISTENS_TO'),
        // 2c — HAS_SCHEMA (queue->DataStructure).
        tx => moveHasSchema(tx, c, commitHash),
        // 2d — CARRIED_BY (DataStructure->queue).
        tx => moveCarriedBy(tx, c, commitHash),
        // 2e — MANIFESTS_AS (logical->queue).
        tx => moveManifestsAs(tx, c, commitHash),
        // 2f — Stamp queue evidence.
        tx => stampQueueEvidence(tx, c),
        // 2g — DETACH DELETE code-channel.
        tx => detachCodeChannel(tx, c),
    ]);
}

type Tx = { run: (cypher: string, params?: Record<string, unknown>) => Promise<unknown> };

async function moveLikeEdges(tx: Tx, c: Candidate, commit: string, edgeType: 'PUBLISHES_TO' | 'LISTENS_TO', identityProp: 'routingKey'): Promise<void> {
    // Memgraph cannot use a relationship variable's property as a MERGE
    // identity key (`MERGE (a)-[r:X {k: oldR.k}]->(b)` collapses to bare
    // MERGE). Read the live edges first, then MERGE one at a time with the
    // identity value bound as a $param.
    const r = await tx.run(
        `MATCH (f:Function)-[oldR:${edgeType}]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL AND oldR.${identityProp} IS NOT NULL
         RETURN f.id AS fnId, properties(oldR) AS props, id(oldR) AS oldEdgeId`,
        { codeChannelUrn: c.codeChannelUrn },
    ) as { records: Array<{ get(k: string): unknown }> };
    for (const rec of r.records) {
        const fnId = rec.get('fnId') as string;
        const props = rec.get('props') as Record<string, unknown>;
        const oldEdgeId = rec.get('oldEdgeId') as unknown;
        const identityValue = props[identityProp];
        await tx.run(
            `MATCH (f:Function {id: $fnId}), (queue:MessageChannel {id: $queueUrn})
             MERGE (f)-[newR:${edgeType} {${identityProp}: $identityValue}]->(queue)
             ON CREATE SET newR = $props, newR.valid_from_commit = $commit, newR.valid_to_commit = null
             ON MATCH SET newR += $props, newR.valid_to_commit = null`,
            { fnId, queueUrn: c.queueUrn, identityValue, props, commit },
        );
        await tx.run(
            `MATCH ()-[oldR]->() WHERE id(oldR) = $oldEdgeId SET oldR.valid_to_commit = $commit`,
            { oldEdgeId, commit },
        );
    }
}

async function moveLikeEdgesBare(tx: Tx, c: Candidate, commit: string, edgeType: 'PUBLISHES_TO' | 'LISTENS_TO', excludeProp: 'routingKey'): Promise<void> {
    await tx.run(
        `MATCH (f:Function)-[oldR:${edgeType}]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL AND oldR.${excludeProp} IS NULL
         MATCH (queue:MessageChannel {id: $queueUrn})
         MERGE (f)-[newR:${edgeType}]->(queue)
         ON CREATE SET newR = properties(oldR), newR.valid_from_commit = $commit, newR.valid_to_commit = null
         ON MATCH SET newR += properties(oldR), newR.valid_to_commit = null
         SET oldR.valid_to_commit = $commit`,
        { codeChannelUrn: c.codeChannelUrn, queueUrn: c.queueUrn, commit },
    );
}

async function moveLikeEdgesConsumerGroup(tx: Tx, c: Candidate, commit: string, edgeType: 'LISTENS_TO'): Promise<void> {
    // Same Memgraph-MERGE-with-var-ref workaround as moveLikeEdges.
    const r = await tx.run(
        `MATCH (f:Function)-[oldR:${edgeType}]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL
           AND oldR.routingKey IS NULL
           AND oldR.consumerGroup IS NOT NULL
         RETURN f.id AS fnId, properties(oldR) AS props, id(oldR) AS oldEdgeId`,
        { codeChannelUrn: c.codeChannelUrn },
    ) as { records: Array<{ get(k: string): unknown }> };
    for (const rec of r.records) {
        const fnId = rec.get('fnId') as string;
        const props = rec.get('props') as Record<string, unknown>;
        const oldEdgeId = rec.get('oldEdgeId') as unknown;
        const consumerGroup = props.consumerGroup;
        await tx.run(
            `MATCH (f:Function {id: $fnId}), (queue:MessageChannel {id: $queueUrn})
             MERGE (f)-[newR:${edgeType} {consumerGroup: $cg}]->(queue)
             ON CREATE SET newR = $props, newR.valid_from_commit = $commit, newR.valid_to_commit = null
             ON MATCH SET newR += $props, newR.valid_to_commit = null`,
            { fnId, queueUrn: c.queueUrn, cg: consumerGroup, props, commit },
        );
        await tx.run(
            `MATCH ()-[oldR]->() WHERE id(oldR) = $oldEdgeId SET oldR.valid_to_commit = $commit`,
            { oldEdgeId, commit },
        );
    }
}

async function moveLikeEdgesBareNoConsumerGroup(tx: Tx, c: Candidate, commit: string, edgeType: 'LISTENS_TO'): Promise<void> {
    await tx.run(
        `MATCH (f:Function)-[oldR:${edgeType}]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL
           AND oldR.routingKey IS NULL
           AND oldR.consumerGroup IS NULL
         MATCH (queue:MessageChannel {id: $queueUrn})
         MERGE (f)-[newR:${edgeType}]->(queue)
         ON CREATE SET newR = properties(oldR), newR.valid_from_commit = $commit, newR.valid_to_commit = null
         ON MATCH SET newR += properties(oldR), newR.valid_to_commit = null
         SET oldR.valid_to_commit = $commit`,
        { codeChannelUrn: c.codeChannelUrn, queueUrn: c.queueUrn, commit },
    );
}

async function moveHasSchema(tx: Tx, c: Candidate, commit: string): Promise<void> {
    await tx.run(
        `MATCH (:MessageChannel {id: $codeChannelUrn})-[oldR:HAS_SCHEMA]->(ds:DataStructure)
         WHERE oldR.valid_to_commit IS NULL
         MATCH (queue:MessageChannel {id: $queueUrn})
         MERGE (queue)-[newR:HAS_SCHEMA]->(ds)
         ON CREATE SET newR = properties(oldR), newR.valid_from_commit = $commit, newR.valid_to_commit = null
         ON MATCH SET newR += properties(oldR), newR.valid_to_commit = null
         SET oldR.valid_to_commit = $commit`,
        { codeChannelUrn: c.codeChannelUrn, queueUrn: c.queueUrn, commit },
    );
}

async function moveCarriedBy(tx: Tx, c: Candidate, commit: string): Promise<void> {
    await tx.run(
        `MATCH (ds:DataStructure)-[oldR:CARRIED_BY]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL
         MATCH (queue:MessageChannel {id: $queueUrn})
         MERGE (ds)-[newR:CARRIED_BY]->(queue)
         ON CREATE SET newR = properties(oldR), newR.valid_from_commit = $commit, newR.valid_to_commit = null
         ON MATCH SET newR += properties(oldR), newR.valid_to_commit = null
         SET oldR.valid_to_commit = $commit`,
        { codeChannelUrn: c.codeChannelUrn, queueUrn: c.queueUrn, commit },
    );
}

async function moveManifestsAs(tx: Tx, c: Candidate, commit: string): Promise<void> {
    await tx.run(
        `MATCH (logical:MessageChannel)-[oldR:MANIFESTS_AS]->(:MessageChannel {id: $codeChannelUrn})
         WHERE oldR.valid_to_commit IS NULL
         MATCH (queue:MessageChannel {id: $queueUrn})
         MERGE (logical)-[newR:MANIFESTS_AS]->(queue)
         ON CREATE SET newR = properties(oldR), newR.valid_from_commit = $commit, newR.valid_to_commit = null
         ON MATCH SET newR += properties(oldR), newR.valid_to_commit = null
         SET oldR.valid_to_commit = $commit`,
        { codeChannelUrn: c.codeChannelUrn, queueUrn: c.queueUrn, commit },
    );
}

async function stampQueueEvidence(tx: Tx, c: Candidate): Promise<void> {
    await tx.run(
        `MATCH (queue:MessageChannel {id: $queueUrn})
         SET queue.evidence_extractors = reduce(_acc = [], _x IN coalesce(queue.evidence_extractors, []) + ['channel-routing-pattern-resolver@v1'] |
             CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { queueUrn: c.queueUrn },
    );
}

async function detachCodeChannel(tx: Tx, c: Candidate): Promise<void> {
    // DETACH DELETE removes ALL remaining edges (live HOSTED_ON to code-broker
    // + the tombstoned PUBLISHES_TO/LISTENS_TO/HAS_SCHEMA/CARRIED_BY/MANIFESTS_AS
    // we just set to valid_to_commit). Acceptable: the code-channel is a routing-
    // key placeholder, not an entity with archival value. Live history is now
    // on the queue side.
    await tx.run(
        `MATCH (codeCh:MessageChannel {id: $codeChannelUrn})
         DETACH DELETE codeCh`,
        { codeChannelUrn: c.codeChannelUrn },
    );
}
