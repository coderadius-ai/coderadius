/**
 * Dynamic Infrastructure Resolver
 *
 * Replaces LLM-based global resolution for dynamic SQL/Broker queries with
 * deterministic, ultra-fast Regex pattern matching against discovered infrastructure.
 */

import { getDynamicInfraStubs, getConcreteInfraNodes, rewireDynamicToConcrete, markDynamicStubUnresolved } from '../../graph/mutations/data-contracts.js';
import { run } from '../../graph/mutations/_run.js';
import { buildUrn } from '../../graph/urn.js';
import { buildMessageChannelUrn, type MessageChannelKind } from '../../graph/mutations/data-contracts.js';
import { logger } from '../../utils/logger.js';
import type { ProgressReporter } from '../core/progress.js';

const commitHash = "SYSTEM";
const MAX_DYNAMIC_MATCH = 20;

/**
 * Known environment placeholder patterns that indicate the stub name is
 * parameterized by deployment environment. When no concrete node matches,
 * these placeholders are stripped and the stub is promoted to a canonical node.
 *
 * Order matters: more specific patterns should come first.
 */
const ENV_PLACEHOLDER_PATTERNS = [
    /\{envSuffix\}/g,
    /\{env\}/g,
    /\{environment\}/g,
    /\{tablePrefix\}/g,
    /\{prefix\}/g,
    /\{suffix\}/g,
    // NOTE: {tipo} and {type} intentionally excluded — they represent
    // business-logic partitions (e.g. quote_auto/moto/autocarri), NOT
    // deployment environments. See: unified-analyzer.ts L410 DYNAMIC
    // CONCATENATION rule which emits these as data-partition templates.
];

/**
 * Try to normalize a dynamic stub name by stripping known environment
 * placeholders. Returns the normalized name if any placeholder was found,
 * or null if no applicable pattern matches.
 *
 * Examples:
 *   "pkg.acme_core{envSuffix}.shipment.requested" → "pkg.acme_core.shipment.requested"
 *   "logistics.fulfillment{envSuffix}.save.ready"      → "logistics.fulfillment.save.ready"
 *   "shipment_{tipo}"                                → "shipment_"  (→ cleaned to "shipment")
 */
export function normalizeEnvPlaceholder(stubName: string): string | null {
    let result = stubName;
    let changed = false;

    for (const pattern of ENV_PLACEHOLDER_PATTERNS) {
        const replaced = result.replace(pattern, '');
        if (replaced !== result) {
            result = replaced;
            changed = true;
        }
    }

    if (!changed) return null;

    // Clean up artifacts: doubled dots, trailing dots/underscores, leading dots
    result = result
        .replace(/\.{2,}/g, '.')     // "foo..bar" → "foo.bar"
        .replace(/_{2,}/g, '_')      // "foo__bar" → "foo_bar"
        .replace(/^[._]+/, '')        // ".foo" → "foo"
        .replace(/[._]+$/, '');       // "foo." → "foo"

    // Guard: if residual placeholders remain after partial normalization, bail out.
    // e.g. '{env}.{businessPartition}' → '{businessPartition}' is NOT a valid concrete name.
    if (/\{[^}]+\}/.test(result)) return null;

    return result || null;
}

/**
 * Promote an UnresolvedDynamicNode stub to a concrete node by renaming it.
 * This removes the UnresolvedDynamicNode label and updates the node's
 * name and id to the normalized (placeholder-free) form.
 *
 * All existing edges (READS, WRITES, PUBLISHES_TO, LISTENS_TO) are preserved
 * since they follow the node, not the id.
 */
