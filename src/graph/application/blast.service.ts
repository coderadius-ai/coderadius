/**
 * Blast Analysis — Application Service
 *
 * Orchestrates resource resolution, disambiguation, and blast-radius analysis.
 * UI-agnostic: the caller supplies a disambiguation strategy via callback.
 */

import { resolveResource, analyzeBlast } from '../queries/blast.js';
import type { ResolvedResource, BlastAnalysisResult } from '../types.js';

// ─── Public DTOs ─────────────────────────────────────────────────────────────

export interface ResolveResult<T> {
    status: 'found' | 'not_found' | 'ambiguous';
    matches: T[];
}

/**
 * Disambiguation callback.
 * Receives a list of candidate matches and returns either
 * the selected URN or `null` to cancel.
 */
export type DisambiguateFn<T> = (matches: T[]) => Promise<string | null>;

// ─── Application Service ─────────────────────────────────────────────────────

/**
 * Full orchestration pipeline:
 *   1. Resolve the resource name/URN
 *   2. If ambiguous, delegate to the caller's disambiguation strategy
 *   3. Execute blast-radius analysis
 *
 * @throws {ResourceNotFoundError} if no matches are found
 * @throws {DisambiguationCancelledError} if the user cancels disambiguation
 */
export async function resolveAndAnalyzeBlast(
    resourceNameOrUrn: string,
    disambiguate?: DisambiguateFn<ResolvedResource>,
): Promise<BlastAnalysisResult> {
    const matches = await resolveResource(resourceNameOrUrn);

    if (matches.length === 0) {
        throw new ResourceNotFoundError(resourceNameOrUrn);
    }

    let selectedUrn: string;

    if (matches.length === 1) {
        selectedUrn = matches[0].urn;
    } else if (disambiguate) {
        const chosen = await disambiguate(matches);
        if (!chosen) {
            throw new DisambiguationCancelledError();
        }
        selectedUrn = chosen;
    } else {
        // No disambiguation strategy — take first match (MCP/headless behavior)
        selectedUrn = matches[0].urn;
    }

    return analyzeBlast(selectedUrn);
}

// ─── Error Classes ───────────────────────────────────────────────────────────

export class ResourceNotFoundError extends Error {
    constructor(public readonly resource: string) {
        super(`Resource '${resource}' not found in the architectural graph.`);
        this.name = 'ResourceNotFoundError';
    }
}

export class DisambiguationCancelledError extends Error {
    constructor() {
        super('Operation cancelled.');
        this.name = 'DisambiguationCancelledError';
    }
}
