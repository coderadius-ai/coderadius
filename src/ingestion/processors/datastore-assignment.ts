// ═══════════════════════════════════════════════════════════════════════════════
// Datastore Assignment Step — Per-Table LLM Binding for Multi-Identity Scopes
//
// Runs as a workflow step AFTER the per-file ingestion pass. For each scope
// that has 2+ canonical Datastore identities (multi-database shape: separate
// `orders` + `payments` logical DBs), this orchestrator:
//   1. Queries DCs in the scope that have NO active STORED_IN edge yet (i.e.
//      the per-file writer deferred binding to here).
//   2. Asks the LLM agent to assign each DC to one of the candidate
//      identities.
//   3. Writes a single STORED_IN edge per DC with bindingReason='llm-assignment'.
//
// Cost: 1 LLM call per scope per sync. Cached on disk by content-hash.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getNeo4jSession } from '../../graph/neo4j.js';
import { paths } from '../../config/paths.js';
import { linkDataContainerStoredIn } from '../../graph/mutations/data-contracts.js';
import { buildUrn } from '../../graph/urn.js';
import { logger } from '../../utils/logger.js';
import { withCongestionControl } from '../../utils/congestion-control.js';
import {
    getDatastoreAssignmentAgent,
    DatastoreAssignmentSchema,
    type DatastoreAssignmentResult,
} from '../../ai/agents/datastore-assignment-agent.js';
import type { DatastoreIdentity } from './db-scope-resolver.js';

// ─── Cache layer ─────────────────────────────────────────────────────────────

const CACHE_DIR = paths.cache.dir;
const CACHE_FILE = paths.cache.datastoreAssignments;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

interface CacheEntry {
    key: string;
    timestamp: number;
    result: DatastoreAssignmentResult;
}

function cacheKey(scope: string, dcNames: string[], identities: DatastoreIdentity[]): string {
    const sortedDcs = [...dcNames].sort();
    const sortedIds = [...identities].map(i => i.identityKey).sort();
    const material = JSON.stringify({ scope, sortedDcs, sortedIds });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function readCache(key: string): DatastoreAssignmentResult | null {
    if (!fs.existsSync(CACHE_FILE)) return null;
    try {
        const lines = fs.readFileSync(CACHE_FILE, 'utf8').split('\n').filter(l => l.trim());
        const cutoff = Date.now() - CACHE_TTL_MS;
        for (let i = lines.length - 1; i >= 0; i--) {
            const entry: CacheEntry = JSON.parse(lines[i]);
            if (entry.key !== key) continue;
            if (entry.timestamp < cutoff) return null;
            return entry.result;
        }
    } catch (e) {
        logger.debug(`[DatastoreAssignment] cache read failed: ${(e as Error).message}`);
    }
    return null;
}

function writeCache(key: string, result: DatastoreAssignmentResult): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const entry: CacheEntry = { key, timestamp: Date.now(), result };
        fs.appendFileSync(CACHE_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        logger.debug(`[DatastoreAssignment] cache write failed: ${(e as Error).message}`);
    }
}

// ─── Graph queries ───────────────────────────────────────────────────────────

interface PendingDc {
    name: string;
    kindFamily: string | null;
}

/**
 * Find DCs in a scope that need LLM-assisted binding refinement. A DC
 * qualifies when:
 *   - It has `kindFamily` set (any classification confidence at all), AND
 *   - It either has NO active STORED_IN, OR has a STORED_IN with
 *     `bindingReason='env-canonical-default'` (graph-writer wrote a
 *     placeholder during the per-file pass; assignment may now refine it).
 */
async function findPendingAssignments(scope: string): Promise<PendingDc[]> {
    const s = getNeo4jSession();
    try {
        const r = await s.run(
            `MATCH (dc:DataContainer {scope: $scope})
             WHERE dc.valid_to_commit IS NULL
               AND dc.kindFamily IS NOT NULL
               AND (
                   NOT EXISTS {
                       MATCH (dc)-[r:STORED_IN]->(:Datastore)
                       WHERE r.valid_to_commit IS NULL
                   }
                   OR EXISTS {
                       MATCH (dc)-[r:STORED_IN]->(:Datastore)
                       WHERE r.valid_to_commit IS NULL
                         AND r.bindingReason = 'env-canonical-default'
                   }
               )
             RETURN dc.name AS name, dc.kindFamily AS kindFamily
             ORDER BY name`,
            { scope },
        );
        return r.records.map(rec => ({
            name: rec.get('name'),
            kindFamily: rec.get('kindFamily') ?? null,
        }));
    } finally {
        await s.close();
    }
}

