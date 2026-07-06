/**
 * Dashboard grounding vocabulary. The categorical enums, type shapes and
 * structural-family predicate are imported from `@coderadius/shared-types`
 * (the single source of truth shared with the backend) so this file can never
 * drift out of sync with the backend grounding model.
 *
 * UI-specific palette / label / letter tokens are defined below and stay here
 * because they are presentation logic that doesn't belong in the shared
 * vocabulary package.
 */

export {
    SOURCE_VALUES,
    QUALITY_VALUES,
    QUALITY_RANK,
    qualityAtLeast,
    isStructuralFamily,
} from '@coderadius/shared-types';
export type {
    Source,
    Quality,
    LlmCallEvidence,
    Evidence,
    GroundingFields,
} from '@coderadius/shared-types';

import type { Quality, Source } from '@coderadius/shared-types';

/**
 * Source label and accent colour for inline chips. Aligned with the Vercel /
 * Linear restrained palette (one accent per dimension, no gradients).
 *
 * `label` is the natural-language descriptor surfaced to operators: it
 * answers "how confident is this finding?", not "what bucket did the math
 * fall into?". Reserve the raw enum values for backend logs / Cypher filters.
 */
export const QUALITY_META: Record<Quality, { label: string; tagline: string; color: string }> = {
    exact: {
        label: 'Verified',
        tagline: 'Direct evidence in code or contract',
        color: 'var(--cr-green-700, #15803d)',
    },
    high: {
        label: 'Strong',
        tagline: 'Confirmed by multiple independent analyses',
        color: 'var(--cr-green-500, #22c55e)',
    },
    medium: {
        label: 'Probable',
        tagline: 'Single source, plausible',
        color: 'var(--cr-amber-500, #f59e0b)',
    },
    low: {
        label: 'Weak',
        tagline: 'Inferred from indirect evidence',
        color: 'var(--cr-orange-600, #ea580c)',
    },
    speculative: {
        label: 'Guess',
        tagline: 'No direct evidence, treat with skepticism',
        color: 'var(--cr-red-700, #b91c1c)',
    },
};

/**
 * Human-readable descriptors for the `source` enum. The raw values
 * (`ast`, `llm`, `composite`, …) are an implementation detail; operators
 * see the right-hand label and the longer detail in tooltips.
 */
export const SOURCE_META: Record<Source, { label: string; detail: string }> = {
    ast: {
        label: 'Static code analysis',
        detail: 'Parsed directly from source (decorator, function signature, AST walk)',
    },
    heuristic: {
        label: 'Naming heuristic',
        detail: 'Pattern matched on file or symbol name',
    },
    llm: {
        label: 'LLM inference',
        detail: 'Extracted by language model from code semantics',
    },
    composite: {
        label: 'Cross-verified',
        detail: 'Multiple independent analyses agree on this finding',
    },
    declared: {
        label: 'Declared in catalog',
        detail: 'Asserted by coderadius.yaml or service catalog',
    },
    infra: {
        label: 'Infrastructure match',
        detail: 'Confirmed by a live infrastructure snapshot',
    },
    runtime: {
        label: 'Runtime trace',
        detail: 'Observed in production traffic',
    },
};

// QUALITY_RANK + qualityAtLeast() are re-exported from @coderadius/shared-types
// at the top of this file. The dashboard's "Verified only" filter chip and
// the backend's Cypher filters branch on the same predicate.

/**
 * Classifier for the `lastSeenCommit` field on TopologyNode.
 *
 * The backend stores a plain `string | null`, but the value semantically
 * splits into three cases that the UI renders differently:
 *
 *   - A real git SHA (40-char or short) → display as monospace short SHA
 *     with the full SHA in a hover tooltip.
 *   - The `SYSTEM` sentinel → the node came from a catalog import
 *     (Backstage / topology-resolver / infra-resolver) so there's no
 *     source commit to point at. Display as plain text "Catalog import".
 *   - The `unknown` sentinel → ingestion ran but `git rev-parse HEAD`
 *     failed (no `.git`, network timeout). Display as plain text
 *     "Unresolved".
 *   - `null` / `undefined` → unset; the UI should omit the row entirely.
 *
 * Returning a tagged union (rather than two return values) lets the
 * caller `switch` on `kind` without re-running sentinel checks.
 */
export type LastSeenCommit =
    | { kind: 'sha';        full: string; short: string }
    | { kind: 'catalog' }
    | { kind: 'unresolved' }
    | { kind: 'none' };

const SHORT_SHA_LEN = 12;

export function classifyLastSeenCommit(value: string | null | undefined): LastSeenCommit {
    if (value === null || value === undefined) return { kind: 'none' };
    const trimmed = value.trim();
    if (trimmed === '') return { kind: 'none' };
    if (/^system$/i.test(trimmed)) return { kind: 'catalog' };
    if (/^unknown$/i.test(trimmed)) return { kind: 'unresolved' };
    return {
        kind: 'sha',
        full: trimmed,
        short: trimmed.length > SHORT_SHA_LEN ? trimmed.slice(0, SHORT_SHA_LEN) : trimmed,
    };
}