async function promoteStubToConcreteNode(stubId: string, newName: string, nodeType: string, commitHash: string): Promise<boolean> {
    // Read scope + channelKind from stub node. channelKind is needed to build
    // the canonical kinded URN for MessageChannel (cr:channel:<kind>:<name>).
    const stubProps = await run(
        `MATCH (n {id: $stubId}) RETURN n.scope AS scope, n.channelKind AS channelKind`,
        { stubId }
    );
    const scope = stubProps.records[0]?.get('scope') as string | undefined;
    const channelKind = stubProps.records[0]?.get('channelKind') as string | undefined;

    // Fail-closed for DataContainer: scope is mandatory for identity correctness.
    // Without scope, the URN would be global (e.g. cr:datacontainer:quote) which
    // collides across repos. Rather than create a broken node, mark as unresolved.
    if (!scope && nodeType === 'DataContainer') {
        logger.warn(`[DynamicInfraResolver] Cannot promote stub "${stubId}" — missing scope for DataContainer. Marking unresolved.`);
        await markDynamicStubUnresolved(stubId, commitHash);
        return false;
    }

    // MessageChannel URN must be kinded (cr:channel:<kind>:<name>) to match
    // what `linkFunctionToBroker` / `mergeMessageChannelWithKind` produce
    // elsewhere in the pipeline. Using the generic `buildUrn(nodeType.toLowerCase(), ...)`
    // would produce `cr:messagechannel:<name>` (un-kinded), creating a node
    // that no consumer-side or publisher-side function can match: the orphan
    // then gets tombstoned by deleteOrphanMessageChannels.
    // Runtime guard on channelKind protects against legacy stubs storing
    // a value outside the MessageChannelKind union (typo, deprecated kind):
    // those fall through to the generic builder rather than producing a
    // non-canonical URN with an unknown kind segment.
    const VALID_CHANNEL_KINDS = new Set(['topic', 'subscription', 'queue', 'exchange']);
    let newUrn: string;
    if (nodeType === 'MessageChannel' && channelKind && VALID_CHANNEL_KINDS.has(channelKind)) {
        newUrn = buildMessageChannelUrn(newName, channelKind as MessageChannelKind);
    } else {
        newUrn = scope
            ? buildUrn(nodeType.toLowerCase(), scope, newName)
            : buildUrn(nodeType.toLowerCase(), newName);
    }

    // Check if a concrete node with this name already exists
    const existing = await run(
        `MATCH (n:${nodeType} {id: $newUrn}) RETURN n.id AS id`,
        { newUrn }
    );

    if (existing.records.length > 0) {
        // Concrete node already exists — rewire edges from stub to existing node
        await rewireDynamicToConcrete(stubId, [newUrn], newName, commitHash);
        logger.debug(`[DynamicInfraResolver] Promoted stub → existing node "${newName}"`);
    } else {
        // No existing node — rename the stub in-place
        await run(
            `MATCH (n {id: $stubId})
             REMOVE n:UnresolvedDynamicNode
             SET n.id = $newUrn, n.name = $newName, n.unresolved = null,
                 n.normalizedFrom = $stubId`,
            { stubId, newUrn, newName }
        );
        logger.debug(`[DynamicInfraResolver] Promoted stub → new node "${newName}"`);
    }
    return true;
}

/**
 * Suffix-based MessageChannel deduplication.
 *
 * Welds consumer-side truncated channels into publisher-side fully-qualified
 * ones. Common in PHP Symfony Messenger setups where the publisher emits
 * `acme.inventory.quote.requested` (DI-resolved from a config) while the
 * `__invoke` handler of `QuoteHandler` triggers the LLM to extract just
 * `quote.requested` (the class-name-derived stem).
 *
 * Pair selection rules (all must hold):
 *   1. `short.name` segments appear as a contiguous run anywhere in
 *      `long.name` segments (not just as a final suffix). E.g.
 *      - `quote.requested` ⊂ `acme.inventory.quote.requested` (suffix)
 *      - `quote.product`   ⊂ `acme.inventory.quote.product.requested` (mid)
 *      Match must be SEGMENT-aligned (split on '.'): `quote.req` is NOT a
 *      match for `acme.inventory.quote.requested.handler` because `req` is
 *      not a complete segment of the long name.
 *   2. `short.name` contains a dot                (multi-segment, avoid
 *      promoting single-word stems like 'events' into 'acme.api.events')
 *   3. Same `channelKind` (treating null as equivalent)
 *   4. Exactly ONE `long` candidate per `short`   (unambiguous)
 *   5. The match position inside `long` must be UNIQUE (no two start indices
 *      yield the same shortParts), defense against `quote.x` ⊂ `quote.x.quote.x.y`
 *   6. At least one Service contains a Function that references both nodes
 *      (prevents cross-service merges that share suffix coincidentally)
 *
 * Returns the number of welded pairs.
 */
