/**
 * Shared Cypher execution helper for all mutation modules.
 * Centralises session lifecycle management.
 *
 * Includes retry logic for transient unique constraint violations
 * caused by concurrent MERGE operations (two transactions racing to
 * CREATE the same non-existent node).
 */
import type { ManagedTransaction } from 'neo4j-driver';
import { getMemgraphSession } from '../neo4j.js';
import { logger } from '../../utils/logger.js';
import { flattenGrounding, type GroundingFields, type FlattenedGrounding } from '../grounding.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;

export async function run(cypher: string, params: Record<string, unknown> = {}) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const session = getMemgraphSession();
        try {
            return await session.executeWrite(async (tx) => {
                return await tx.run(cypher, params);
            });
        } catch (err: any) {
            const msg: string = err.message ?? '';
            const isTransientError = msg.includes('unique constraint violation') || msg.includes('conflicting transactions');
            if (isTransientError && attempt < MAX_RETRIES) {
                logger.debug(`[Cypher] Transient database error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`);
                const jitter = Math.random() * BASE_DELAY_MS;
                await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt) + jitter));
                continue;
            }
            throw err;
        } finally {
            await session.close();
        }
    }
    // Unreachable: the loop always returns or throws. Satisfies TypeScript control-flow analysis.
    throw new Error('[Cypher] Exhausted retries without result');
}

/**
 * Run N Cypher steps inside a SINGLE Memgraph transaction. All steps either
 * commit together (success) or roll back together (any step throws). Mirrors
 * the transient-error retry policy of `run()` (unique-constraint / conflicting-
 * transactions backoff) but applied to the whole transaction — on retry the
 * entire callback re-executes from the start.
 *
 * Use this when a welder must move edges + tombstone in atomicity to avoid
 * inconsistent intermediate states (e.g. channel-routing-pattern-resolver:
 * if move-edges succeed but DETACH fails, naïve `run()` per step would leak
 * the moved edges to a still-living code-channel).
 *
 * NB: `withScopedSession` / `runScoped` in
 * `src/ingestion/structural/queries.ts` REUSE a session but still open one
 * write tx per call — they are NOT atomic across calls. For atomicity, use
 * this helper.
 */
export async function runInTransaction(
    steps: ((tx: ManagedTransaction) => Promise<unknown>)[],
): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const session = getMemgraphSession();
        try {
            await session.executeWrite(async (tx) => {
                for (const step of steps) {
                    await step(tx);
                }
            });
            return;
        } catch (err: any) {
            const msg: string = err.message ?? '';
            const isTransientError = msg.includes('unique constraint violation') || msg.includes('conflicting transactions');
            if (isTransientError && attempt < MAX_RETRIES) {
                logger.debug(`[Cypher tx] Transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying entire tx...`);
                const jitter = Math.random() * BASE_DELAY_MS;
                await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt) + jitter));
                continue;
            }
            throw err;
        } finally {
            await session.close();
        }
    }
    throw new Error('[Cypher tx] Exhausted retries without commit');
}

// ─── Grounding write helpers ─────────────────────────────────────────────────
//
// Every node and edge in the graph carries grounding. Two patterns are exposed
// so mutations don't reimplement the flatten/SET/UNWIND-dedup logic each time:
//
//   1. `groundingParams(p, commitHash)` returns the parameter bag (flat keys,
//      e.g. `ground_source`, `ground_quality`, `ground_extractors`, ...) ready
//      to spread into the Cypher params object.
//
//   2. `groundingWriteClause(alias)` returns the Cypher fragment that:
//      - ON CREATE sets the 8 flat properties on `alias` from the params
//      - ON MATCH overwrites scalar properties (source, quality, etc.) but for
//        accumulator arrays (`evidence_extractors`, `evidence_fallbacksApplied`,
//        `evidence_mergedFrom`) uses reduce() to dedup atomically.
//
// The accumulator-dedup is critical: Memgraph's array `+` concatenates without
// dedup. A naive `coalesce(node.evidence_mergedFrom, []) + $new` would balloon
// across re-syncs into `['id1', 'id1', 'id1', ...]`. Atomic Cypher dedup avoids
// the TS-side .includes() guard pattern (race-prone and scattered).
//
// Usage in a mutation:
//   await run(`
//       MERGE (n:Foo {id: $id})
//       ON CREATE SET n.name = $name
//       ${groundingWriteClause('n')}
//   `, { id, name, ...groundingParams(ground, commitHash) });

/**
 * Default grounding for callers that haven't yet been migrated. Marked with
 * a deliberately weak combination (source='heuristic', quality='speculative')
 * so a re-touch by an untagged caller CANNOT silently downgrade a higher-trust
 * edge from `ast/exact` or `composite/high`: the ON MATCH write would visibly
 * tank the tier and operators see it in `cr review pending` or the dashboard's
 * "weakest tier" surfaces.
 *
 * Sweep target: `evidence_extractors CONTAINS 'untagged@v1'` lists every node
 * that landed here, so a later pass can assign a real extractor identity.
 */
const UNTAGGED_GROUNDING: GroundingFields = {
    source: 'heuristic',
    quality: 'speculative',
    evidence: { extractors: ['untagged@v1'] },
    needsReview: true,
};

