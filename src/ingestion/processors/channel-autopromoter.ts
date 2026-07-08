/**
 * Channel Auto-Promote: logical → physical MessageChannel
 *
 * For each `:MessageChannel{scope:'logical'}` in the graph, collect the
 * `:MessageBroker` nodes that the Services publishing/listening on the channel
 * connect to (via `(Service)-[:CONNECTS_TO]->(MessageBroker)`). When ALL
 * Services converge on a SINGLE broker, promote the channel:
 *
 *   1. Merge a physical channel with URN suffix `@<brokerFingerprint>`
 *   2. Materialise `(logical)-[:MANIFESTS_AS]->(physical)`
 *   3. Move `:PUBLISHES_TO` / `:LISTENS_TO` edges from logical to physical
 *      while PRESERVING the original edge properties (routingKey, partitionKey,
 *      consumerGroup, ackMode, filterExpression, headers)
 *   4. Tombstone the old edges (set `valid_to_commit`), do not DELETE
 *      → idempotent + lineage-preserving
 *   5. Tombstone the logical NODE itself when all incoming edges have been
 *      moved AND no DataContract is attached. Without this, the Blast Radius
 *      query reaches the logical via MANIFESTS_AS reverse and renders it as
 *      a T2 transitive duplicate of the physical (orchestrator bug).
 *
 * The logical channel survives ONLY in two legitimate cases, both surfaced
 * via `needsReview=true` for triage in `cr doctor`:
 *   - Ambiguous broker (>1 broker detected for the channel): tagged with
 *     extractor `channel-autopromoter-ambiguous@v1`.
 *   - Schema-anchor: a DataContract attached via `:DESCRIBES` makes the
 *     logical the semantic anchor for the payload schema (one schema = one
 *     contract, not n copies per physical transport). Tagged with
 *     `channel-autopromoter-schema-anchor@v1`.
 *
 * Strict-isolation rule (memory + plan): auto-promote fires ONLY when the
 * broker convergence is unambiguous. Heuristic cross-broker welding never.
 */
import { run } from '../../graph/mutations/_run.js';
import { mergePhysicalMessageChannel } from '../../graph/mutations/data-contracts.js';
import { manifestChannelAs } from '../../graph/mutations/data-contracts.js';
import { astGrounding } from '../../graph/grounding.js';
import { ABSTRACT_BUS_TECHNOLOGIES, CQRS_MESSAGE_PATTERN } from '../../ingestion/core/name-safety.js';
import { logger } from '../../utils/logger.js';
import type { MessageChannelKind } from '../../graph/mutations/data-contracts.js';

/**
 * A logical channel is an uncorroborated message-class phantom when its name is
 * a bare PascalCase CQRS class (`*Command|*Event|*Message|*Query`, no namespace
 * separator) AND it has no structural config corroboration. The LLM frequently
 * reads the PAYLOAD class of `dispatch(new XEvent())` / `publish(new XEvent())`
 * as a channel; promoting it to a physical broker topic is a false positive.
 *
 * Config-declared abstract-bus channels are exempt (corroborated). Real routing
 * keys (`order.created`) and namespaced FQCN message classes
 * (`App\Messenger\SaveMessage`, which carry backslashes) never match the
 * pattern, so they are unaffected.
 */
export function isUncorroboratedMessageClass(
    name: string,
    hasStructuralCorroboration: boolean,
): boolean {
    return !hasStructuralCorroboration && CQRS_MESSAGE_PATTERN.test(name);
}

export interface ChannelAutopromoteResult {
    /** Logical channels promoted to physical in this run. */
    promoted: number;
    /** Logical channels welded onto an existing config-declared physical (Tier 1). */
    tier1Welded: number;
    /** Logical channels skipped because brokers are not unique. */
    ambiguous: number;
    /** Logical channels skipped because no broker was discoverable. */
    noBroker: number;
    /** Uncorroborated CQRS message-class phantoms tombstoned (not promoted). */
    messageClassPhantom: number;
}

interface PromoteCandidate {
    logicalUrn: string;
    name: string;
    channelKind: MessageChannelKind;
    technology: string | null;
}

/** One CONNECTS_TO binding row of a publisher/listener service. */
export interface BrokerBindingRow {
    urn: string;
    fingerprint: string;
    /** Bind provenance stamped by bindBrokerCandidates ('broker-candidate:a1', ...-residual). */
    via: string | null;
    /** Edge `source` ('env-var' | 'config' | 'channel-convergence'). */
    bindSource: string | null;
    needsReview: boolean;
    provider: string | null;
}

