/**
 * Blast Tier Classification (UI adapter)
 * ──────────────────────────────────────
 * The classification logic (thresholds, evidence-gated demotion, gauge
 * mapping) lives in @coderadius/shared-types/topology-rels.ts, shared with
 * the server-side gravity engine so the tiers the UI renders are byte-equal
 * to what the engine calibrates against. This module adds UI-only meta:
 * labels, business descriptions and palette tokens (grounding QUALITY_META
 * pattern).
 *
 * Tiers:
 *   T0 Seismic    ≥100  org-wide cascade, outage-likely
 *   T1 Critical   ≥50   multi-team incident probable
 *   T2 High       ≥15   single-team impact
 *   T3 Standard   ≥6    isolated
 *   T4 Contained  <6    isolated, low coordination overhead
 *   T? Unverified       evidence-gated demotion: the score has NO observed
 *                       dependent (no in-edge dependent, no transitive node,
 *                       no consumed endpoint). It reflects the node's own
 *                       write/publish footprint; real blast may be higher
 *                       (unscanned repos) or lower (write-only targets).
 */

import {
    TIER_GRADES,
    classifyGravityTier,
    normaliseToBar,
} from '@coderadius/shared-types';
import type { BlastTierKey, GravityEvidence } from '@coderadius/shared-types';

export type TierKey = BlastTierKey;
export { normaliseToBar };
export type { GravityEvidence };

export interface BlastTier {
    /** Short CSS-safe key */
    key: TierKey;
    /** Single-letter grade for compact display */
    grade: string;
    /** Human label */
    label: string;
    /** One-line business meaning */
    description: string;
    /** CSS custom property name for the tier color */
    colorVar: string;
}

const TIER_META: Record<TierKey, Omit<BlastTier, 'key' | 'grade'>> = {
    seismic: {
        label: 'Seismic',
        description: 'Org-wide cascade, outage likely',
        colorVar: '--tier-seismic',
    },
    critical: {
        label: 'Critical',
        description: 'Multi-team incident probable',
        colorVar: '--tier-critical',
    },
    high: {
        label: 'High',
        description: 'Single-team impact',
        colorVar: '--tier-high',
    },
    moderate: {
        label: 'Standard',
        description: 'Isolated',
        colorVar: '--tier-moderate',
    },
    contained: {
        label: 'Contained',
        description: 'Isolated, low coordination overhead',
        colorVar: '--tier-contained',
    },
    unverified: {
        label: 'Unverified',
        description: 'No observed dependents in the scanned graph; score reflects this node\'s own write/publish footprint',
        colorVar: '--tier-unverified',
    },
};

function toBlastTier(key: TierKey): BlastTier {
    return { key, grade: TIER_GRADES[key], ...TIER_META[key] };
}

/**
 * Numeric tier from a raw score alone. For consumers without gravity
 * evidence (SPOF leaderboard summaries, legacy payloads): never demotes.
 */
export function getBlastTier(rawScore: number): BlastTier {
    return toBlastTier(classifyGravityTier(rawScore));
}

/**
 * Evidence-aware tier: the single demotion chokepoint. Every chip rendering
 * a gravity score should call this; a score whose evidence has no observed
 * dependent renders as "T? Unverified" instead of a numeric tier.
 */
export function gravityTier(rawScore: number, evidence?: GravityEvidence | null): BlastTier {
    return toBlastTier(classifyGravityTier(rawScore, evidence));
}
