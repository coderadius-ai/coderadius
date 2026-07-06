/**
 * Channel Technology Welder (Fix 7 — rewritten Phase 2)
 *
 * Propagates the physical broker's `provider` onto the channel's `technology`
 * when there is an explicit, structural binding between the two:
 *
 *   Pass 1 — direct binding: `ch.brokerUrn = b.id` (set by autopromoter when it
 *   promotes a logical channel onto a broker, or by structural plugins that
 *   write the URN explicitly).
 *
 *   Pass 2 — HOSTED_ON fallback: when a channel has `HOSTED_ON` to a single
 *   broker but no explicit `brokerUrn` property (e.g. legacy structural emit),
 *   the welder back-fills `brokerUrn` and propagates the provider.
 *
 * Phase 1 used Service-CONNECTS_TO inference which propagated technology onto
 * every channel published/listened by a Service in the same repo, including
 * FP residues (e.g. `error_log`, `cache_write`). Pass 1+2 use only explicit
 * channel↔broker bindings, so FPs without structural backing stay `unknown`.
 *
 * Invariants:
 *   - `ch.needsReview IS NOT true` guard skips low-evidence channels marked by
 *     Fix 6bis. Suspicious metric (Fix 12) keeps them visible and unpainted.
 *   - Only NULL / 'unknown' / abstract-bus technologies are overwritten.
 *     Concrete physical labels (e.g. LLM correctly identified `kafka`) stay.
 *   - `evidence_extractors` is appended (deduped via `reduce()` since Memgraph
 *     array `+` does NOT dedup) with `channel-technology-welder@v1`.
 *   - Idempotent: a second run is a no-op on already-welded channels (Pass 1
 *     guard fails on concrete tech; Pass 2 guard fails on `brokerUrn IS NULL`).
 */

import { run } from '../../graph/mutations/_run.js';

export interface ChannelTechnologyWeldResult {
    /** Number of channels stamped with a propagated technology. */
    welded: number;
}

const PHYSICAL_PROVIDERS = [
    'rabbitmq', 'kafka', 'pubsub', 'sqs', 'sns', 'nats', 'azure-service-bus',
];

const ABSTRACT_BUS_TECHNOLOGIES = [
    'symfony-messenger', 'mediatr', 'nestjs-cqrs', 'wolverine',
    'masstransit', 'rebus', 'brighter', 'ecotone',
];

const EXTRACTOR_TAG = 'channel-technology-welder@v1';

export async function runChannelTechnologyWeld(_commitHash: string): Promise<ChannelTechnologyWeldResult> {
    // Pass 1 — direct brokerUrn binding (autopromoter-set or customer-declared).
    // Memgraph: 2-step MATCH (no property reference inline) for compatibility.
    const r1 = await run(
        `MATCH (ch:MessageChannel)
         WHERE ch.valid_to_commit IS NULL
           AND ch.scope = 'physical'
           AND ch.brokerUrn IS NOT NULL
           AND (ch.needsReview IS NULL OR ch.needsReview = false)
         WITH ch
         MATCH (b:MessageBroker)
         WHERE b.id = ch.brokerUrn
           AND b.valid_to_commit IS NULL
           AND b.provider IN $physicalProviders
         WITH ch, b.provider AS provider
         WHERE ch.technology IS NULL
            OR ch.technology = 'unknown'
            OR ch.technology IN $abstractBusTechnologies
         SET ch.technology = provider,
             ch.evidence_extractors = reduce(_acc = [], _x IN coalesce(ch.evidence_extractors, []) + [$tag] |
                CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)
         RETURN count(ch) AS welded`,
        {
            physicalProviders: PHYSICAL_PROVIDERS,
            abstractBusTechnologies: ABSTRACT_BUS_TECHNOLOGIES,
            tag: EXTRACTOR_TAG,
        },
    );
    const weldedPass1 = Number(r1.records[0]?.get('welded') ?? 0);

    // Pass 2 — HOSTED_ON fallback. Single-broker only (no fan-out ambiguity).
    // Back-fills brokerUrn so a subsequent Pass 1 run sees the binding.
    const r2 = await run(
        `MATCH (ch:MessageChannel)-[h:HOSTED_ON]->(b:MessageBroker)
         WHERE ch.valid_to_commit IS NULL
           AND ch.scope = 'physical'
           AND ch.brokerUrn IS NULL
           AND (ch.needsReview IS NULL OR ch.needsReview = false)
           AND (h.valid_to_commit IS NULL)
           AND b.valid_to_commit IS NULL
           AND b.provider IN $physicalProviders
         WITH ch, collect(DISTINCT b) AS brokers
         WHERE size(brokers) = 1
         WITH ch, head(brokers) AS b
         WHERE ch.technology IS NULL
            OR ch.technology = 'unknown'
            OR ch.technology IN $abstractBusTechnologies
         SET ch.technology = b.provider,
             ch.brokerUrn = b.id,
             ch.evidence_extractors = reduce(_acc = [], _x IN coalesce(ch.evidence_extractors, []) + [$tag] |
                CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)
         RETURN count(ch) AS welded`,
        {
            physicalProviders: PHYSICAL_PROVIDERS,
            abstractBusTechnologies: ABSTRACT_BUS_TECHNOLOGIES,
            tag: EXTRACTOR_TAG,
        },
    );
    const weldedPass2 = Number(r2.records[0]?.get('welded') ?? 0);

    return { welded: weldedPass1 + weldedPass2 };
}