let untaggedWarningEmitted = false;

export function groundingParams(
    p: GroundingFields | undefined,
    commitHash: string,
): Record<string, unknown> {
    if (p === undefined) {
        // Surface once per process so a developer adding a new mutation call
        // notices the missing argument instead of silently shipping untagged
        // writes. Quiet after the first emission to keep sync logs clean.
        if (!untaggedWarningEmitted) {
            logger.warn('[grounding] mutation invoked without grounding argument; defaulting to heuristic/speculative with needsReview=true. Grep `evidence_extractors CONTAINS \'untagged@v1\'` to triage.');
            untaggedWarningEmitted = true;
        }
    }
    const flat: FlattenedGrounding = flattenGrounding(p ?? UNTAGGED_GROUNDING);
    return {
        ground_source: flat.source,
        ground_quality: flat.quality,
        ground_extractors: flat.evidence_extractors,
        ground_llmCalls: flat.evidence_llmCalls,
        ground_fallbacksApplied: flat.evidence_fallbacksApplied,
        ground_mergedFrom: flat.evidence_mergedFrom,
        ground_needsReview: flat.needsReview,
        ground_lastSeenCommit: commitHash,
    };
}

/**
 * Cypher fragment that writes the 8 flat grounding fields onto `alias`.
 *
 * Append AFTER the caller's MERGE / ON CREATE SET / ON MATCH SET block. The
 * fragment is unconditional (single SET clauses; the caller has already
 * decided whether to create or match). Accumulator arrays
 * (`evidence_extractors`, `evidence_fallbacksApplied`, `evidence_mergedFrom`)
 * union with the existing on-node values then dedupe atomically via
 * reduce(), because Memgraph's array `+` does not dedup.
 *
 * Dedup philosophy:
 *   - The $ground_* params passed in are ALREADY deduped by the TypeScript
 *     builders in `grounding.ts` (uniqueAppend / uniqueConcat).
 *   - The Cypher dedupes when merging with the pre-existing on-node values.
 *   - The dedup-chain runs even when there are no pre-existing values; it's
 *     idempotent on a fresh ON CREATE.
 *
 * The fragment ENDS with a `WITH ${alias}` clause so the caller can continue
 * with additional Cypher (return values, additional MATCHes, etc.).
 */
export function groundingWriteClause(alias: string, refPrefix = '$ground_'): string {
    // Dedup via Cypher `reduce()` over the combined existing + new lists.
    // The accumulator pattern keeps only first-seen elements (`x IN acc` checks
    // membership in the running result). Single-statement, atomic, no UNWIND
    // chain (which would emit zero rows on empty input and kill the query).
    //
    // CASE wraps so we materialise null when the deduped list is empty,
    // keeping the property absent rather than as an empty array.
    //
    // `refPrefix` selects where the grounding values come from: the default
    // `$ground_` reads per-call params (single-entity mutations); UNWIND-batched
    // writers pass `row.ground_` so each row carries its own grounding (the row
    // fields are produced by the same `groundingParams()` bag).
    const dedupedExpr = (existing: string, incoming: string) =>
        `reduce(_acc = [], _x IN coalesce(${existing}, []) + coalesce(${incoming}, []) | CASE WHEN _x IN _acc THEN _acc ELSE _acc + _x END)`;
    return `
        SET ${alias}.source = ${refPrefix}source,
            ${alias}.quality = ${refPrefix}quality,
            ${alias}.evidence_llmCalls = ${refPrefix}llmCalls,
            ${alias}.needsReview = ${refPrefix}needsReview,
            ${alias}.lastSeenCommit = ${refPrefix}lastSeenCommit,
            ${alias}.evidence_extractors = ${dedupedExpr(`${alias}.evidence_extractors`, `${refPrefix}extractors`)},
            ${alias}.evidence_fallbacksApplied = CASE
                WHEN size(${dedupedExpr(`${alias}.evidence_fallbacksApplied`, `${refPrefix}fallbacksApplied`)}) > 0
                THEN ${dedupedExpr(`${alias}.evidence_fallbacksApplied`, `${refPrefix}fallbacksApplied`)}
                ELSE null
            END,
            ${alias}.evidence_mergedFrom = CASE
                WHEN size(${dedupedExpr(`${alias}.evidence_mergedFrom`, `${refPrefix}mergedFrom`)}) > 0
                THEN ${dedupedExpr(`${alias}.evidence_mergedFrom`, `${refPrefix}mergedFrom`)}
                ELSE null
            END
    `;
}

/**
 * Execute a DDL statement (CREATE/DROP INDEX, CREATE VECTOR INDEX, etc.) using an
 * implicit (auto-committing) transaction.
 *
 * Memgraph requires DDL to run outside explicit multi-command transactions:
 * https://memgraph.com/docs/querying/create-graph-objects#index-manipulation
 *
 * Unlike `run()`, this does NOT retry on constraint violations: DDL is not
 * subject to concurrent MERGE races.
 */
export async function runDDL(cypher: string, params: Record<string, unknown> = {}) {
    const session = getMemgraphSession();
    try {
        // session.run() executes in an implicit (auto-commit) transaction
        return await session.run(cypher, params);
    } finally {
        await session.close();
    }
}
