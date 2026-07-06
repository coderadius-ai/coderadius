import crypto from 'node:crypto';
import { getCallerObservedUrlsForEmergent, getCandidatesByDeploymentHost, getCandidatesByDeploymentUrl, getCanonicalEndpoints, getEmergentEndpoints, getScopedCandidatesForEmergent, getSelfServiceCandidatesForEmergent, getUrlWeldSurfaceCounts, weldDuplicateEmergentEndpoints, weldEmergentToCanonical } from '../../graph/mutations/api-contracts.js';
import { getGlobalResolutionHash, updateGlobalResolutionHash } from '../../graph/mutations/search.js';
import { normalizeApiPath, stripCommonPrefixes, convertOpenAPIPathToRegex } from './api-path-utils.js';
import { isGraphQLPath, parseGraphQLPath } from '../../ai/workflows/sanitizer.js';
import { matchFunctionsToEndpoints } from '../../ai/agents/matchmaker.js';
import { logger } from '../../utils/logger.js';
import { traceCollector } from '../../telemetry/index.js';
import { urnPrefix } from '../../graph/urn.js';
import { parseBaseUrl, joinBaseUrlAndPath } from '../../utils/url-normalizer.js';
import type { ScanMode } from '../../graph/scan-mode.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Global Edge Resolver
//
// Post-ingestion step that resolves emergent API endpoints (discovered from
// code analysis, e.g. fetch(`/s2/hello`)) to canonical API endpoints (defined
// in OpenAPI specs, e.g. GET /s2/hello from s2's openapi.yaml).
//
// Architecture: 3-Level Funnel
//   Level 1 — Exact Match:    method + normalizedPath equality
//   Level 2 — Template Match: OpenAPI path templates converted to regex
//   Level 3 — LLM Fallback:   matchmaker agent (only with --depth contracts)
//
// After resolution, emergent nodes are "welded" into canonical nodes
// (destructive merge: rewire [:CALLS] edges, delete orphan).
// ═══════════════════════════════════════════════════════════════════════════════

export interface GlobalResolutionResult {
    emergentTotal: number;
    /** L0a: caller observed base URL exactly matches a provider :APIDeployment.canonicalUrl. */
    resolvedUrlExact: number;
    /** L0b: caller observed host matches a provider :APIDeployment.host (scheme/port differ). */
    resolvedUrlHost: number;
    resolvedScoped: number;
    resolvedSelf: number;
    resolvedExact: number;
    resolvedTemplate: number;
    resolvedLLM: number;
    /** Leftover emergent REST endpoints collapsed into a single survivor per (method, canonical path). */
    dedupedEmergent: number;
    unresolved: number;
    errors: string[];
}

interface EmergentEndpoint {
    id: string;
    method: string | null;
    path: string;
}

interface CanonicalEndpoint {
    id: string;
    method: string | null;
    path: string;
    apiTitle: string | null;
    apiKind?: string | null;
    operation?: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION' | null;
    operationName?: string | null;
}

/**
 * Pre-compute a lookup index of canonical endpoints grouped by HTTP method.
 * Each entry includes the original path, the normalized path, and a regex
 * compiled from the OpenAPI template for Level 2 matching.
 */
interface CanonicalIndex {
    id: string;
    rawPath: string;
    normalizedPath: string | null;
    regex: RegExp;
    apiTitle: string | null;
}

function buildCanonicalIndex(canonicals: CanonicalEndpoint[]): Map<string, CanonicalIndex[]> {
    const index = new Map<string, CanonicalIndex[]>();

    for (const c of canonicals) {
        // GraphQL SDL/code endpoints are NOT part of the HTTP index.
        // They are matched via findUniqueGQLMatch before this index is consulted.
        // Identify GraphQL by apiKind (preferred) or by legacy path-shape (back-compat).
        if (!c.method || c.apiKind === 'graphql' || isGraphQLPath(c.path)) continue;

        const method = c.method.toUpperCase();
        const normalized = normalizeApiPath(c.path);
        const regex = convertOpenAPIPathToRegex(c.path);

        const entry: CanonicalIndex = {
            id: c.id,
            rawPath: c.path,
            normalizedPath: normalized,
            regex,
            apiTitle: c.apiTitle,
        };

        const existing = index.get(method) ?? [];
        existing.push(entry);
        index.set(method, existing);
    }

    return index;
}

