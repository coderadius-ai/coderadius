/**
 * Channel ↔ connection binding (B6) — same-file join.
 *
 * Structural messaging plugins stamp `connectionRef` + `_sourcePath` on the
 * channels they emit (oldsound producer/consumer `connection`, messenger
 * transport name); the s4 config-declared mint stamps `connectionName` +
 * `sourceFile` (+ `sourceRepoUrn`) on the brokers minted from the SAME
 * config file's connections. This pass joins the two:
 *
 *   MessageChannel{connectionRef, _sourcePath} ↔
 *   MessageBroker{connectionName, sourceFile}      (same file, same repo)
 *
 * → `(ch)-[:HOSTED_ON]->(b)` + `ch.brokerUrn`, the Tier-1 signal of the
 * channel autopromoter (a logical channel welds onto the physical bound to
 * the broker of ITS OWN connection — per-vhost correctness by construction).
 *
 * Same-file scope is the safety boundary: a connection alias (`default`) is
 * only meaningful inside the file that declares it; cross-file aliases never
 * join. A channel matching >1 broker is left untouched (never a blind bind).
 *
 * v1 limit (explicit): same-named channels across files converge on ONE node
 * (URN has no fingerprint), so connectionRef/_sourcePath are last-writer-wins
 * — but always a CONSISTENT pair (they arrive in a single merge write), so
 * the join can pick the wrong file's broker at worst, never a chimera.
 */
import { run } from '../../graph/mutations/_run.js';
import { logger } from '../../utils/logger.js';

export interface ChannelConnectionBindingResult {
    /** Channels bound to their connection's broker (HOSTED_ON + brokerUrn). */
    bound: number;
    /** Channels matching >1 broker — skipped, never a blind bind. */
    ambiguous: number;
}

export async function runChannelConnectionBinding(commitHash: string): Promise<ChannelConnectionBindingResult> {
    const result: ChannelConnectionBindingResult = { bound: 0, ambiguous: 0 };

    const rows = await run(
        `MATCH (ch:MessageChannel)
         WHERE ch.valid_to_commit IS NULL
           AND ch.connectionRef IS NOT NULL AND ch._sourcePath IS NOT NULL
         MATCH (b:MessageBroker)
         WHERE b.valid_to_commit IS NULL
           AND b.connectionName = ch.connectionRef
           AND b.sourceFile = ch._sourcePath
           AND (ch._repoUrn IS NULL OR b.sourceRepoUrn IS NULL
                OR ch._repoUrn = 'cr:repository:' + b.sourceRepoUrn)
         RETURN ch.id AS channelUrn, ch.name AS channelName, collect(DISTINCT b.id) AS brokerUrns`,
    );

    for (const rec of rows.records) {
        const channelUrn = rec.get('channelUrn') as string;
        const brokerUrns = rec.get('brokerUrns') as string[];
        if (brokerUrns.length > 1) {
            result.ambiguous++;
            logger.warn(
                `[channel-connection-binding] ${rec.get('channelName')}: ${brokerUrns.length} brokers match its connectionRef — skipped (never a blind bind)`,
            );
            continue;
        }
        await bindChannelToBroker(channelUrn, brokerUrns[0], commitHash);
        result.bound++;
    }
    return result;
}

async function bindChannelToBroker(channelUrn: string, brokerUrn: string, commitHash: string): Promise<void> {
    await run(
        `MATCH (ch:MessageChannel {id: $channelUrn}), (b:MessageBroker {id: $brokerUrn})
         MERGE (ch)-[r:HOSTED_ON]->(b)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.via = 'channel-connection-binding'
         ON MATCH SET r.valid_to_commit = null
         SET ch.brokerUrn = b.id,
             ch.evidence_extractors = reduce(_acc = [],
                 _x IN coalesce(ch.evidence_extractors, []) + ['channel-connection-binding@v1'] |
                 CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`,
        { channelUrn, brokerUrn, commitHash },
    );
}
