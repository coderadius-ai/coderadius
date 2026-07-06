// ═══════════════════════════════════════════════════════════════════════════════
// Sink Classifier — Output Schema & Types
//
// Schema versioning: bump SINK_CLASSIFIER_SCHEMA_VERSION when the prompt or
// output shape changes meaningfully. The version is part of the cache key, so
// a bump invalidates the entire cross-repo cache automatically.
// ═══════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';

export const SINK_CLASSIFIER_SCHEMA_VERSION = 'v1.0.0-sink-classifier';

/**
 * Closed list of canonical sink categories.
 *
 * `Other` is an extensibility escape hatch: the LLM can return it when a
 * package is clearly an I/O sink but doesn't fit the existing taxonomy
 * (e.g. ML inference, payment SDK, auth provider). Telemetry tracks
 * `otherLabel` distinct counts so we know when to promote to a real category.
 *
 * `NotASink` is an explicit "not infrastructure" answer (e.g. lodash,
 * date-fns, validation libraries). Stored in the cache so the same package
 * is never re-classified.
 */
export const SinkType = z.enum([
    'Database',
    'MessageChannel',
    'Cache',
    'ObjectStorage',
    'ExternalAPI',
    'Process',
    'Observability',
    'NotASink',
    'Other',
]);

export type SinkType = z.infer<typeof SinkType>;

/**
 * Single classified package returned by the LLM.
 *
 * `evidence` MUST contain concrete signals (package keyword, README heading,
 * description excerpt) rather than free-form reasoning. Empty evidence + low
 * confidence is an automatic rejection signal — pushes the LLM to cite
 * verifiable facts instead of inventing scores.
 */
export const ClassifiedPackageSchema = z.object({
    name: z.string()
        .min(1)
        .describe('Package name. MUST appear verbatim in the input list.'),
    sinkType: SinkType,
    confidence: z.number()
        .min(0)
        .max(1)
        .describe('Calibrated confidence in [0,1].'),
    evidence: z.array(z.string())
        .max(5)
        .default([])
        .describe(
            'Up to 5 concrete signals supporting the classification: '
            + 'package keyword, README heading, npmjs description excerpt. '
            + 'Empty array if guessing — will be rejected unless confidence ≥ 0.95.'
        ),
    otherLabel: z.string()
        .optional()
        .describe('Free-text label, populated only when sinkType === "Other" (e.g. "ml-inference", "payment-sdk").'),
});

export type ClassifiedPackage = z.infer<typeof ClassifiedPackageSchema>;

export const SinkClassifierOutputSchema = z.object({
    classifications: z.array(ClassifiedPackageSchema),
});

export type SinkClassifierOutput = z.infer<typeof SinkClassifierOutputSchema>;

/**
 * Input record passed to the classifier. `lockedVersion` is informational —
 * NOT part of the cache key (would cause spurious re-classifications on
 * patch/minor bumps). The major version is tracked in CacheEntry.seenVersions
 * to detect when re-classification is warranted.
 */
export interface ClassifierInput {
    /** Package name (e.g. 'axios', 'pg', '@aws-sdk/client-s3'). */
    name: string;
    /** Ecosystem identifier ('npm' | 'composer' | 'pypi' | 'go'). */
    ecosystem: string;
    /** Version from the lockfile, if available. Informational only. */
    lockedVersion?: string;
}

/**
 * Internal context for anti-hallucination validation.
 */
export interface ValidationContext {
    inputSet: Set<string>;
    confidenceThreshold: number;
    hardcodedSinks: Set<string>;
    hardcodedIgnores: Set<string>;
    /** Mutable: validation appends drift events here. */
    driftLog: Array<{ name: string; kind: string; detail?: string }>;
}