// ─── GraphQL Resolver Helpers ───────────────────────────────────────────

/**
 * Find a unique SDL match for a GraphQL emergent endpoint.
 * Returns the SDL candidate if exactly ONE match exists by operation+operationName,
 * null if 0 or >1 (ambiguous — no weld to prevent false positives).
 */
function findUniqueGQLMatch(
    emergent: EmergentEndpoint,
    candidates: CanonicalEndpoint[],
): CanonicalEndpoint | null {
    const parsed = parseGraphQLPath(emergent.path);
    if (!parsed) return null;

    // Filter: same operation type + same root field name.
    // Only consider live SDL nodes (graphql: prefix) — not code-inferred or other emergent.
    // Match on c.operation/c.operationName when present (current schema); fall back to
    // parsing c.path for legacy nodes that pre-date the apiKind/operation refactor.
    const sdlPrefix = urnPrefix('endpoint', 'graphql');
    const matches = candidates.filter(c => {
        if (!c.id.startsWith(sdlPrefix)) return false;
        if (c.operation && c.operationName) {
            return c.operation === parsed.operation && c.operationName === parsed.operationName;
        }
        const cp = parseGraphQLPath(c.path);
        return cp && cp.operation === parsed.operation && cp.operationName === parsed.operationName;
    });

    return matches.length === 1 ? matches[0] : null;
}

/**
 * Segment-boundary suffix match.
 * Ensures /api/recharge does NOT match /charge (no '/' boundary),
 * but /api/v1/charge DOES match /charge ('/' boundary at position).
 *
 * Since normalized paths always start with '/', the suffix's own leading '/'
 * acts as the segment boundary delimiter.
 */
function isSuffixMatch(fullPath: string, suffix: string): boolean {
    if (fullPath === suffix) return true;
    if (!fullPath.endsWith(suffix)) return false;
    // The character just before the suffix in fullPath must be '/' OR
    // the suffix itself starts with '/' (segment boundary is built-in).
    const charBefore = fullPath[fullPath.length - suffix.length - 1];
    return suffix.startsWith('/') || charBefore === '/';
}

// ─── Level 0a / 0b: URL-match Welder ─────────────────────────────────────────

interface UrlMatchCandidate {
    id: string;
    method: string | null;
    path: string;
    apiTitle: string | null;
    deploymentEnvironment: string | null;
    deploymentVisibility: string | null;
    deploymentBasePath?: string | null;
}

/**
 * Pick the canonical endpoint whose declared deployment URL matches the
 * caller's observed URL `joinBaseUrlAndPath(observedBaseUrl, emergentPath)`.
 *
 * Match rule:
 *   - Compose `caller = joinBaseUrlAndPath(observedBaseUrl, emergentPath)`.
 *   - For each candidate compose `provider = joinBaseUrlAndPath(canonicalUrl, candidate.path)`.
 *   - Compare normalized (case-insensitive host already enforced by canonicalizeBaseUrl).
 *
 * Environment is a tiebreaker, not a hard filter — providers occasionally
 * mark `environment='unknown'` for catalog links.
 *
 * Returns the unique match, or `null` if 0 or >1 candidates match. The caller
 * falls through to L0b (host) or downstream tiers when this returns null.
 */
function findUniqueUrlMatch(
    emergent: EmergentEndpoint,
    observedBaseUrl: string,
    observedEnvironment: string | null,
    candidates: UrlMatchCandidate[],
    canonicalBaseUrl: string,
): UrlMatchCandidate | null {
    const callerFull = joinBaseUrlAndPath(observedBaseUrl, emergent.path).toLowerCase();
    const matches = candidates.filter(c => {
        const providerFull = joinBaseUrlAndPath(canonicalBaseUrl, c.path).toLowerCase();
        return providerFull === callerFull;
    });
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    // Multi-surface tiebreaker: prefer the deployment whose environment
    // matches the caller's observedEnvironment.
    if (observedEnvironment) {
        const envMatches = matches.filter(c =>
            c.deploymentEnvironment && c.deploymentEnvironment === observedEnvironment
        );
        if (envMatches.length === 1) return envMatches[0];
    }
    // Genuinely ambiguous — defer to downstream tiers.
    return null;
}

