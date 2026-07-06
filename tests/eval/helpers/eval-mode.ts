// ═══════════════════════════════════════════════════════════════════════════════
// Eval Mode — Hard Assertion Helpers
//
// All eval assertions are unconditionally hard.  With the LLM replay cache
// ensuring deterministic outputs in CI, there is no justification for
// "advisory-only" soft checks.  Every extraction claim either holds or fails.
//
// Usage:
//   These helpers provide semantic wrappers around expect() for readability
//   in eval test code.  They ALWAYS hard-fail on violation.
// ═══════════════════════════════════════════════════════════════════════════════

import { expect } from 'vitest';

/**
 * Hard assertion: always enforced.  Throws on failure via expect().
 *
 * Use for any LLM-dependent extraction check.  With replay cache in place,
 * determinism is guaranteed — there is no reason to silently swallow failures.
 *
 * @param condition - The boolean condition to check
 * @param label     - A human-readable label for the assertion (printed on failure)
 *
 * @example
 *   hardCheck(fns.includes('notifyPaymentService'), 'notifyPaymentService extracted');
 */
export function hardCheck(condition: boolean, label: string): void {
    expect(condition, `[EVAL] ${label}`).toBe(true);
}

/**
 * Hard contains: checks that `haystack` includes `needle`.
 *
 * @example
 *   hardContains(fns, 'notifyPaymentService', 'notifyPaymentService in OrderController functions');
 */
export function hardContains<T>(haystack: T[], needle: T, label: string): void {
    hardCheck(haystack.includes(needle), label);
}

/**
 * Hard threshold: checks that `value >= threshold`.
 *
 * @example
 *   hardThreshold(score.recall, 0.95, 'Service recall ≥ 95%');
 */
export function hardThreshold(value: number, threshold: number, label: string): void {
    hardCheck(
        value >= threshold,
        `${label} — got ${(value * 100).toFixed(1)}%, need ${(threshold * 100).toFixed(1)}%`,
    );
}

// ─── Legacy Aliases (temporary — will be removed after all call sites migrate) ─

/** @deprecated Use hardCheck instead */
export const softCheck = hardCheck;
/** @deprecated Use hardContains instead */
export const softContains = hardContains;
/** @deprecated Use hardThreshold instead */
export const softThreshold = hardThreshold;
