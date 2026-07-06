/**
 * Team Alias Resolver — Orchestration Layer
 *
 * Two-phase execution on every ingestion:
 *
 * Phase 1 — RE-APPLY: For all approved aliases, materialize [:OWNS] edges on
 *   any new orphan repos/services that appeared since the last ingestion.
 *   This prevents the "Day-2 orphan bug" where new repos under an already-approved
 *   phantom prefix would remain unlinked forever.
 *
 * Phase 2 — PROPOSE: Detect new phantom org-prefixes (not yet covered by a
 *   Team node or existing alias) and resolve them via a two-level strategy:
 *
 *   Level 1 — Deterministic (zero LLM, confidence=1.0):
 *     Exact segment matching: prefix stripping, suffix stripping, contains.
 *     Safe against false positives because it only matches when the team name
 *     appears as a complete word in the phantom (no substring-of-substring).
 *
 *   Level 2 — LLM batching (CHUNK_SIZE=20, bounded output tokens):
 *     Phantoms that survive Level 1 are send to the LLM in batches of 20.
 *     20 proposals × ~60 tokens each ≈ 1,200 output tokens — well within any
 *     provider limit. This avoids the O(N) N+1 problem while bounding output
 *     size against truncation.
 *
 * Why no Levenshtein/Jaro-Winkler (Level 2 fuzzy)?
 *   Dropped deliberately. On short team names (≤6 chars) fuzzy matchers produce
 *   catastrophic false positives: "fe-core" → "be-core" (distance 1),
 *   "dev" → "ops" (distance 3/3 → 100% similarity). The LLM understands
 *   organizational context. Jaro-Winkler does not.
 */
import { getMemgraphSession } from '../../graph/neo4j.js';
import { getMastra } from '../../ai/mastra/index.js';
import { TeamAliasProposalSchema } from '../../ai/agents/team-alias-resolver.js';
import { mergeTeamAlias, reapplyApprovedAliases } from '../../graph/mutations/team-alias.js';
import { logger } from '../../utils/logger.js';
import type { ProgressReporter } from '../core/progress.js';
import { withCongestionControl } from '../../utils/congestion-control.js';

// ─── Level 1: Deterministic String Match ─────────────────────────────────────

/**
 * Attempts to resolve a phantom org-prefix to a known team using pure string
 * operations. Returns the matching canonical team name, or null if unresolved.
 *
 * Matching rules (in priority order):
 *  1. Exact match (case-insensitive) — e.g. "Payments" → "payments"
 *  2. Phantom is a compound of known team name:
 *     - Suffix: "it-dev-payments" ends with "-payments" → "payments"
 *     - Prefix: "payments-squad"  starts with "payments-" → "payments"
 *     - Contains: "acme-payments-v2" contains "-payments-" → "payments"
 *     All require the team name to appear as a WHOLE word (bounded by - / _ space),
 *     not as a substring of another word (no false positives like "payment" → "pay").
 *
 * Deliberately conservative: returns null rather than guess. False positives
 * (wrong team linked) are worse than false negatives (phantom stays unresolved).
 */
