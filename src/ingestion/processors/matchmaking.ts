import crypto from 'node:crypto';
import { getBrokerParticipantFunctionUrns, getServiceEndpoints, getServiceFunctionsForMatchmaking, linkFunctionImplementsEndpoint, rewireGraphQLCodeToSDL, rewireImplementsEdgesToOpenApi } from '../../graph/mutations/api-contracts.js';
import { getAllServices, getServiceMatchmakingHash, updateServiceMatchmakingHash } from '../../graph/mutations/search.js';
import { vectorSearchEndpoints } from '../../graph/mutations/search.js';
import { matchFunctionsToEndpoints, type TargetedMatchTask } from '../../ai/agents/matchmaker.js';
import { normalizePathParams } from './api-path-utils.js';
import { isGraphQLPath } from '../../ai/workflows/sanitizer.js';
import { logger } from '../../utils/logger.js';

const commitHash = "SYSTEM";

// ─── In-Memory Vector Math ───────────────────────────────────────────────────

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns 0 for zero-length vectors. Pure math, ~2ms for 1000 vectors.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface MatchmakingFunction {
    urn: string;
    name: string;
    intent: string | null;
    embedding: number[] | null;
}

interface MatchmakingEndpoint {
    urn: string;
    path: string;
    method: string | null;
    operationId: string | null;
    summary: string | null;
    embedding: number[] | null;
}

// Re-export for external consumers
export type { TargetedMatchTask };

// ─── Constants ───────────────────────────────────────────────────────────────

const TOP_K = 5;                 // Number of candidate endpoints per function
const LLM_BATCH_SIZE = 20;      // Functions per LLM call (each with their Top-K)

/**
 * Minimum cosine similarity score for a candidate endpoint to be forwarded to
 * the LLM for validation. Candidates below this threshold are discarded after
 * the vector pre-filter, saving token spend on semantically unrelated pairs.
 *
 * Calibration guide (run with `LOG_LEVEL=debug` and look for "best score" logs):
 *   - If match quality degrades → lower to 0.55
 *   - If LLM is still batching many clear non-matches → raise to 0.70
 */
const SIMILARITY_THRESHOLD = 0.65;

/**
 * Common entry-point method names for PHP frameworks (Slim, Symfony, Laravel).
 * Only these methods are eligible for class-name-based operationId matching
 * to avoid false positives from utility methods.
 */
const ENTRY_POINT_METHODS = new Set([
    'handle', '__invoke', 'execute', 'run', 'process', 'action',
]);

/**
 * Extract the class base name from a fully-qualified function name for L1
 * operationId matching. Strips common controller/handler suffixes.
 *
 * Only returns a value for entry-point methods (handle, __invoke, execute, etc.)
 * to avoid false positives on utility methods.
 *
 * Examples:
 *   "Billing\OrderController.handle"                   → "order"
 *   "Billing\CompanyOrderController.handle"             → "companyorder"
 *   "Billing\UpdateSaveController.handle"               → "updatesave"
 *   "Acme\Crm\Core\Utility.parseXml"                  → null (not entry method)
 *   "some_global_function"                             → null (no class)
 */