// ─── Level 1: Exact Match + Suffix Match ─────────────────────────────────────

function exactMatch(emergent: EmergentEndpoint, candidates: CanonicalIndex[]): CanonicalIndex | null {
    const emergentNormalized = normalizeApiPath(emergent.path);
    if (!emergentNormalized) return null;

    // Pass 1: exact match (highest confidence)
    for (const c of candidates) {
        if (c.normalizedPath && c.normalizedPath === emergentNormalized) {
            return c;
        }
    }

    // Pass 2: suffix match — e.g. emergent /api/v1/charge matches canonical /charge
    // This handles API Gateway path rewriting where the caller uses the full
    // gateway path but the OpenAPI spec declares the service-local path.
    // NOTE: Only forward direction (emergent ends with canonical). The reverse
    // case is handled by L2 regex or L3 LLM to avoid false positives.
    const suffixMatches = candidates.filter(c =>
        c.normalizedPath && isSuffixMatch(emergentNormalized, c.normalizedPath)
    );
    if (suffixMatches.length === 1) return suffixMatches[0];
    // Multiple suffix matches = genuinely ambiguous. Don't guess —
    // fall through to L2 (regex) or L3 (LLM) which have more context.

    return null;
}

// ─── Level 2: Template Regex Match ───────────────────────────────────────────

function templateMatch(emergent: EmergentEndpoint, candidates: CanonicalIndex[]): CanonicalIndex | null {
    const path = emergent.path;
    // Also try with common prefixes stripped — handles cases where the emergent
    // path includes /api/v1/ but the canonical regex only covers the service-local path.
    const strippedPath = stripCommonPrefixes(path);

    // Find all candidates whose regex matches the emergent path (raw or stripped)
    const matches = candidates.filter(c =>
        c.regex.test(path) || c.regex.test(strippedPath)
    );

    if (matches.length === 1) {
        return matches[0];
    }

    // If multiple matches, prefer the most specific one (fewest parameters)
    if (matches.length > 1) {
        const sorted = matches.sort((a, b) => {
            // Count param segments — fewer params = more specific
            const aParams = (a.rawPath.match(/\{[^}]+\}/g) || []).length;
            const bParams = (b.rawPath.match(/\{[^}]+\}/g) || []).length;
            return aParams - bParams;
        });
        return sorted[0];
    }

    return null;
}

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * Run the Global Edge Resolution pipeline.
 *
 * @param task  Progress reporter (optional)
 * @param scanMode  Whether to enable Level 3 (LLM fallback)
 */