/**
 * Tombstone any active `STORED_IN` edge from a DC whose `bindingReason` is
 * 'env-canonical-default' — the placeholder written by the per-file
 * pipeline. The assignment step replaces it with a fresh edge stamped with
 * `bindingReason='llm-assignment'` (or keeps the canonical when the LLM
 * agrees with it).
 */
async function tombstoneCanonicalDefault(dcUrn: string, commitHash: string): Promise<void> {
    const s = getNeo4jSession();
    try {
        await s.run(
            `MATCH (dc:DataContainer {id: $dcUrn})-[r:STORED_IN]->(:Datastore)
             WHERE r.valid_to_commit IS NULL
               AND r.bindingReason = 'env-canonical-default'
             SET r.valid_to_commit = $commitHash`,
            { dcUrn, commitHash },
        );
    } finally {
        await s.close();
    }
}

/**
 * Group DCs by kindFamily so the LLM only sees compatible candidates.
 * RDBMS DCs only get RDBMS identity candidates, document DCs only get
 * document identity candidates, etc.
 */
function bucketByFamily(
    pending: PendingDc[],
    identities: DatastoreIdentity[],
    familyOf: (tech: string) => string | null,
): Map<string, { dcs: PendingDc[]; candidates: DatastoreIdentity[] }> {
    const buckets = new Map<string, { dcs: PendingDc[]; candidates: DatastoreIdentity[] }>();
    const familyToIdentities = new Map<string, DatastoreIdentity[]>();
    for (const id of identities) {
        const fam = familyOf(id.canonicalHint.technology);
        if (!fam) continue;
        if (!familyToIdentities.has(fam)) familyToIdentities.set(fam, []);
        familyToIdentities.get(fam)!.push(id);
    }
    for (const dc of pending) {
        if (!dc.kindFamily) continue;
        const candidates = familyToIdentities.get(dc.kindFamily) ?? [];
        if (candidates.length < 2) continue;     // sole-candidate or none → no LLM needed
        if (!buckets.has(dc.kindFamily)) buckets.set(dc.kindFamily, { dcs: [], candidates });
        buckets.get(dc.kindFamily)!.dcs.push(dc);
    }
    return buckets;
}

// ─── LLM invocation ──────────────────────────────────────────────────────────