export function deterministicTeamMatch(phantom: string, knownTeams: string[]): string | null {
    const p = phantom.toLowerCase();

    // Sort by length descending: longer names are more specific and should be
    // matched first. Without this, "payments" would match before "core-payments"
    // for a phantom like "acme-core-payments".
    const sorted = [...knownTeams].sort((a, b) => b.length - a.length);

    for (const team of sorted) {
        const t = team.toLowerCase();
        if (t.length < 2) continue; // Too short to match safely

        // 1. Exact match
        if (p === t) return team;

        // 2. Phantom ends with "-{team}" or "/{team}" or "_{team}"
        //    e.g. "it-dev-payments" → team "payments"
        if (p.endsWith(`-${t}`) || p.endsWith(`/${t}`) || p.endsWith(`_${t}`)) return team;

        // 3. Phantom starts with "{team}-" or "{team}/" or "{team}_"
        //    e.g. "payments-squad" → team "payments"
        if (p.startsWith(`${t}-`) || p.startsWith(`${t}/`) || p.startsWith(`${t}_`)) return team;

        // 4. Team name appears as a whole segment in the middle of the phantom
        //    e.g. "acme-payments-v2" contains phantom "-payments-" (bounded both sides)
        //    Only for team names > 4 chars to avoid matching short tokens like "be", "fe", "ops"
        if (t.length > 4 && (
            p.includes(`-${t}-`) ||
            p.includes(`/${t}/`) ||
            p.includes(`_${t}_`)
        )) return team;
    }

    return null;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/** Maximum phantoms sent to LLM per batch. Bounded by output token budget:
 *  20 proposals × ~60 tokens/proposal (phantomName + canonicalTeam + confidence + reasoning) ≈ 1,200 tokens.
 *  Well within the 4,096 output limit of any commercial model. */
const LLM_BATCH_SIZE = 20;

export async function resolveTeamAliases(r?: ProgressReporter): Promise<{
    proposalsCreated: number;
    unresolvable: string[];
}> {
    // ── Phase 1: Re-apply approved aliases to catch new orphan repos ─────────
    const reapplyResult = await reapplyApprovedAliases();
    if (reapplyResult.totalReposLinked > 0 || reapplyResult.totalServicesLinked > 0) {
        r?.report(
            `[Team Alias] Re-applied ${reapplyResult.aliasesProcessed} approved alias(es): `
            + `linked ${reapplyResult.totalReposLinked} new repo(s), ${reapplyResult.totalServicesLinked} new service(s)`,
        );
    }

    // ── Phase 2: Detect new phantoms and propose aliases ─────────────────────
    const session = getMemgraphSession();

    try {
        // 1. Query known teams (real Team nodes from Backstage/CODEOWNERS)
        const teamsResult = await session.run(`MATCH (t:Team) RETURN t.name AS name`);
        const knownTeams = teamsResult.records.map(rec => rec.get('name') as string);

        if (knownTeams.length === 0) {
            logger.debug('[TeamAlias] No known teams in graph — skipping alias resolution');
            return { proposalsCreated: 0, unresolvable: [] };
        }

        // 2. Query phantom org-prefixes: org roots with NO Team node and NO existing alias.
        // NOTE: Memgraph does not support EXISTS { subquery } after a WITH clause.
        // We use OPTIONAL MATCH anti-joins (WHERE x IS NULL) instead, which is fully
        // supported in Memgraph's openCypher dialect.
        const phantomResult = await session.run(`
            MATCH (repo:Repository)-[:BELONGS_TO]->(org:Organization)
            WITH org.fullPath AS orgPrefix, count(DISTINCT repo) AS repoCount
            OPTIONAL MATCH (t:Team)
            WHERE t.name = orgPrefix
            OPTIONAL MATCH (a:TeamAlias)
            WHERE a.phantomName = orgPrefix
            WITH orgPrefix, repoCount, t, a
            WHERE t IS NULL AND a IS NULL
            RETURN orgPrefix, repoCount
            ORDER BY repoCount DESC
        `);
        const phantoms = phantomResult.records.map(rec => ({
            name: rec.get('orgPrefix') as string,
            repos: Number(rec.get('repoCount')),
        }));

        if (phantoms.length === 0) {
            logger.debug('[TeamAlias] No phantom org-prefixes found — all repos have matching teams');
            return { proposalsCreated: 0, unresolvable: [] };
        }

        r?.report(`[Team Alias] Found ${phantoms.length} phantom org-prefix(es), resolving against ${knownTeams.length} known team(s)...`);

        let created = 0;
        const allUnresolvable: string[] = [];
        const unresolvedPhantoms: typeof phantoms = [];

        // ── Level 1: Deterministic matching (zero LLM) ───────────────────────
        for (const phantom of phantoms) {
            const match = deterministicTeamMatch(phantom.name, knownTeams);
            if (match) {
                await mergeTeamAlias(phantom.name, match, 1.0, 'Deterministic string match (prefix/suffix/segment)');
                created++;
                r?.report(`[Team Alias] ✓ Deterministic: '${phantom.name}' → '${match}'`);
            } else {
                unresolvedPhantoms.push(phantom);
            }
        }

        if (unresolvedPhantoms.length === 0) {
            return { proposalsCreated: created, unresolvable: [] };
        }

        r?.report(`[Team Alias] ${unresolvedPhantoms.length} phantom(s) need LLM resolution (${Math.ceil(unresolvedPhantoms.length / LLM_BATCH_SIZE)} batch(es))...`);

        // ── Level 2: LLM batching — bounded output, no N+1 ───────────────────
        const agent = getMastra().getAgent('teamAliasResolverAgent');

        for (let i = 0; i < unresolvedPhantoms.length; i += LLM_BATCH_SIZE) {
            const chunk = unresolvedPhantoms.slice(i, i + LLM_BATCH_SIZE);
            const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(unresolvedPhantoms.length / LLM_BATCH_SIZE);

            r?.report(`[Team Alias] LLM batch ${batchNum}/${totalBatches} (${chunk.length} phantoms)...`);

            const prompt = [
                'KNOWN TEAMS:',
                ...knownTeams.map(t => `- ${t}`),
                '',
                'PHANTOM NAMES:',
                ...chunk.map(p => `- ${p.name} (${p.repos} repos)`),
            ].join('\n');

            try {
                const result = await withCongestionControl(() =>
                    agent.generate(prompt, {
                        structuredOutput: { schema: TeamAliasProposalSchema },
                        modelSettings: { maxRetries: 0, temperature: 0 },
                        abortSignal: AbortSignal.timeout(60_000),
                    })
                );

                const output = result.object;

                for (const proposal of output.proposals) {
                    if (!knownTeams.includes(proposal.canonicalTeam)) {
                        logger.warn(
                            `[TeamAlias] LLM proposed canonical team '${proposal.canonicalTeam}' which doesn't exist — skipping`,
                        );
                        continue;
                    }
                    await mergeTeamAlias(
                        proposal.phantomName,
                        proposal.canonicalTeam,
                        proposal.confidence,
                        proposal.reasoning,
                    );
                    created++;
                    r?.report(
                        `[Team Alias] Proposed: '${proposal.phantomName}' → '${proposal.canonicalTeam}' (${Math.round(proposal.confidence * 100)}%)`,
                    );
                }

                allUnresolvable.push(...output.unresolvable);

            } catch (err) {
                logger.warn(`[TeamAlias] LLM batch ${batchNum} failed: ${(err as Error).message} — phantoms skipped`);
                // Don't abort: remaining batches may still succeed
            }
        }

        if (allUnresolvable.length > 0) {
            r?.report(
                `[Team Alias] ${allUnresolvable.length} org-prefix(es) could not be mapped to any known team`,
            );
        }

        return { proposalsCreated: created, unresolvable: allUnresolvable };
    } finally {
        await session.close();
    }
}