export function extractClassBaseName(funcName: string): string | null {
    // Match "ClassName.methodName" at the end, preceded by namespace separator or start
    const match = funcName.match(/([^\\]+)\.([^.]+)$/);
    if (!match) return null;

    const [, className, methodName] = match;

    // Only match entry-point methods to avoid false positives
    if (!ENTRY_POINT_METHODS.has(methodName)) return null;

    // Strip common controller/handler/command suffixes
    const baseName = className
        .replace(/(Controller|Handler|Command|Action|Middleware|RequestHandler)$/i, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();

    return baseName || null;
}

/**
 * API Endpoint Matchmaking — V2 Targeted Architecture
 *
 * Three-level matching pipeline:
 *   L1: Lexical Exact Match (method+path normalization + class name tokenization)
 *   L2: Vector Similarity Pre-filtering (Top-K candidates per function)
 *   L3: LLM Targeted Validation (batched, small prompts)
 *
 * This replaces the brute-force approach where ALL functions × ALL endpoints
 * were sent to the LLM in a single prompt.
 */
/**
 * Order-independent fingerprint of the matchmaking inputs.
 * Sorts copies by URN so the hash depends only on candidate CONTENT, never on
 * Memgraph row order (which has no ORDER BY guarantee and reshuffles on write).
 */
export function computeMatchmakingStateHash(
    eligibleFunctions: MatchmakingFunction[],
    httpEndpoints: MatchmakingEndpoint[],
): string {
    const functions = [...eligibleFunctions].sort((a, b) => a.urn.localeCompare(b.urn));
    const endpoints = [...httpEndpoints].sort((a, b) => a.urn.localeCompare(b.urn));
    return crypto.createHash('sha256')
        .update(JSON.stringify({ functions, endpoints }))
        .digest('hex');
}

export async function ingestMatchmaking(task?: any): Promise<{
    servicesMatched: number;
    linksCreated: number;
    errors: string[];
}> {
    let servicesMatched = 0;
    let linksCreated = 0;
    const errors: string[] = [];

    try {
        const services = await getAllServices();
        if (task) task.report(`Evaluating ${services.length} services...`);

        for (const service of services) {
            try {
                const functions: MatchmakingFunction[] = await getServiceFunctionsForMatchmaking(service.id);
                const endpoints: MatchmakingEndpoint[] = await getServiceEndpoints(service.id);

                if (functions.length === 0 || endpoints.length === 0) continue;

                if (task) task.report(`Matching: ${service.name} (${functions.length} functions ↔ ${endpoints.length} endpoints)`);

                // Pre-filter: exclude functions that are broker participants (consumers/publishers).
                // A function with an active LISTENS_TO or PUBLISHES_TO edge is a message handler,
                // not an HTTP controller — wiring it to an endpoint is a semantic false positive.
                const brokerParticipantUrns = await getBrokerParticipantFunctionUrns(service.id);
                const eligibleFunctions = brokerParticipantUrns.size > 0
                    ? functions.filter(f => !brokerParticipantUrns.has(f.urn))
                    : functions;

                if (eligibleFunctions.length < functions.length && task) {
                    task.report(`  ↳ Excluded ${functions.length - eligibleFunctions.length} broker participant(s) from matchmaking`);
                }

                if (eligibleFunctions.length === 0) continue;

                // L0a: re-target code-inferred HTTP endpoints to OpenAPI canonical
                const rewired = await rewireImplementsEdgesToOpenApi(service.id, commitHash);
                if (rewired > 0) {
                    linksCreated += rewired;
                    if (task) task.report(`  ↳ L0a: ${rewired} IMPLEMENTS_ENDPOINT re-wired → OpenAPI`);
                }

                // L0b: rewire code-inferred GQL endpoints to SDL twin (if SDL was ingested)
                const gqlRewired = await rewireGraphQLCodeToSDL(service.id, commitHash);
                if (gqlRewired > 0) {
                    linksCreated += gqlRewired;
                    if (task) task.report(`  ↳ L0b: ${gqlRewired} GQL IMPLEMENTS_ENDPOINT re-wired → SDL`);
                }

                // ── Filter: only HTTP endpoints participate in L1/L2/L3 —
                // GraphQL operations are matched exclusively by the global-resolver
                // via operation+operationName semantics. Passing them to the LLM
                // matchmaker would produce false IMPLEMENTS_ENDPOINT links.
                const httpEndpoints = endpoints.filter(ep => !isGraphQLPath(ep.path));

                // Deterministic order for stable hashing AND stable L1/L3
                // prompt assembly. These are the arrays actually hashed and
                // iterated (the .filter() copies — sorting the originals, as
                // the old code did, never reached them): Memgraph returns rows
                // in storage order, which any write reshuffles, and a
                // row-order-dependent hash re-ran the full LLM matchmaking on
                // byte-identical candidates after every no-op resync.
                eligibleFunctions.sort((a, b) => a.urn.localeCompare(b.urn));
                httpEndpoints.sort((a, b) => a.urn.localeCompare(b.urn));

                // Use the httpEndpoints list (GQL excluded) for state hashing:
                // GQL operations are resolved separately, so they should not
                // invalidate or trigger re-runs of the HTTP matchmaking cache.
                const currentHash = computeMatchmakingStateHash(eligibleFunctions, httpEndpoints);
                // Use service URN (id) as the stable key — URN has qualifiedRepoName embedded
                const previousHash = await getServiceMatchmakingHash(service.id);

                if (currentHash === previousHash) {
                    if (task) task.report(`${service.name}: Matchmaking inputs unchanged, skipping.`);
                    continue;
                }

                const exactMatches: Array<{ functionUrn: string; endpointUrn: string }> = [];
                const llmTasks: TargetedMatchTask[] = [];
                const matchedFunctionUrns = new Set<string>();

                // ═══════════════════════════════════════════════
                // L1: LEXICAL EXACT MATCH (HTTP only)
                // ═══════════════════════════════════════════════
                for (const func of eligibleFunctions) {
                    const normalizedFuncName = func.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    const classBase = extractClassBaseName(func.name);

                    for (const ep of httpEndpoints) {
                        const normalizedEpPath = normalizePathParams(ep.path);
                        const normalizedEpName = ((ep.method ?? '') + normalizedEpPath).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        const normalizedOpId = ep.operationId ? ep.operationId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : null;

                        if (normalizedFuncName === normalizedEpName
                            || (normalizedOpId && normalizedFuncName === normalizedOpId)
                            || (normalizedOpId && classBase && classBase === normalizedOpId)) {
                            exactMatches.push({ functionUrn: func.urn, endpointUrn: ep.urn });
                            matchedFunctionUrns.add(func.urn);
                            break;
                        }
                    }
                }

                // ═════════════════════════════════════════════════════════════
                // L2: VECTOR SIMILARITY PRE-FILTER (Memgraph Native)
                // ═════════════════════════════════════════════════════════════
                // For remaining unmatched functions, call vector_search.search()
                // against the endpoint_embedding_idx in Memgraph (USearch HNSW).
                // This replaces the O(N×M) in-memory cosine loop with N DB calls,
                // each returning Top-K ANN results in O(log M) server-side.
                for (const func of eligibleFunctions) {
                    if (matchedFunctionUrns.has(func.urn)) continue; // Already matched by L1

                    if (!func.embedding) {
                        // No embedding → skip vector pre-filter
                        logger.debug(`[Matchmaker] Skipping ${func.name}: no embedding available`);
                        continue;
                    }

                    // Query Memgraph for Top-K semantically similar endpoints
                    const candidates = await vectorSearchEndpoints(
                        func.embedding,
                        TOP_K,
                        SIMILARITY_THRESHOLD,
                    );

                    if (candidates.length === 0) {
                        logger.debug(
                            `[Matchmaker] Skipping LLM match for "${func.name}" — ` +
                            `no endpoints above threshold ${SIMILARITY_THRESHOLD} in vector index`,
                        );
                        continue;
                    }

                    llmTasks.push({
                        function: { urn: func.urn, name: func.name, intent: func.intent },
                        candidates: candidates.map(c => ({
                            urn: c.urn,
                            path: c.path,
                            method: c.method,
                            summary: c.summary,
                        })),
                    });
                }

                // ═════════════════════════════════════════════════════════════
                // PERSIST L1 MATCHES
                // ═════════════════════════════════════════════════════════════
                for (const match of exactMatches) {
                    await linkFunctionImplementsEndpoint(match.functionUrn, match.endpointUrn, commitHash);
                    linksCreated++;
                }
                if (exactMatches.length > 0 && task) {
                    task.report(`  ↳ ${exactMatches.length} L1 Exact Matches (0 tokens)`);
                }

                // ═════════════════════════════════════════════════════════════
                // L3: TARGETED LLM MATCHMAKING (Batched)
                // ═════════════════════════════════════════════════════════════
                let llmMatches: Array<{ functionUrn: string; endpointUrn: string }> = [];

                if (llmTasks.length > 0) {
                    // Batch the targeted tasks into groups of LLM_BATCH_SIZE
                    const batches: TargetedMatchTask[][] = [];
                    for (let i = 0; i < llmTasks.length; i += LLM_BATCH_SIZE) {
                        batches.push(llmTasks.slice(i, i + LLM_BATCH_SIZE));
                    }

                    if (task) {
                        task.report(`  ↳ ${llmTasks.length} functions → ${batches.length} LLM batch(es) (Top-${TOP_K} candidates each)`);
                    }

                    llmMatches = await matchFunctionsToEndpoints(batches);

                    for (const match of llmMatches) {
                        await linkFunctionImplementsEndpoint(match.functionUrn, match.endpointUrn, commitHash);
                        linksCreated++;
                    }
                }

                // Persist the new state hash (using service URN as stable key)
                await updateServiceMatchmakingHash(service.id, currentHash);

                const totalMatches = exactMatches.length + llmMatches.length;
                if (totalMatches > 0) {
                    servicesMatched++;
                    if (task) task.report(`${service.name}: ${totalMatches} matches linked (${exactMatches.length} L1 + ${llmMatches.length} L3)`);
                }
            } catch (err) {
                const msg = `[Matchmaker] Error matching ${service.name}: ${(err as Error).message}`;
                logger.error(msg);
                errors.push(msg);
            }
        }
    } catch (err) {
        const msg = `[Matchmaker] Fatal error: ${(err as Error).message}`;
        logger.error(msg);
        errors.push(msg);
    }

    return { servicesMatched, linksCreated, errors };
}