async function callAgent(
    scope: string,
    dcs: PendingDc[],
    candidates: DatastoreIdentity[],
): Promise<DatastoreAssignmentResult> {
    const agent = getDatastoreAssignmentAgent();
    const prompt = [
        `SCOPE: ${scope}`,
        '',
        'CANDIDATES:',
        ...candidates.map(c => {
            const envs = c.environments.map(e => `${e.environment}:${e.host}`).join(', ');
            return `- identityKey="${c.identityKey}" technology="${c.canonicalHint.technology}" environments=[${envs}]`;
        }),
        '',
        'TABLES:',
        ...dcs.map(d => `- ${d.name}`),
        '',
        'For each TABLE, return one assignment with the chosen identityKey. Use only identityKey values from CANDIDATES above.',
    ].join('\n');

    const result = await withCongestionControl(() =>
        agent.generate(prompt, {
            structuredOutput: { schema: DatastoreAssignmentSchema },
            modelSettings: { maxRetries: 0, temperature: 0 },
            abortSignal: AbortSignal.timeout(60_000),
        })
    );
    return result.object as DatastoreAssignmentResult;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export interface AssignmentRunResult {
    /** Number of scopes for which LLM assignment ran. */
    scopesProcessed: number;
    /** Number of DCs that received a STORED_IN edge from this step. */
    edgesWritten: number;
    /** LLM calls made (excludes cache hits). */
    llmCalls: number;
}

/**
 * Run the assignment step for a single scope.
 *
 * @param scope         qualifiedRepoName (the DataContainer.scope value).
 * @param identities    Canonical Datastore identities for the scope.
 * @param familyOf      tech → kindFamily lookup (passed by caller to avoid
 *                      a circular import with db-scope-resolver).
 * @param commitHash    current commit, stamped on each STORED_IN edge.
 * @param refreshCache  bypass cache, force a fresh LLM call.
 */
export async function assignDatastoresForScope(
    scope: string,
    identities: DatastoreIdentity[],
    familyOf: (tech: string) => string | null,
    commitHash: string,
    refreshCache: boolean = false,
): Promise<AssignmentRunResult> {
    const result: AssignmentRunResult = { scopesProcessed: 0, edgesWritten: 0, llmCalls: 0 };
    if (identities.length < 2) return result;     // No ambiguity → nothing to do.

    const pending = await findPendingAssignments(scope);
    if (pending.length === 0) return result;

    const buckets = bucketByFamily(pending, identities, familyOf);
    if (buckets.size === 0) return result;

    result.scopesProcessed = 1;

    for (const { dcs, candidates } of buckets.values()) {
        const dcNames = dcs.map(d => d.name);
        const key = cacheKey(scope, dcNames, candidates);
        let agentResult = refreshCache ? null : readCache(key);
        if (!agentResult) {
            try {
                agentResult = await callAgent(scope, dcs, candidates);
                writeCache(key, agentResult);
                result.llmCalls++;
            } catch (e) {
                logger.warn(`[DatastoreAssignment] agent call failed for scope=${scope}: ${(e as Error).message}. Falling back to canonical-default.`);
                // Fail-soft: assign every DC to the first candidate (helm-prod
                // canonical) with reduced confidence.
                agentResult = {
                    assignments: dcs.map(d => ({
                        tableName: d.name,
                        datastoreIdentity: candidates[0].identityKey,
                        confidence: 0.4,
                        reasoning: 'fallback (LLM unavailable)',
                    })),
                };
            }
        }

        // Apply assignments.
        const validIds = new Set(candidates.map(c => c.identityKey));
        const techByIdentity = new Map(candidates.map(c => [c.identityKey, c.canonicalHint.technology] as const));
        for (const a of agentResult.assignments) {
            if (!validIds.has(a.datastoreIdentity)) {
                logger.warn(`[DatastoreAssignment] LLM proposed unknown identity "${a.datastoreIdentity}" for table "${a.tableName}" — skipping`);
                continue;
            }
            const dcUrn = buildUrn('datacontainer', scope, a.tableName);
            // Tombstone any pre-existing canonical-default placeholder so we
            // don't end up with two active STORED_IN edges from this DC.
            await tombstoneCanonicalDefault(dcUrn, commitHash);
            const datastoreUrn = buildUrn('datastore', scope, a.datastoreIdentity);
            const reason = a.confidence >= 0.5 ? 'llm-assignment' : 'env-canonical-default';
            // Datastore assignment is LLM-driven over candidate identities; quality
            // tracks the model's confidence tier so downstream filters can suppress
            // weak bindings.
            const quality: import('../../graph/grounding.js').Quality =
                a.confidence >= 0.8 ? 'high'
                    : a.confidence >= 0.5 ? 'medium'
                        : 'low';
            const prov: import('../../graph/grounding.js').GroundingFields = {
                source: 'llm',
                quality,
                evidence: { extractors: ['datastore-assignment@v1'] },
            };
            await linkDataContainerStoredIn(
                scope, a.tableName, datastoreUrn, commitHash, reason, scope, prov,
            );
            // Best-effort: stamp dc.technology from the assigned datastore so
            // existing query patterns (which read dc.technology) reflect the
            // chosen binding.
            const tech = techByIdentity.get(a.datastoreIdentity);
            if (tech) {
                const s = getNeo4jSession();
                try {
                    await s.run(
                        `MATCH (dc:DataContainer {id: $dcUrn})
                         SET dc.technology = $tech, dc.datastoreUrn = $datastoreUrn`,
                        { dcUrn, tech, datastoreUrn },
                    );
                } finally { await s.close(); }
            }
            result.edgesWritten++;
        }
    }

    return result;
}
