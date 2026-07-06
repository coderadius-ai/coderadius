/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Heuristic registry seed — typed declaration for every name-based heuristic.
 *
 * Product rule: recognition may anchor on PUBLISHED CONTRACTS (framework APIs,
 * official image env vars, file-format signatures, URI schemes), never on
 * CUSTOMER FREE CHOICES (app env-var names, queue-name suffixes, class-name
 * duck-typing). Where a convention-guess survives, it must be DECLARED here so
 * it is greppable, countable, and auditable instead of silently load-bearing.
 *
 * `defineHeuristic` is intentionally a pure identity function: the value is the
 * declaration itself. A future registry/CI gate enumerates these call sites.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export type HeuristicClass = 'contract' | 'evidence-gated' | 'convention-guess';

export interface HeuristicDefinition<T> {
    /** Stable kebab-case identifier, referenced by extractor tags (`<id>@guess`). */
    id: string;
    /** Classification per the contracts-not-conventions rule. */
    class: HeuristicClass;
    /** What graph fact this heuristic gates (node/edge/identity/binding). */
    emits: string;
    /** Trace/telemetry surface where a firing (or miss) becomes visible. */
    surfacedBy: string;
    /** The heuristic payload (table, regex, predicate). */
    value: T;
}

export function defineHeuristic<T>(def: HeuristicDefinition<T>): HeuristicDefinition<T> {
    return def;
}