export type PromotionSelection =
    | { kind: 'promote'; broker: BrokerBindingRow; weak: boolean }
    | { kind: 'ambiguous' }
    | { kind: 'none' };

/**
 * Evidence ladder (pure). `weak = via =~ '.*residual.*' AND needsReview` —
 * a CONJUNCTION: anchored bindings (a1/a2/a3) to a needsReview broker and
 * residual bindings to a since-cleaned broker are both STRONG. Config edges
 * sit at strong PARITY: a conflict between a config broker and another
 * strong broker is AMBIGUOUS, never a silent precedence ("never blind").
 * Weak-only channels still promote (recall preserved) but flagged `weak`
 * so the caller tags the physical for triage.
 */
export function selectPromotionBroker(
    channel: { technology: string | null },
    rows: BrokerBindingRow[],
): PromotionSelection {
    const compatible = rows.filter(r => technologyCompatible(channel.technology, r.provider));
    const isWeak = (r: BrokerBindingRow) => /residual/.test(r.via ?? '') && r.needsReview;
    const strong = compatible.filter(r => !isWeak(r));
    const pool = strong.length > 0 ? strong : compatible;
    const distinct = [...new Map(pool.map(r => [r.urn, r])).values()];
    if (distinct.length === 0) return { kind: 'none' };
    if (distinct.length > 1) return { kind: 'ambiguous' };
    return { kind: 'promote', broker: distinct[0], weak: strong.length === 0 };
}

function technologyCompatible(technology: string | null, provider: string | null): boolean {
    if (!technology || technology === 'unknown') return true;
    if (!provider || provider === 'unknown') return true;
    // Abstract/in-process buses (symfony-messenger, mediatr, ...) ride ANY
    // physical transport — the meta-technology never conflicts with the
    // broker provider underneath (messenger over amqp is the normal case).
    if (ABSTRACT_BUS_TECHNOLOGIES.has(technology)) return true;
    return technology === provider;
}

/**
 * Main entry point. Runs the autopromoter pass against the live graph.
 */
export async function runChannelAutopromote(commitHash: string): Promise<ChannelAutopromoteResult> {
    const result: ChannelAutopromoteResult = { promoted: 0, tier1Welded: 0, ambiguous: 0, noBroker: 0, messageClassPhantom: 0 };
    const candidates = await loadLogicalChannels();

    for (const c of candidates) {
        // Name-safety gate: don't promote a bare CQRS class name to a physical
        // broker topic unless structural config corroborates it. The LLM reads
        // the payload class of `dispatch/publish(new XEvent())` as a channel;
        // promoting it converges the in-process event onto the Service's real
        // broker as a phantom. Tombstone the logical so no phantom survives.
        // (The DB corroboration read is gated on the cheap name shape so most
        // candidates skip it.)
        if (CQRS_MESSAGE_PATTERN.test(c.name)) {
            const corroborated = await readHasStructuralCorroboration(c.logicalUrn);
            if (isUncorroboratedMessageClass(c.name, corroborated)) {
                await tombstoneMessageClassPhantom(c.logicalUrn, commitHash);
                result.messageClassPhantom++;
                logger.info(`[channel-autopromoter] ${c.name}: uncorroborated CQRS message-class phantom, tombstoned (not promoted)`);
                continue;
            }
        }

        // Tier 1 — weld onto an existing config-declared physical with the
        // SAME name whose connection binding already resolved its broker
        // (channel-connection-binding pass). Guards: technology compat +
        // same-repo ownership. The logical inherits the per-vhost-correct
        // broker of ITS OWN connection instead of converging on env edges.
        const tier1 = await tier1ConfigPhysicalFor(c);
        if (tier1 === 'ambiguous') {
            result.ambiguous++;
            await markLogicalNeedsReview(c.logicalUrn, 'channel-autopromoter-ambiguous@v1');
            logger.info(`[channel-autopromoter] ${c.name}: AMBIGUOUS — multiple config-declared physicals match by name, no weld`);
            continue;
        }
        if (tier1) {
            await promoteOntoPhysical(c, tier1.physicalUrn, commitHash, {
                declaredVia: 'config',
                structurallyCorroborated: true,
            });
            result.tier1Welded++;
            result.promoted++;
            logger.info(`[channel-autopromoter] ${c.name}: welded onto config-declared physical ${tier1.physicalUrn} (Tier 1)`);
            continue;
        }

        // Tiers 2-3 — evidence ladder over the services' CONNECTS_TO rows.
        const rows = await loadServiceBrokersForChannel(c.logicalUrn);
        const selection = selectPromotionBroker({ technology: c.technology }, rows);
        if (selection.kind === 'none') {
            result.noBroker++;
            logger.debug(`[channel-autopromoter] ${c.name}: no broker discoverable, logical stays`);
            continue;
        }
        if (selection.kind === 'ambiguous') {
            result.ambiguous++;
            logger.info(
                `[channel-autopromoter] ${c.name}: AMBIGUOUS - multiple brokers detected, no promote. Rows: ${rows.map(b => b.urn).join(', ')}`,
            );
            await markLogicalNeedsReview(c.logicalUrn, 'channel-autopromoter-ambiguous@v1');
            continue;
        }

        await promote(c, selection.broker, commitHash, { weakBroker: selection.weak });
        result.promoted++;
        logger.info(`[channel-autopromoter] ${c.name}: promoted to physical on broker ${selection.broker.urn}${selection.weak ? ' (weak-only evidence)' : ''}`);
    }

    return result;
}