export async function ingestGlobalResolution(
    task?: any,
    scanMode: ScanMode = 'semantic',
): Promise<GlobalResolutionResult> {
    const result: GlobalResolutionResult = {
        emergentTotal: 0,
        resolvedUrlExact: 0,
        resolvedUrlHost: 0,
        resolvedScoped: 0,
        resolvedSelf: 0,
        resolvedExact: 0,
        resolvedTemplate: 0,
        resolvedLLM: 0,
        dedupedEmergent: 0,
        unresolved: 0,
        errors: [],
    };

    try {
        // ── Phase 1: Fetch all endpoints from the graph ─────────────────
        const [emergents, canonicals] = await Promise.all([
            getEmergentEndpoints(),
            getCanonicalEndpoints(),
        ]);

        result.emergentTotal = emergents.length;

        traceCollector.traceResolution('INFO', 'global-resolver', 'phase 1: fetched endpoints', {
            emergentTotal: emergents.length,
            canonicalTotal: canonicals.length,
            scanMode,
        });

        if (emergents.length === 0) {
            if (task) task.report('No emergent endpoints to resolve');
            return result;
        }

        if (canonicals.length === 0) {
            if (task) task.report('No canonical endpoints available — skipping resolution');
            result.unresolved = emergents.length;
            return result;
        }

        if (task) task.report(`Resolving ${emergents.length} emergent endpoints against ${canonicals.length} canonical endpoints`);

        // ── Phase 1b: Global cache check ─────────────────────────────────
        // Deterministic sort for stable hashing
        emergents.sort((a, b) => a.id.localeCompare(b.id));
        canonicals.sort((a, b) => a.id.localeCompare(b.id));

        // Mix in the URL-welding surface so the cache picks up new
        // :APIDeployment nodes and caller-side observedBaseUrl edges even
        // when the endpoint set itself is unchanged.
        const urlWeldCounts = await getUrlWeldSurfaceCounts();
        const stateString = JSON.stringify({ emergents, canonicals, urlWeldCounts });
        const currentHash = crypto.createHash('sha256').update(stateString).digest('hex');
        const previousHash = await getGlobalResolutionHash();

        if (currentHash === previousHash) {
            if (task) task.report(`No new endpoints to resolve (inputs unchanged, skipping).`);
            result.unresolved = emergents.length;
            return result;
        }

        // ── Phase 2: Build canonical index ──────────────────────────────
        const canonicalIndex = buildCanonicalIndex(canonicals);

        // Track unresolved emergents for potential LLM pass
        const unresolvedEmergents: EmergentEndpoint[] = [];

        // ── Phase 2a: Level 0 (scoped) + Level 1 + Level 2 resolution ──
        for (const emergent of emergents) {
            // ─── GraphQL branch: L0/L0b funnel only, never L1/L2/L3 ───────────────
            // GraphQL operations are matched on operation+operationName semantics,
            // not on HTTP method+path. They MUST NOT enter the HTTP index.
            if (isGraphQLPath(emergent.path)) {
                let resolved = false;

                // L0: dependency-scoped GQL candidates
                try {
                    const scopedCandidates = await getScopedCandidatesForEmergent(emergent.id);
                    if (scopedCandidates.length > 0) {
                        const match = findUniqueGQLMatch(emergent, scopedCandidates);
                        if (match) {
                            await weldEmergentToCanonical(emergent.id, match.id, {
                                weldedBy: 'scoped',
                                weldConfidence: 'medium',
                            });
                            result.resolvedScoped++;
                            logger.debug(`[GlobalResolver] L0-GQL Scoped: ${emergent.path} → ${match.path} (${match.apiTitle})`);
                            resolved = true;
                        }
                    }
                } catch (err) {
                    logger.debug(`[GlobalResolver] L0-GQL Scoped failed for ${emergent.id}: ${(err as Error).message}`);
                }

                // L0b: self-service GQL candidates
                if (!resolved) {
                    try {
                        const selfCandidates = await getSelfServiceCandidatesForEmergent(emergent.id);
                        if (selfCandidates.length > 0) {
                            const match = findUniqueGQLMatch(emergent, selfCandidates);
                            if (match) {
                                await weldEmergentToCanonical(emergent.id, match.id, {
                                    weldedBy: 'scoped',
                                    weldConfidence: 'medium',
                                });
                                result.resolvedSelf++;
                                logger.debug(`[GlobalResolver] L0b-GQL Self: ${emergent.path} → ${match.path} (${match.apiTitle})`);
                                resolved = true;
                            }
                        }
                    } catch (err) {
                        logger.debug(`[GlobalResolver] L0b-GQL Self failed for ${emergent.id}: ${(err as Error).message}`);
                    }
                }

                if (!resolved) {
                    unresolvedEmergents.push(emergent);
                }
                continue; // GQL never reaches L1/L2/L3
            }

            // ─── HTTP branch (existing logic) ─────────────────────────────────────
            const method = (emergent.method ?? '').toUpperCase();

            // Level 0a: URL-exact match
            // Caller logged its observed base URL on the :CALLS edge
            // (graph-writer pulls it from the resolved env-var). Match the
            // composed full URL against any provider :APIDeployment.canonicalUrl
            // — no DEPENDS_ON traversal required.
            let urlWelded = false;
            try {
                const observed = await getCallerObservedUrlsForEmergent(emergent.id);
                for (const obs of observed) {
                    const canonicalBaseUrl = parseBaseUrl(obs.observedBaseUrl)
                        ? joinBaseUrlAndPath(obs.observedBaseUrl, '').replace(/\/+$/, '')
                        : obs.observedBaseUrl.toLowerCase();
                    const candidates = await getCandidatesByDeploymentUrl(canonicalBaseUrl, method);
                    const match = findUniqueUrlMatch(
                        emergent,
                        obs.observedBaseUrl,
                        obs.observedEnvironment,
                        candidates as UrlMatchCandidate[],
                        canonicalBaseUrl,
                    );
                    if (match) {
                        await weldEmergentToCanonical(emergent.id, match.id, {
                            weldedBy: 'url-exact',
                            weldConfidence: 'exact',
                        });
                        result.resolvedUrlExact++;
                        logger.debug(`[GlobalResolver] L0a URL-exact: ${obs.observedBaseUrl}${emergent.path} → ${match.path} (${match.apiTitle})`);
                        urlWelded = true;
                        break;
                    }
                }
            } catch (err) {
                logger.debug(`[GlobalResolver] L0a URL-exact failed for ${emergent.id}: ${(err as Error).message}`);
            }
            if (urlWelded) continue;

            // Level 0b: URL-host match
            // Caller and provider disagree on scheme/port (e.g. internal mesh
            // vs public ingress). Match by host alone; require the candidate's
            // basePath + canonical path to align with the caller's emergent path.
            try {
                const observed = await getCallerObservedUrlsForEmergent(emergent.id);
                for (const obs of observed) {
                    const parsed = parseBaseUrl(obs.observedBaseUrl);
                    if (!parsed) continue;
                    const candidates = await getCandidatesByDeploymentHost(parsed.host, method);
                    // Build a candidate-side index by comparing path-only join.
                    const hostMatches = candidates.filter(c => {
                        const providerComposed = (c.deploymentBasePath ?? '') + (c.path.startsWith('/') ? c.path : '/' + c.path);
                        const callerComposed = (parsed.basePath ?? '') + (emergent.path.startsWith('/') ? emergent.path : '/' + emergent.path);
                        return providerComposed.toLowerCase() === callerComposed.toLowerCase();
                    });
                    if (hostMatches.length === 1) {
                        const match = hostMatches[0];
                        await weldEmergentToCanonical(emergent.id, match.id, {
                            weldedBy: 'url-host',
                            weldConfidence: 'high',
                        });
                        result.resolvedUrlHost++;
                        logger.debug(`[GlobalResolver] L0b URL-host: ${obs.observedBaseUrl}${emergent.path} → ${match.path} (${match.apiTitle})`);
                        urlWelded = true;
                        break;
                    } else if (hostMatches.length > 1 && obs.observedEnvironment) {
                        const envFiltered = hostMatches.filter(c =>
                            c.deploymentEnvironment === obs.observedEnvironment
                        );
                        if (envFiltered.length === 1) {
                            const match = envFiltered[0];
                            await weldEmergentToCanonical(emergent.id, match.id, {
                                weldedBy: 'url-host',
                                weldConfidence: 'high',
                            });
                            result.resolvedUrlHost++;
                            logger.debug(`[GlobalResolver] L0b URL-host (env tiebreaker): ${obs.observedBaseUrl}${emergent.path} → ${match.path} (${match.apiTitle})`);
                            urlWelded = true;
                            break;
                        }
                    }
                }
            } catch (err) {
                logger.debug(`[GlobalResolver] L0b URL-host failed for ${emergent.id}: ${(err as Error).message}`);
            }
            if (urlWelded) continue;

            // Level 0: Dependency-scoped matching
            // Query the graph for canonical endpoints reachable via the
            // calling service's [:DEPENDS_ON] chain. If the dependency graph
            // connects this function's service to a target service that
            // exposes a matching endpoint, resolve it without full-set search.
            try {
                const scopedCandidates = await getScopedCandidatesForEmergent(emergent.id);
                if (scopedCandidates.length > 0) {
                    const scopedIndex = buildCanonicalIndex(
                        scopedCandidates.filter(c => (c.method ?? '').toUpperCase() === method),
                    );
                    const scopedByMethod = scopedIndex.get(method) ?? [];

                    if (scopedByMethod.length > 0) {
                        const exact = exactMatch(emergent, scopedByMethod);
                        if (exact) {
                            await weldEmergentToCanonical(emergent.id, exact.id, {
                                weldedBy: 'scoped',
                                weldConfidence: 'medium',
                            });
                            result.resolvedScoped++;
                            logger.debug(`[GlobalResolver] L0 Scoped: ${emergent.path} → ${exact.rawPath} (${exact.apiTitle})`);
                            continue;
                        }
                        const template = templateMatch(emergent, scopedByMethod);
                        if (template) {
                            await weldEmergentToCanonical(emergent.id, template.id, {
                                weldedBy: 'scoped',
                                weldConfidence: 'medium',
                            });
                            result.resolvedScoped++;
                            logger.debug(`[GlobalResolver] L0 Scoped: ${emergent.path} → ${template.rawPath} (${template.apiTitle})`);
                            continue;
                        }
                    }
                }
            } catch (err) {
                logger.debug(`[GlobalResolver] L0 Scoped query failed for ${emergent.id}: ${(err as Error).message}`);
                // Fall through to L0b/L1/L2
            }

            // Level 0b: Self-service resolution
            // When L0 scoped fails (no DEPENDS_ON edges), check if this emergent
            // endpoint matches a canonical endpoint exposed by the SAME service.
            // This handles internal API calls in single-service or monolithic mode.
            try {
                const selfCandidates = await getSelfServiceCandidatesForEmergent(emergent.id);
                if (selfCandidates.length > 0) {
                    const selfIndex = buildCanonicalIndex(
                        selfCandidates.filter(c => (c.method ?? '').toUpperCase() === method),
                    );
                    const selfByMethod = selfIndex.get(method) ?? [];

                    if (selfByMethod.length > 0) {
                        const exact = exactMatch(emergent, selfByMethod);
                        if (exact) {
                            await weldEmergentToCanonical(emergent.id, exact.id, {
                                weldedBy: 'scoped',
                                weldConfidence: 'medium',
                            });
                            result.resolvedSelf++;
                            logger.debug(`[GlobalResolver] L0b Self: ${emergent.path} → ${exact.rawPath} (${exact.apiTitle})`);
                            continue;
                        }
                        const template = templateMatch(emergent, selfByMethod);
                        if (template) {
                            await weldEmergentToCanonical(emergent.id, template.id, {
                                weldedBy: 'scoped',
                                weldConfidence: 'medium',
                            });
                            result.resolvedSelf++;
                            logger.debug(`[GlobalResolver] L0b Self: ${emergent.path} → ${template.rawPath} (${template.apiTitle})`);
                            continue;
                        }
                    }
                }
            } catch (err) {
                logger.debug(`[GlobalResolver] L0b Self query failed for ${emergent.id}: ${(err as Error).message}`);
            }

            // Level 1 + Level 2: Full candidate set
            const candidates = canonicalIndex.get(method) ?? [];

            if (candidates.length === 0) {
                unresolvedEmergents.push(emergent);
                continue;
            }

            // Level 1: Exact match
            const exact = exactMatch(emergent, candidates);
            if (exact) {
                try {
                    await weldEmergentToCanonical(emergent.id, exact.id, {
                        weldedBy: 'label',
                        weldConfidence: 'medium',
                    });
                    result.resolvedExact++;
                    logger.debug(`[GlobalResolver] L1 Exact: ${emergent.path} → ${exact.rawPath} (${exact.apiTitle})`);
                    continue;
                } catch (err) {
                    const msg = `[GlobalResolver] Weld failed for ${emergent.id}: ${(err as Error).message}`;
                    logger.error(msg);
                    result.errors.push(msg);
                    continue;
                }
            }

            // Level 2: Template regex match
            const template = templateMatch(emergent, candidates);
            if (template) {
                try {
                    await weldEmergentToCanonical(emergent.id, template.id, {
                        weldedBy: 'template',
                        weldConfidence: 'low',
                    });
                    result.resolvedTemplate++;
                    logger.debug(`[GlobalResolver] L2 Template: ${emergent.path} → ${template.rawPath} (${template.apiTitle})`);
                    continue;
                } catch (err) {
                    const msg = `[GlobalResolver] Weld failed for ${emergent.id}: ${(err as Error).message}`;
                    logger.error(msg);
                    result.errors.push(msg);
                    continue;
                }
            }

            // Not resolved at L0, L1, or L2
            unresolvedEmergents.push(emergent);
        }

        // ── Phase 2b: Level 3 — LLM Fallback (deep mode only) ──────────
        if (scanMode === 'contracts' && unresolvedEmergents.length > 0) {
            if (task) task.report(`Level 3: ${unresolvedEmergents.length} unresolved endpoints → LLM fallback`);

            try {
                // Prepare targeted match tasks: each emergent endpoint treated as a "function"
                // looking for its canonical counterpart among all canonical endpoints
                const LLM_BATCH_SIZE = 20;
                const tasks = unresolvedEmergents.map(e => ({
                    function: {
                        urn: e.id,
                        name: `${e.method} ${e.path}`,
                        intent: `HTTP client call to ${e.method} ${e.path}`,
                    },
                    candidates: canonicals.map(c => ({
                        urn: c.id,
                        path: c.path,
                        method: c.method,
                        summary: c.apiTitle,
                    })),
                }));

                // Batch the tasks
                const batches = [];
                for (let i = 0; i < tasks.length; i += LLM_BATCH_SIZE) {
                    batches.push(tasks.slice(i, i + LLM_BATCH_SIZE));
                }

                const matches = await matchFunctionsToEndpoints(batches, 'global_resolution');

                for (const match of matches) {
                    try {
                        await weldEmergentToCanonical(match.functionUrn, match.endpointUrn, {
                            weldedBy: 'llm',
                            weldConfidence: 'low',
                        });
                        result.resolvedLLM++;
                        logger.debug(`[GlobalResolver] L3 LLM: ${match.functionUrn} → ${match.endpointUrn}`);
                    } catch (err) {
                        const msg = `[GlobalResolver] LLM weld failed: ${(err as Error).message}`;
                        logger.error(msg);
                        result.errors.push(msg);
                    }
                }
            } catch (err) {
                const msg = `[GlobalResolver] LLM fallback failed: ${(err as Error).message}`;
                logger.error(msg);
                result.errors.push(msg);
            }
        }

        // Collapse leftover emergent REST duplicates (same method + canonical
        // path, no OpenAPI/SDL counterpart) into one survivor each. Runs after
        // all emergent→canonical welds so it only touches the residue.
        try {
            result.dedupedEmergent = await weldDuplicateEmergentEndpoints('SYSTEM');
            if (result.dedupedEmergent > 0) {
                logger.info(`[GlobalResolver] collapsed ${result.dedupedEmergent} duplicate emergent REST endpoint(s)`);
            }
        } catch (err) {
            const msg = `[GlobalResolver] emergent dedup failed: ${(err as Error).message}`;
            logger.error(msg);
            result.errors.push(msg);
        }

        // Persist the new global state hash since we completed a pass
        await updateGlobalResolutionHash(currentHash);

        // ── Final accounting ────────────────────────────────────────────
        result.unresolved = result.emergentTotal
            - result.resolvedUrlExact
            - result.resolvedUrlHost
            - result.resolvedScoped
            - result.resolvedSelf
            - result.resolvedExact
            - result.resolvedTemplate
            - result.resolvedLLM;

        if (task) {
            const parts: string[] = [];
            if (result.resolvedUrlExact > 0) parts.push(`${result.resolvedUrlExact} url-exact`);
            if (result.resolvedUrlHost > 0) parts.push(`${result.resolvedUrlHost} url-host`);
            if (result.resolvedScoped > 0) parts.push(`${result.resolvedScoped} scoped`);
            if (result.resolvedSelf > 0) parts.push(`${result.resolvedSelf} self`);
            if (result.resolvedExact > 0) parts.push(`${result.resolvedExact} exact`);
            if (result.resolvedTemplate > 0) parts.push(`${result.resolvedTemplate} template`);
            if (result.resolvedLLM > 0) parts.push(`${result.resolvedLLM} LLM`);
            if (result.dedupedEmergent > 0) parts.push(`${result.dedupedEmergent} deduped`);
            if (result.unresolved > 0) parts.push(`${result.unresolved} unresolved`);
            task.report(`Resolution complete: ${parts.join(', ')}`);
        }
    } catch (err) {
        const msg = `[GlobalResolver] Fatal error: ${(err as Error).message}`;
        logger.error(msg);
        result.errors.push(msg);
    }

    return result;
}
