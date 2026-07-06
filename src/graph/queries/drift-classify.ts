// ─── Pure drift classification ──────────────────────────────────────────────
//
// Grounded-identity reconciliation, no DB, no string heuristics. Drift is only
// asserted between a declared dependency ref that resolves to a real graph node
// and the service's observed edge to that SAME node. Refs that resolve to no
// node in scope are "unverifiable" (honest "can't confirm here"), never drift.
//
// See docs/architecture/catalog-drift-grounding.md.

export interface ResolvedRef {
    /** The declared dependency name (already syntax-parsed at ingestion). */
    ref: string;
    /** URN of the real node it resolves to (unique exact catalogName/name match). */
    urn: string;
}

export interface ObservedTarget {
    urn: string;
    name: string;
}

export interface DependencyClassification {
    /** Declared, resolves to a node, and the service has the edge. */
    aligned: string[];
    /** Declared, resolves to a node, but the service has NO edge (real drift). */
    groundedMissing: string[];
    /** Observed edge to an in-scope node that no declared ref claims (real drift,
     *  only asserted when every declaration on the service was grounded). */
    observedUndeclared: string[];
    /** Declared refs that resolve to no node, plus (when any declaration is
     *  unresolved) the ambiguous observed edges that could be one of them. */
    unverifiable: string[];
}

/**
 * Classify one service's declared dependencies against its observed edges.
 *
 * @param declaredResolved  declared refs that resolved to a real node (ref -> urn)
 * @param declaredUnresolved declared refs that resolved to no node in scope
 * @param observed          the node targets the service actually has edges to
 */
export function classifyDependencyDrift(
    declaredResolved: ResolvedRef[],
    declaredUnresolved: string[],
    observed: ObservedTarget[],
): DependencyClassification {
    const observedByUrn = new Map<string, string>();
    for (const o of observed) {
        if (!observedByUrn.has(o.urn)) observedByUrn.set(o.urn, o.name);
    }
    const resolvedUrns = new Set(declaredResolved.map(d => d.urn));

    const aligned: string[] = [];
    const groundedMissing: string[] = [];
    for (const { ref, urn } of declaredResolved) {
        if (observedByUrn.has(urn)) aligned.push(ref);
        else groundedMissing.push(ref);
    }

    // Observed targets that no declared ref claims.
    const observedUnmatched: string[] = [];
    for (const [urn, name] of observedByUrn) {
        if (!resolvedUrns.has(urn)) observedUnmatched.push(name);
    }

    // When any declaration could not be grounded, an unmatched observed edge
    // might BE one of those declarations under a name we can't resolve -> it is
    // ambiguous, not "undeclared". Only assert observed-undeclared drift when the
    // declared side is fully grounded.
    const hasUnresolved = declaredUnresolved.length > 0;
    const observedUndeclared = hasUnresolved ? [] : observedUnmatched;
    const unverifiable = hasUnresolved
        ? [...declaredUnresolved, ...observedUnmatched]
        : [...declaredUnresolved];

    return { aligned, groundedMissing, observedUndeclared, unverifiable };
}

// ─── Owner reconciliation (grounded-or-unverifiable) ─────────────────────────
//
// A catalog owner and a CODEOWNERS owner are separate, name-keyed Team nodes.
// A NAME mismatch is NOT drift: we cannot deterministically tell "same team,
// two names" from "genuinely different teams". It is aligned only when the two
// identities are reconciled (same Team, or an approved TeamAlias bridges them);
// otherwise it is unverifiable (off-score), surfaced for review — never a
// score-lowering, fabricated drift on a spelling difference.

export interface OwnerFact {
    serviceName: string;
    serviceUrn: string;
    catalogOwner: string;
    codeOwner: string;
    /** True iff the two team identities are reconciled (same Team or approved alias). */
    reconciled: boolean;
}

export interface OwnerReconciliation {
    /** Mismatches reconciled to one identity — aligned, not drift. */
    reconciled: OwnerFact[];
    /** Mismatches with no grounded reconciliation — off-score review. */
    unverifiable: OwnerFact[];
}

export function classifyOwnerFacts(facts: OwnerFact[]): OwnerReconciliation {
    const reconciled: OwnerFact[] = [];
    const unverifiable: OwnerFact[] = [];
    for (const f of facts) {
        (f.reconciled ? reconciled : unverifiable).push(f);
    }
    return { reconciled, unverifiable };
}

/**
 * Alignment score. Only entities with GROUNDED drift lower it; unverifiable
 * facts are off-score. Denominator is catalog Components + code orphans.
 */
export function computeDriftScore(
    totalCatalogEntities: number,
    orphanCount: number,
    entitiesWithGroundedDrift: number,
): number {
    const denominator = totalCatalogEntities + orphanCount;
    if (denominator === 0) return 100;
    return Math.round((1 - entitiesWithGroundedDrift / denominator) * 100);
}

/**
 * Share of declared dependency facts we could actually ground (resolve to a real
 * node), verified vs the total declared. Makes the limited check-scope explicit.
 */
export function computeVerifiableCoverage(
    verifiedFacts: number,
    unverifiedFacts: number,
): number {
    const total = verifiedFacts + unverifiedFacts;
    if (total === 0) return 100;
    return Math.round((verifiedFacts / total) * 100);
}