export async function deduplicateMessageChannelsBySuffix(): Promise<number> {
    // Step 1: find unambiguous (short → long) pairs.
    //
    // Welder rules (all must hold simultaneously):
    //   1. short has multi-segment name (contains '.')
    //   2. short and long agree on channelKind (null treated as equal)
    //   3. shortParts appear as a contiguous segment run anywhere in long
    //      (suffix or mid-string) at exactly ONE position per long
    //   4. all candidate longs for a given short have the SAME matchStart
    //      (no ambiguous depth) AND the SAME prefix up to matchStart
    //      (no ambiguous identity, e.g. two unrelated services hitting the
    //      same stem). This relaxation allows sibling welds:
    //      `quote.product` welded to BOTH
    //      `acme.inventory.quote.product.requested` AND
    //      `acme.inventory.quote.product.completed` since they share the
    //      same prefix `acme.inventory` and same matchStart=2.
    //   5. at least one Service contains a Function that references both
    //      nodes (cross-service safety).
    const pairsResult = await run(
        `MATCH (short:MessageChannel)
         WHERE short.valid_to_commit IS NULL
           AND short.name CONTAINS '.'
           AND NOT short.name STARTS WITH '{'
         WITH short, split(short.name, '.') AS shortParts
         MATCH (long:MessageChannel)
         WHERE long.id <> short.id
           AND long.valid_to_commit IS NULL
           AND coalesce(long.channelKind, '') = coalesce(short.channelKind, '')
           // Strict broker isolation (Phase 1.5):
           //   - never weld physical channels across distinct brokers
           //   - never weld a physical channel into a logical one (scope must align
           //     or one side must be unscoped/null)
           AND (coalesce(short.brokerUrn, '') = coalesce(long.brokerUrn, ''))
           AND (
                coalesce(short.scope, '') = coalesce(long.scope, '')
                OR coalesce(short.scope, '') = ''
                OR coalesce(long.scope, '') = ''
           )
         WITH short, shortParts, long, split(long.name, '.') AS longParts
         WHERE size(longParts) > size(shortParts)
         WITH short, long, longParts,
              [start IN range(0, size(longParts) - size(shortParts)) WHERE
                  all(i IN range(0, size(shortParts) - 1) WHERE longParts[start + i] = shortParts[i])
              ] AS matchPositions
         WHERE size(matchPositions) = 1
         WITH short, collect({long: long, matchStart: matchPositions[0], prefix: longParts[0..matchPositions[0]]}) AS candidates
         WHERE size(candidates) >= 1
           AND all(c IN candidates WHERE c.matchStart = candidates[0].matchStart)
           AND all(c IN candidates WHERE c.prefix = candidates[0].prefix)
           // Require at least 2 prefix segments on the long: a real canonical
           // name carries a service/domain namespace (e.g. acme.inventory.X.Y).
           // A long with only 1 prefix segment is itself just a stem; welding
           // the short into it conflates two unrelated canonical channels.
           AND candidates[0].matchStart >= 2
         UNWIND candidates AS candidate
         WITH short, candidate.long AS long
         MATCH (s:Service)-[:CONTAINS]->(:Function)-[:PUBLISHES_TO|LISTENS_TO]->(short)
         MATCH (s)-[:CONTAINS]->(:Function)-[:PUBLISHES_TO|LISTENS_TO]->(long)
         RETURN DISTINCT short.id AS shortId, short.name AS shortName, long.id AS longId, long.name AS longName`,
        {}
    );

    const pairs = pairsResult.records.map(rec => ({
        shortId: rec.get('shortId') as string,
        shortName: rec.get('shortName') as string,
        longId: rec.get('longId') as string,
        longName: rec.get('longName') as string,
    }));

    if (pairs.length === 0) return 0;

    // Step 2: rewire each pair (PUBLISHES_TO and LISTENS_TO separately,
    // Memgraph cannot MERGE a relationship with a dynamic type variable).
    //
    // Group pairs by shortId so when a short has multiple sibling longs we
    // only DETACH DELETE the short ONCE after all merges. We must NOT delete
    // the original `f -[r]-> short` edge inside the per-long MERGE step:
    // doing so would orphan subsequent long iterations (the second long
    // would no longer find `f` via the original edge). DETACH DELETE on
    // the short at the very end cleans up all dangling edges in one shot.
    const pairsByShort = new Map<string, { shortName: string; longs: Array<{ id: string; name: string }> }>();
    for (const pair of pairs) {
        const entry = pairsByShort.get(pair.shortId);
        if (entry) {
            entry.longs.push({ id: pair.longId, name: pair.longName });
        } else {
            pairsByShort.set(pair.shortId, {
                shortName: pair.shortName,
                longs: [{ id: pair.longId, name: pair.longName }],
            });
        }
    }

    for (const [shortId, { shortName, longs }] of pairsByShort) {
        for (const long of longs) {
            for (const edgeType of ['PUBLISHES_TO', 'LISTENS_TO'] as const) {
                await run(
                    `MATCH (f:Function)-[r:${edgeType}]->(short:MessageChannel {id: $shortId})
                     MATCH (long:MessageChannel {id: $longId})
                     MERGE (f)-[r2:${edgeType}]->(long)
                     ON CREATE SET r2.valid_from_commit = $commitHash, r2.valid_to_commit = null
                     ON MATCH SET r2.valid_from_commit = coalesce(r2.valid_from_commit, $commitHash), r2.valid_to_commit = null`,
                    { shortId, longId: long.id, commitHash },
                );
            }
            // Stamp composite grounding on the surviving long node: record the
            // shortId in evidence_mergedFrom (deduped via reduce()) so the
            // surviving node's grounding reflects the suffix-weld decision.
            await run(
                `MATCH (long:MessageChannel {id: $longId})
                 SET long.source = 'composite',
                     long.evidence_mergedFrom = reduce(_acc = [], _x IN coalesce(long.evidence_mergedFrom, []) + [$shortId] | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                     long.evidence_extractors = reduce(_acc = [], _x IN coalesce(long.evidence_extractors, []) + ['suffix-dedup-weld@v1'] | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
                { longId: long.id, shortId },
            );
            logger.debug(`[DynamicInfraResolver] Welded MessageChannel suffix "${shortName}" → "${long.name}"`);
        }

        // Step 3: DETACH DELETE the orphaned short channel ONCE after all
        // sibling merges. This wipes the original edges in a single operation.
        await run(
            `MATCH (short:MessageChannel {id: $shortId}) DETACH DELETE short`,
            { shortId },
        );
    }

    return pairs.length;
}

/**
 * Cross-kind MessageChannel dedup: merges (kindA, name) + (kindB, name) pairs
 * in the SAME service into a single node, preserving the producer-side label
 * (topic > subscription/queue). AMQP semantics: publishers emit to an exchange
 * (kind=topic, routing key); consumers bind a queue (kind=queue/subscription).
 * When the routing key equals the queue name (the conventional Symfony Messenger
 * setup), the static analyzer emits two nodes that logically refer to the same
 * channel.
 *
 * Idempotence: the surviving `topic` node accumulates `evidence_mergedFrom: [<ids>]` so
 * downstream queries can resolve a stale id to the canonical, and re-running
 * the welder does not duplicate entries.
 *
 * Multi-tenant safety: cross-service same-name pairs are merged ONLY when both
 * sides are physicalized onto the SAME clean physical broker (path c) — the
 * shared broker IS the tenant boundary. Without broker parity, cross-service
 * same-name pairs stay independent (different services may legitimately use
 * the same channel name for unrelated topics).
 */
export async function deduplicateMessageChannelsByExactNameDifferentKind(): Promise<{ merged: number }> {
    // Three acceptance paths for the merge, executed as separate queries and
    // unioned in TypeScript (Memgraph's OPTIONAL MATCH does not preserve the
    // outer-MATCH "single shared Service" guard, so combining them in a
    // single Cypher would weaken the cross-service safety):
    //
    //   (a) Both sides are code-derived and a single Service publishes/listens
    //       to both — the original safety check. Prevents accidental merges
    //       across unrelated services that happen to share a name.
    //   (b) One side is infra-derived (`discoverySource = 'config'`, set by
    //       structural plugins like rabbitmq-config). The broker topology is
    //       the source of truth for the name + transport pairing — there is
    //       no Service edge on the infra side because infra ingest never
    //       writes Function nodes. Without this, code-side `acme.X` (topic)
    //       and infra-side `acme.X` (queue) on the same broker never merge.
    //   (c) Cross-service broker-grounded (below, after query b): same exact
    //       name, both sides on the SAME non-needsReview physical broker.
    const sharedServiceResult = await run(
        `MATCH (topic:MessageChannel)
         WHERE topic.valid_to_commit IS NULL AND topic.channelKind = 'topic'
         MATCH (subordinate:MessageChannel)
         WHERE subordinate.valid_to_commit IS NULL
           AND subordinate.channelKind IN ['subscription', 'queue', 'exchange']
           AND subordinate.name = topic.name
           AND subordinate.id <> topic.id
           AND (coalesce(topic.brokerUrn, '') = coalesce(subordinate.brokerUrn, ''))
         MATCH (s:Service)-[:CONTAINS]->(:Function)-[:PUBLISHES_TO|LISTENS_TO]->(topic)
         MATCH (s)-[:CONTAINS]->(:Function)-[:PUBLISHES_TO|LISTENS_TO]->(subordinate)
         RETURN DISTINCT topic.id AS topicId,
                         subordinate.id AS subId,
                         topic.evidence_mergedFrom AS topicMergedFrom`,
        {},
    );
    const infraDerivedResult = await run(
        `MATCH (topic:MessageChannel)
         WHERE topic.valid_to_commit IS NULL AND topic.channelKind = 'topic'
         MATCH (subordinate:MessageChannel)
         WHERE subordinate.valid_to_commit IS NULL
           AND subordinate.channelKind IN ['subscription', 'queue', 'exchange']
           AND subordinate.name = topic.name
           AND subordinate.id <> topic.id
           AND (coalesce(topic.brokerUrn, '') = coalesce(subordinate.brokerUrn, ''))
           AND (topic.discoverySource = 'config' OR subordinate.discoverySource = 'config')
         RETURN DISTINCT topic.id AS topicId,
                         subordinate.id AS subId,
                         topic.evidence_mergedFrom AS topicMergedFrom`,
        {},
    );
    //   (c) Cross-service, broker-grounded: publisher and consumer live in
    //       DIFFERENT services but both sides are physicalized onto the SAME
    //       physical broker. The broker parity replaces the shared-Service
    //       multi-tenant guard — two tenants' same-name channels can only
    //       collide here if they genuinely share the broker, in which case
    //       they ARE the same channel. Guards (no coalesce!):
    //         - brokerUrn NON-NULL on both sides and equal;
    //         - the shared broker is NOT needsReview: a guess-born broker
    //           (key-name provider, vhost-ambiguous) must never become
    //           load-bearing for a cross-service weld.
    const brokerGroundedResult = await run(
        `MATCH (topic:MessageChannel)
         WHERE topic.valid_to_commit IS NULL AND topic.channelKind = 'topic'
           AND topic.brokerUrn IS NOT NULL
         MATCH (subordinate:MessageChannel)
         WHERE subordinate.valid_to_commit IS NULL
           AND subordinate.channelKind IN ['subscription', 'queue']
           AND subordinate.name = topic.name
           AND subordinate.id <> topic.id
           AND subordinate.brokerUrn = topic.brokerUrn
         MATCH (b:MessageBroker {id: topic.brokerUrn})
         WHERE b.valid_to_commit IS NULL
           AND coalesce(b.needsReview, false) = false
         RETURN DISTINCT topic.id AS topicId,
                         subordinate.id AS subId,
                         topic.evidence_mergedFrom AS topicMergedFrom`,
        {},
    );
    // Dedup pairs that appear in multiple queries (e.g. an infra-derived pair
    // that also has a shared Service edge). Without dedup we'd process the
    // merge twice — the idempotence guard below would catch it, but at the
    // cost of an extra DB round-trip per duplicate.
    const seenPairs = new Set<string>();
    const pairs: Array<{ topicId: string; subId: string; topicMergedFrom: string[] }> = [];
    for (const rec of [...sharedServiceResult.records, ...infraDerivedResult.records, ...brokerGroundedResult.records]) {
        const topicId = rec.get('topicId') as string;
        const subId = rec.get('subId') as string;
        const key = `${topicId}|${subId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        pairs.push({
            topicId,
            subId,
            topicMergedFrom: (rec.get('topicMergedFrom') as string[] | null) ?? [],
        });
    }

    if (pairs.length === 0) return { merged: 0 };

    let merged = 0;
    for (const { topicId, subId, topicMergedFrom } of pairs) {
        // Idempotence guard: if subId is already in evidence_mergedFrom, this is
        // a re-run on a previously-welded graph. Skip the data work; subordinate
        // node is already gone (or shouldn't be).
        if (topicMergedFrom.includes(subId)) {
            continue;
        }

        // Carry over technology/kindFamily from subordinate when topic lacks them.
        // Stamp composite grounding on the surviving node and dedup the
        // mergedFrom / extractors lists via Cypher reduce() (Memgraph's array
        // `+` does NOT dedup; without the reduce() pattern re-runs balloon).
        //
        // When either side is infra-derived (`discoverySource = 'config'`),
        // the merge itself IS the structural corroboration: the topology
        // declaration anchors the canonical name + transport. Clear the
        // `needsReview` flag so the channel exits the triage queue.
        await run(
            `MATCH (topic:MessageChannel {id: $topicId}), (sub:MessageChannel {id: $subId})
             SET topic.technology = coalesce(topic.technology, sub.technology),
                 topic.kindFamily = coalesce(topic.kindFamily, sub.kindFamily),
                 topic.discoverySource = coalesce(topic.discoverySource, sub.discoverySource),
                 topic.source = 'composite',
                 topic.needsReview = CASE
                     WHEN topic.discoverySource = 'config' OR sub.discoverySource = 'config'
                     THEN false
                     ELSE topic.needsReview
                 END,
                 topic.evidence_mergedFrom = reduce(_acc = [], _x IN coalesce(topic.evidence_mergedFrom, []) + [$subId] | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END),
                 topic.evidence_extractors = reduce(_acc = [], _x IN coalesce(topic.evidence_extractors, []) + ['cross-kind-weld@v1'] | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
            { topicId, subId },
        );

        // Rewire PUBLISHES_TO edges. Use separate statements per edge type:
        // Memgraph does not accept a dynamic relationship type variable in MERGE.
        await run(
            `MATCH (f:Function)-[r:PUBLISHES_TO]->(sub:MessageChannel {id: $subId})
             MATCH (topic:MessageChannel {id: $topicId})
             MERGE (f)-[newR:PUBLISHES_TO]->(topic)
             ON CREATE SET newR.valid_from_commit = 'SYSTEM', newR.valid_to_commit = null
             DELETE r`,
            { topicId, subId },
        );

        // Rewire LISTENS_TO edges.
        await run(
            `MATCH (f:Function)-[r:LISTENS_TO]->(sub:MessageChannel {id: $subId})
             MATCH (topic:MessageChannel {id: $topicId})
             MERGE (f)-[newR:LISTENS_TO]->(topic)
             ON CREATE SET newR.valid_from_commit = 'SYSTEM', newR.valid_to_commit = null
             DELETE r`,
            { topicId, subId },
        );

        // Tombstone the subordinate node. Memgraph DETACH DELETE is safe even
        // if other edges remain (it removes them).
        await run(
            `MATCH (sub:MessageChannel {id: $subId}) DETACH DELETE sub`,
            { subId },
        );

        merged++;
    }

    return { merged };
}

export async function resolveDynamicInfrastructure(reporter: ProgressReporter): Promise<{ stubsProcessed: number; stubsResolved: number; stubsNormalized: number; stubsUnresolved: number; channelsWelded: number }> {
    const stubs = await getDynamicInfraStubs();
    logger.debug(`[DynamicInfraResolver] Found ${stubs.length} dynamic stub(s): ${stubs.map(s => s.name).join(', ') || '(none)'}`);
    // Channel suffix + cross-kind dedup moved to runReconcile() so they fire
    // unconditionally on every ingest entry point (code / infra / standalone).
    // `channelsWelded` stays in the return shape but is always zero here.
    if (stubs.length === 0) {
        return { stubsProcessed: 0, stubsResolved: 0, stubsNormalized: 0, stubsUnresolved: 0, channelsWelded: 0 };
    }

    // Group stubs by type to optimize concrete node fetching from the DB
    const stubsByType = new Map<string, typeof stubs>();
    for (const stub of stubs) {
        if (!stubsByType.has(stub.type)) {
            stubsByType.set(stub.type, []);
        }
        stubsByType.get(stub.type)!.push(stub);
    }

    let stubsResolved = 0;
    let stubsNormalized = 0;
    let stubsUnresolved = 0;

    for (const [type, typeStubs] of stubsByType.entries()) {
        const concreteNodes = await getConcreteInfraNodes(type);
        logger.debug(`[DynamicInfraResolver] Type "${type}": ${concreteNodes.length} concrete node(s), ${typeStubs.length} stub(s)`);

        if (concreteNodes.length === 0) {
            // No concrete targets of this type exist in the graph yet
            // Try env-placeholder normalization as fallback before giving up
            for (const stub of typeStubs) {
                const normalized = normalizeEnvPlaceholder(stub.name);
                if (normalized) {
                    const promoted = await promoteStubToConcreteNode(stub.id, normalized, type, commitHash);
                    if (promoted) {
                        stubsNormalized++;
                        logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" → NORMALIZED to "${normalized}" (no concrete nodes of type "${type}")`);
                    } else {
                        stubsUnresolved++;
                    }
                } else {
                    await markDynamicStubUnresolved(stub.id, commitHash);
                    stubsUnresolved++;
                    logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" unresolved (no concrete nodes of type "${type}")`);
                }
            }
            continue;
        }

        for (const stub of typeStubs) {
            // Convert dynamic stub name to an exact regex pattern.
            // Escape special characters first, then replace the escaped \{...\} with `.+`
            const escapedString = stub.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const finalPattern = escapedString.replace(/\\{.*?\\}/g, '.+');

            // Guard against purely dynamic stubs (e.g. "{args.ts}" -> ".+")
            // If the final pattern consists ONLY of ".+", it has no static structural characters
            // and will match EVERY single concrete node in the graph, causing a Cartesian explosion.
            const isPurelyDynamic = finalPattern.replace(/\.\+/g, '') === '';
            if (isPurelyDynamic) {
                logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" is purely dynamic — DETACH DELETE (no static anchor for resolution).`);
                await run(
                    `MATCH (n {id: $stubId}) DETACH DELETE n`,
                    { stubId: stub.id },
                );
                stubsUnresolved++;
                continue;
            }

            const regex = new RegExp(`^${finalPattern}$`);

            const matchedUrns = concreteNodes
                .filter(node => regex.test(node.name))
                .map(node => node.id);

            // Guard: cap cardinality to prevent excessive fan-out from weak anchors
            if (matchedUrns.length > MAX_DYNAMIC_MATCH) {
                logger.warn(`[DynamicInfraResolver] Stub "${stub.name}" matched ${matchedUrns.length} nodes (cap: ${MAX_DYNAMIC_MATCH}). Excessive fan-out — DETACH DELETE.`);
                await run(
                    `MATCH (n {id: $stubId}) DETACH DELETE n`,
                    { stubId: stub.id },
                );
                stubsUnresolved++;
                continue;
            }

            if (matchedUrns.length > 0) {
                logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" → matched ${matchedUrns.length} concrete node(s): ${concreteNodes.filter(n => regex.test(n.name)).map(n => n.name).join(', ')}`);
                await rewireDynamicToConcrete(stub.id, matchedUrns, stub.name, commitHash);
                stubsResolved++;
            } else {
                // Regex matched 0 concrete nodes — try env-placeholder normalization
                const normalized = normalizeEnvPlaceholder(stub.name);
                if (normalized) {
                    const promoted = await promoteStubToConcreteNode(stub.id, normalized, type, commitHash);
                    if (promoted) {
                        stubsNormalized++;
                        logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" → NORMALIZED to "${normalized}" (regex /${regex.source}/ matched 0 of ${concreteNodes.length} nodes)`);
                    } else {
                        stubsUnresolved++;
                    }
                } else {
                    logger.debug(`[DynamicInfraResolver] Stub "${stub.name}" → UNRESOLVED (regex /${regex.source}/ matched 0 of ${concreteNodes.length} nodes)`);
                    await markDynamicStubUnresolved(stub.id, commitHash);
                    stubsUnresolved++;
                }
            }
        }
    }

    // Channel suffix + cross-kind dedup are now part of runReconcile(); see
    // src/ingestion/workflows/reconcile.workflow.ts.
    return {
        stubsProcessed: stubs.length,
        stubsResolved,
        stubsNormalized,
        stubsUnresolved,
        channelsWelded: 0,
    };
}