/**
 * Tier-1 lookup: config-declared physical channels with the candidate's name
 * and a brokerUrn stamped by the channel-connection binding pass, filtered by
 * technology compatibility and same-repo ownership (at least one
 * publisher/listener Service of the logical lives in the physical's repo).
 * Fail-CLOSED on missing `_repoUrn` (pre-feature nodes): the ladder below
 * still covers those channels; the structural version bump re-stamps them on
 * the next repo sync.
 */
async function tier1ConfigPhysicalFor(
    c: PromoteCandidate,
): Promise<{ physicalUrn: string } | 'ambiguous' | null> {
    const r = await run(
        `MATCH (p:MessageChannel {scope: 'physical'})
         WHERE p.valid_to_commit IS NULL
           AND p.name = $name
           AND p.discoverySource = 'config'
           AND p.brokerUrn IS NOT NULL
         RETURN p.id AS id, p.technology AS technology, p._repoUrn AS repoUrn`,
        { name: c.name },
    );
    const compatible = r.records.filter(rec =>
        technologyCompatible(c.technology, (rec.get('technology') as string | null)));
    if (compatible.length === 0) return null;

    const serviceUrns = await channelServiceUrns(c.logicalUrn);
    const owned = compatible.filter(rec => {
        const repoUrn = rec.get('repoUrn') as string | null;
        if (!repoUrn) return false; // fail-closed: ownership unprovable
        const repoName = repoUrn.replace(/^cr:repository:/, '');
        return serviceUrns.some(urn => urn.startsWith(`cr:service:${repoName}:`));
    });
    if (owned.length === 0) return null;
    if (owned.length > 1) return 'ambiguous';
    return { physicalUrn: owned[0].get('id') as string };
}

/** DISTINCT Services owning the Functions that publish/listen on the channel. */
async function channelServiceUrns(logicalUrn: string): Promise<string[]> {
    const r = await run(
        `MATCH (f:Function)-[edge:PUBLISHES_TO|LISTENS_TO]->(ch:MessageChannel {id: $logicalUrn})
         WHERE edge.valid_to_commit IS NULL
         MATCH (s:Service)-[:CONTAINS]->(f)
         RETURN collect(DISTINCT s.id) AS urns`,
        { logicalUrn },
    );
    return (r.records[0]?.get('urns') as string[] | undefined) ?? [];
}

/**
 * Mark a logical channel as `needsReview=true` with the given extractor tag,
 * appended to `evidence_extractors` (deduped). Used for two sopravvivenze
 * legittimate del logical post-autopromote: ambiguous broker and schema-anchor.
 */
async function markLogicalNeedsReview(logicalUrn: string, extractorTag: string): Promise<void> {
    await run(
        `MATCH (l:MessageChannel {id: $logicalUrn})
         SET l.needsReview = true,
             l.evidence_extractors = reduce(_acc = [], _x IN coalesce(l.evidence_extractors, []) + [$tag] |
                CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { logicalUrn, tag: extractorTag },
    );
}

/**
 * Tombstone an uncorroborated CQRS message-class phantom logical channel
 * (set `valid_to_commit`, do not DELETE — lineage-preserving). Tagged so the
 * drop is auditable and a later sweep can grep the extractor.
 */
async function tombstoneMessageClassPhantom(logicalUrn: string, commitHash: string): Promise<void> {
    await run(
        `MATCH (l:MessageChannel {id: $logicalUrn})
         WHERE l.valid_to_commit IS NULL
         SET l.valid_to_commit = $commitHash,
             l.tombstoned_by = 'auto-promote-message-class-phantom',
             l.evidence_extractors = reduce(_acc = [], _x IN coalesce(l.evidence_extractors, []) + ['channel-autopromoter-message-class-phantom@v1'] |
                CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { logicalUrn, commitHash },
    );
}

async function loadLogicalChannels(): Promise<PromoteCandidate[]> {
    const r = await run(
        `MATCH (ch:MessageChannel)
         WHERE ch.scope = 'logical' AND ch.valid_to_commit IS NULL
         RETURN ch.id AS id, ch.name AS name, ch.channelKind AS kind, ch.technology AS technology`,
    );
    return r.records.map(rec => ({
        logicalUrn: rec.get('id') as string,
        name: rec.get('name') as string,
        channelKind: rec.get('kind') as MessageChannelKind,
        technology: rec.get('technology') as string | null,
    }));
}

/**
 * Recover the CONNECTS_TO binding rows of the Services that own the
 * Functions publishing/listening on the channel — WITH the evidence fields
 * the ladder dispatches on (bind.via, bind.source, broker.needsReview,
 * broker.provider).
 *
 *   Service -[:CONTAINS]-> Function -[:PUBLISHES_TO|LISTENS_TO]-> :MessageChannel(logical)
 *   Service -[:CONNECTS_TO]-> :MessageBroker
 */
async function loadServiceBrokersForChannel(logicalUrn: string): Promise<BrokerBindingRow[]> {
    const r = await run(
        `MATCH (ch:MessageChannel {id: $logicalUrn})
         MATCH (f:Function)-[edge:PUBLISHES_TO|LISTENS_TO]->(ch)
         WHERE edge.valid_to_commit IS NULL
         MATCH (s:Service)-[:CONTAINS]->(f)
         MATCH (s)-[bind:CONNECTS_TO]->(b:MessageBroker)
         WHERE bind.valid_to_commit IS NULL
         RETURN DISTINCT b.id AS urn, b.fingerprint AS fp,
                bind.via AS via, bind.source AS bindSource,
                coalesce(b.needsReview, false) AS needsReview,
                b.provider AS provider`,
        { logicalUrn },
    );
    return r.records.map(rec => ({
        urn: rec.get('urn') as string,
        fingerprint: rec.get('fp') as string,
        via: (rec.get('via') as string | null) ?? null,
        bindSource: (rec.get('bindSource') as string | null) ?? null,
        needsReview: Boolean(rec.get('needsReview')),
        provider: (rec.get('provider') as string | null) ?? null,
    }));
}

async function promote(
    c: PromoteCandidate,
    broker: BrokerBindingRow,
    commitHash: string,
    opts: { weakBroker?: boolean } = {},
): Promise<void> {
    // Fix 6bis: read `discoverySource` BEFORE manifestChannelAs creates a self-MANIFESTS_AS
    // edge that would otherwise be picked up by structural-corroboration heuristics.
    // Pre-existing marker only: `discoverySource = 'config'` is set by structural plugins
    // (symfony-messenger, rabbitmq-config) that parse customer-declared config files.
    // LLM-only emitted channels do not carry this property.
    const hasStructuralCorroboration = await readHasStructuralCorroboration(c.logicalUrn);

    // Step 1: create or reuse the physical channel.
    const physicalUrn = await mergePhysicalMessageChannel(
        c.name,
        c.channelKind,
        c.technology ?? 'unknown',
        broker.fingerprint,
        broker.urn,
        commitHash,
        { grounding: astGrounding('channel-autopromoter@v1') },
    );

    await promoteOntoPhysical(c, physicalUrn, commitHash, {
        declaredVia: 'inferred',
        structurallyCorroborated: hasStructuralCorroboration,
        weakBroker: opts.weakBroker,
    });
}

/**
 * Weld the logical onto an EXISTING (or just-minted) physical channel:
 * MANIFESTS_AS + edge moves + logical collapse + triage marking. Shared by
 * the ladder path (which mints the physical first) and the Tier-1 path
 * (which reuses the config-declared physical as-is).
 */
async function promoteOntoPhysical(
    c: PromoteCandidate,
    physicalUrn: string,
    commitHash: string,
    opts: {
        declaredVia: 'config' | 'inferred';
        structurallyCorroborated: boolean;
        weakBroker?: boolean;
    },
): Promise<void> {
    // Step 2: MANIFESTS_AS logical → physical ('config' on the Tier-1 path —
    // the physical is customer-declared; 'inferred' when env-evidence-driven).
    await manifestChannelAs(c.logicalUrn, physicalUrn, commitHash, opts.declaredVia, opts.declaredVia === 'config' ? 0.95 : 0.9);

    // Step 3: move PUBLISHES_TO / LISTENS_TO from logical to physical, preserving
    // edge properties. Tombstone old edges (no DELETE) for idempotency + lineage.
    await moveEdgesPreservingProps(c.logicalUrn, physicalUrn, 'PUBLISHES_TO', commitHash);
    await moveEdgesPreservingProps(c.logicalUrn, physicalUrn, 'LISTENS_TO', commitHash);

    // Step 3bis (Fix 6): migrate DataStructure CARRIED_BY edges to the physical
    // channel. Payload schemas ride the transport (physical), unlike DataContract
    // specifications which anchor to the logical layer.
    await moveCarriedByEdges(c.logicalUrn, physicalUrn, commitHash);

    // Step 4 (NEW): collapse the logical node. Two branches gated by DataContract
    // presence, run in a single transaction with FOREACH(CASE) so the channel
    // resolves to exactly one of {tombstoned, schema-anchor} per call.
    //
    // Branch A — has DataContract attached: logical SURVIVES as schema-anchor
    // (one schema = one contract). Marked needsReview for triage visibility.
    //
    // Branch B — orphan: logical TOMBSTONED so the Blast Radius query stops
    // surfacing it as a T2 transitive duplicate of the physical.
    //
    // The OUTER guard (no remaining PUBLISHES_TO/LISTENS_TO) is the contract
    // for both branches: if the move-edges step above somehow left a live
    // incoming edge (race / re-resync mid-flight), we conservatively skip
    // any state change on the logical.
    // Memgraph note: `EXISTS{...}` is only supported inside WHERE clauses
    // (not in WITH projections), so we use `OPTIONAL MATCH + count()` to
    // detect the DataContract attachment. The outer WHERE retains EXISTS
    // because there it IS in a WHERE clause.
    // Step 4: collapse the logical node. Schema-anchor ONLY if a DataContract is present.
    // CARRIED_BY has already been migrated in Step 3bis, so it no longer sits on the
    // logical node: the "no active incoming edges" guard still covers it for defense.
    await run(
        `MATCH (logical:MessageChannel {id: $logicalUrn})
         WHERE NOT EXISTS {
             MATCH (logical)<-[r:PUBLISHES_TO|LISTENS_TO|CARRIED_BY]-()
             WHERE r.valid_to_commit IS NULL
         }
         OPTIONAL MATCH (dc:DataContract)-[d:DESCRIBES]->(logical)
         WHERE d.valid_to_commit IS NULL
         WITH logical, count(d) > 0 AS hasContract
         FOREACH (_ IN CASE WHEN hasContract THEN [1] ELSE [] END |
             SET logical.purpose = 'schema-anchor',
                 logical.needsReview = true,
                 logical.evidence_extractors = reduce(_acc = [], _x IN coalesce(logical.evidence_extractors, []) + ['channel-autopromoter-schema-anchor@v1'] |
                    CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END))
         FOREACH (_ IN CASE WHEN hasContract THEN [] ELSE [1] END |
             SET logical.valid_to_commit = $commitHash,
                 logical.tombstoned_by = 'auto-promote')`,
        { logicalUrn: c.logicalUrn, commitHash },
    );

    // Step 5 (Fix 6bis): mark the physical channel needsReview + low-evidence
    // extractor tag when the promotion lacked structural corroboration (no
    // `discoverySource = 'config'` on the logical, and not the Tier-1 weld
    // onto a config-declared physical). Surfaced in `cr doctor` and
    // used by the technology welder Fix 7 as a "skip" signal to avoid
    // painting FPs.
    if (!opts.structurallyCorroborated) {
        await markPhysicalForTriage(physicalUrn, 'channel-autopromoter-low-evidence@v1');
    }

    // Weak-only fallback (Tier 3): the promotion leaned exclusively on
    // residual needsReview bindings — keep the recall, flag the physical.
    if (opts.weakBroker) {
        await markPhysicalForTriage(physicalUrn, 'channel-autopromoter-weak-broker@v1');
    }
}

async function markPhysicalForTriage(physicalUrn: string, extractorTag: string): Promise<void> {
    await run(
        `MATCH (p:MessageChannel {id: $physicalUrn})
         SET p.needsReview = true,
             p.evidence_extractors = reduce(_acc = [], _x IN coalesce(p.evidence_extractors, []) + [$tag] |
                CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { physicalUrn, tag: extractorTag },
    );
}

/**
 * Pre-existing structural-corroboration check (Fix 6bis).
 *
 * Reads the LOGICAL channel's own `discoverySource` property. Only `'config'`
 * (set by structural plugins like `symfony-messenger.plugin.ts` and
 * `rabbitmq-config.plugin.ts`) counts as structural proof.
 *
 * DO NOT use MANIFESTS_AS / HOSTED_ON checks here: the autopromoter itself
 * creates a MANIFESTS_AS edge to the physical (Step 2), which would self-
 * corroborate every promoted channel and defeat the purpose of the marker.
 */
async function readHasStructuralCorroboration(logicalUrn: string): Promise<boolean> {
    const r = await run(
        `MATCH (l:MessageChannel {id: $logicalUrn})
         RETURN l.discoverySource AS source`,
        { logicalUrn },
    );
    if (r.records.length === 0) return false;
    const source = r.records[0].get('source');
    return source === 'config';
}

/**
 * Migrate `(:DataStructure)-[:CARRIED_BY]->(:MessageChannel)` edges from the
 * logical to the physical channel. Payload schemas semantically ride the
 * transport (physical), unlike DataContract specifications which anchor to
 * the logical layer (`DESCRIBES` is handled by the tombstone/schema-anchor
 * step instead).
 *
 * Kept as a dedicated function (not generalised `moveEdgesPreservingProps`)
 * to preserve the source-label invariant on PUBLISHES_TO/LISTENS_TO
 * (Function-only) and avoid surface-area weakening.
 */
async function moveCarriedByEdges(
    logicalUrn: string,
    physicalUrn: string,
    commitHash: string,
): Promise<void> {
    await run(
        `MATCH (ds:DataStructure)-[oldRel:CARRIED_BY]->(l:MessageChannel {id: $logicalUrn})
         WHERE oldRel.valid_to_commit IS NULL
         MATCH (p:MessageChannel {id: $physicalUrn})
         MERGE (ds)-[newRel:CARRIED_BY]->(p)
         ON CREATE SET newRel += properties(oldRel),
                       newRel.valid_from_commit = $commitHash,
                       newRel.valid_to_commit = null
         ON MATCH  SET newRel += properties(oldRel),
                       newRel.valid_to_commit = null
         WITH oldRel
         SET oldRel.valid_to_commit = $commitHash`,
        { logicalUrn, physicalUrn, commitHash },
    );
}

/**
 * Move an edge type from `logicalUrn` to `physicalUrn`, preserving all
 * properties on the original edge (routingKey, consumerGroup, etc.).
 * The original edge is tombstoned, not deleted.
 *
 * Cypher pattern uses `properties(oldRel)` carry-over with `SET newRel +=
 * properties(oldRel)` so caller-tracked fields survive; then `valid_*` are set
 * explicitly to win over the carry-over (which would have set the wrong commit).
 */
async function moveEdgesPreservingProps(
    logicalUrn: string,
    physicalUrn: string,
    edgeType: 'PUBLISHES_TO' | 'LISTENS_TO',
    commitHash: string,
): Promise<void> {
    await run(
        `MATCH (f:Function)-[oldRel:${edgeType}]->(l:MessageChannel {id: $logicalUrn})
         WHERE oldRel.valid_to_commit IS NULL
         MATCH (p:MessageChannel {id: $physicalUrn})
         MERGE (f)-[newRel:${edgeType}]->(p)
         ON CREATE SET newRel += properties(oldRel),
                       newRel.valid_from_commit = $commitHash,
                       newRel.valid_to_commit = null,
                       newRel.brokerScopeConfidence = 'auto-promoted'
         ON MATCH  SET newRel += properties(oldRel),
                       newRel.valid_to_commit = null,
                       newRel.brokerScopeConfidence = 'auto-promoted'
         WITH oldRel
         SET oldRel.valid_to_commit = $commitHash`,
        { logicalUrn, physicalUrn, commitHash },
    );
}
