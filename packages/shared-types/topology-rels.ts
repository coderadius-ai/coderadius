/**
 * Topology relationship vocabulary + blast tier classification.
 *
 * Single source of truth shared by the backend (src/graph/constants.ts
 * re-exports from here) and the dashboard (lib/topology.ts, lib/blastTier.ts
 * import directly). Pure values and types, zero dependencies, isomorphic.
 * Follows the grounding.ts precedent: vocabulary lives here, UI-only meta
 * (labels, palette) stays in the dashboard adapter.
 *
 * Classification semantics:
 *   DEPENDENCY_RELS: source depends ON target  (target = upstream provider)
 *   EMISSION_RELS:   source pushes data TO target (target = downstream consumer)
 *   API_RELS:        source implements/exposes an API endpoint
 */

// ─── Dependency relationships ────────────────────────────────────────────────
// Out-edge target is the upstream provider ("I depend on it").
// In-edge source is a downstream consumer ("it depends on me").
export const DEPENDENCY_RELS = [
    'CALLS',
    'READS',
    'LISTENS_TO',
    'CONSUMES',
    'COMMUNICATES_WITH',
    'DEPENDS_ON',
    'ROUTES_TO',
    // ORM entity-to-table mapping: the mapper depends on the table (read-like).
    // A table does not break when its mapper dies; the mapper breaks when the
    // table changes. Same classification the SPOF query uses (gravity.ts).
    'MAPS_TO',
    // ─ Messaging topology ─
    // Channel HOSTED_ON Broker: channel ceases to exist when its broker is down.
    'HOSTED_ON',
    // LogicalChannel MANIFESTS_AS PhysicalChannel: a business event is realized
    // by one or more physical channels (mirror, fan-out, env-split).
    'MANIFESTS_AS',
    // TransportChannel BACKED_BY PhysicalChannel: Symfony Messenger transport
    // sits on top of an underlying broker queue/exchange.
    'BACKED_BY',
    // DataStructure CARRIED_BY MessageChannel: a contract travels on this
    // channel. Explicit inverse of HAS_SCHEMA, useful for "which channels
    // ship this contract?" lineage queries.
    'CARRIED_BY',
] as const;

// ─── Emission relationships ──────────────────────────────────────────────────
// Out-edge target is downstream ("I write/publish/produce to it").
// In-edge source is an upstream provider ("it feeds me").
export const EMISSION_RELS = [
    'WRITES',
    'PUBLISHES_TO',
    'PRODUCES',
    'SPAWNS',
    // ─ Messaging operational ─
    // Channel DEAD_LETTERS_TO Channel: messages rejected/expired on the source
    // flow to the destination DLQ. Captures second-order blast (consumer break
    // leads to backlog accumulation on the DLQ).
    'DEAD_LETTERS_TO',
] as const;

// ─── API contract relationships ──────────────────────────────────────────────
// Service implements the endpoint: the service is the provider/upstream.
export const API_RELS = [
    'IMPLEMENTS_ENDPOINT',
] as const;

// ─── Combined sets ───────────────────────────────────────────────────────────

/** All architectural relationship types, used by getTopologyMap() for the full graph scan. */
export const ARCH_RELS = [...DEPENDENCY_RELS, ...EMISSION_RELS, ...API_RELS] as const;

/**
 * Downstream rels for analyzeBlast() Cypher queries.
 * In analyzeBlast, "downstream" = who depends ON the resource
 * (i.e. nodes that CALL/READ/LISTEN to the target).
 */
export const DOWNSTREAM_RELS_BLAST = [...DEPENDENCY_RELS] as const;

/**
 * Upstream rels for analyzeBlast() Cypher queries.
 * In analyzeBlast, "upstream" = who feeds INTO the resource
 * (i.e. nodes that WRITE/PUBLISH/PRODUCE toward the target).
 * A Service that IMPLEMENTS_ENDPOINT is the provider/upstream of the APIEndpoint.
 */
export const UPSTREAM_RELS_BLAST = [...EMISSION_RELS, ...API_RELS] as const;

// ─── Architectural node labels ───────────────────────────────────────────────
// Nodes relevant for impact analysis (excludes code-level artifacts and
// design-time nodes like APIInterface, which are not runtime resources).
export const BLAST_ARCH_LABELS = [
    'Service', 'Package', 'DataContainer', 'Datastore',
    'MessageChannel', 'APIEndpoint', 'SystemProcess',
] as const;

// ─── Direction set for impact/gravity engines ────────────────────────────────

/**
 * Rels where the edge SOURCE is the producer/provider of the TARGET.
 * Impact direction rule (gravity engine + blast explorer panels):
 *   out-edge with rel in this set: target is downstream of the source
 *   in-edge  with rel NOT in this set: source is downstream of the target
 * IMPLEMENTS_ENDPOINT behaves like emission here (the service provides the
 * endpoint), which is why this set is the union of EMISSION and API rels.
 */
export const EMISSION_DIRECTION_RELS: ReadonlySet<string> = new Set([
    ...EMISSION_RELS, ...API_RELS,
]);

/**
 * Node types that act as passthrough resources for Tier 2 transitive
 * expansion. Data/signals flow THROUGH these; Services and SystemProcesses
 * are endpoints of the flow, never followed through.
 */
export const PASSTHROUGH_TYPES: ReadonlySet<string> = new Set([
    'DataContainer', 'MessageChannel', 'Datastore', 'APIEndpoint',
]);

/**
 * Discount coefficient for IMPLEMENTS_ENDPOINT edges with no observed
 * consumers. In a partial graph, 0 observed CALLS is not proof of 0 real
 * consumers; 0.5 is the conservative middle ground between dropping the
 * endpoint (under-count) and full 2.0 weight (the historical inflation).
 */
export const IMPL_EP_DISCOUNT = 0.5;

// ─── Gravity evidence ────────────────────────────────────────────────────────

/**
 * Per-node evidence backing the gravity score, stamped by
 * computeGravityScores() next to `gravityScore`.
 *
 * `observed` is the demotion gate: true when at least one real dependent was
 * seen in the scanned graph (an in-edge dependent, a Tier-2 transitive node,
 * or an endpoint with a caller). When false, the score derives entirely from
 * the node's own write/publish footprint and the UI demotes the tier to
 * "T? Unverified": the real blast may be higher (consumers in unscanned
 * repos) or lower (write-only targets are not casualties).
 */
export interface GravityEvidence {
    observed: boolean;
    /** Raw in-edge count (all rels). */
    inDegree: number;
    /** Tier-1 downstream added from in-edges: dependents that point at this node. */
    directFromInEdges: number;
    /** Tier-2 transitive nodes reached through passthrough resources. */
    transitiveCount: number;
    /** IMPLEMENTS_ENDPOINT targets with at least one observed consumer. */
    consumedEndpoints: number;
}

// ─── Blast tier classification ───────────────────────────────────────────────

/** Numeric gravity tiers, ordered by severity. */
export type GravityTierKey = 'seismic' | 'critical' | 'high' | 'moderate' | 'contained';

/** Display tiers: the numeric ladder plus the evidence-gated demotion tier. */
export type BlastTierKey = GravityTierKey | 'unverified';

/** Single-letter grades for compact display. */
export const TIER_GRADES: Record<BlastTierKey, string> = {
    seismic: 'T0',
    critical: 'T1',
    high: 'T2',
    moderate: 'T3',
    contained: 'T4',
    unverified: 'T?',
};

/**
 * Gravity-calibrated raw-score thresholds (lower bound of each tier).
 * Calibrated empirically in tests/unit/graph/gravity-score.test.ts.
 */
export const TIER_THRESHOLDS: Record<Exclude<GravityTierKey, 'contained'>, number> = {
    seismic: 100,
    critical: 50,
    high: 15,
    moderate: 6,
};

/** Classify a raw gravity score into its numeric tier. */
export function classifyTier(rawScore: number): GravityTierKey {
    if (rawScore >= TIER_THRESHOLDS.seismic) return 'seismic';
    if (rawScore >= TIER_THRESHOLDS.critical) return 'critical';
    if (rawScore >= TIER_THRESHOLDS.high) return 'high';
    if (rawScore >= TIER_THRESHOLDS.moderate) return 'moderate';
    return 'contained';
}

/**
 * Evidence-aware tier classification: the single demotion chokepoint.
 * A score with evidence and no observed dependent demotes to 'unverified';
 * missing evidence (legacy payloads, SPOF summaries) never demotes.
 */
export function classifyGravityTier(
    rawScore: number,
    evidence?: GravityEvidence | null,
): BlastTierKey {
    if (evidence && !evidence.observed) return 'unverified';
    return classifyTier(rawScore);
}

// ─── Bar normalization ───────────────────────────────────────────────────────

/** Upper bounds of the T4..T0 bands; the T0 band saturates at 200. */
const TIER_BANDS = [
    TIER_THRESHOLDS.moderate,   // 6
    TIER_THRESHOLDS.high,       // 15
    TIER_THRESHOLDS.critical,   // 50
    TIER_THRESHOLDS.seismic,    // 100
    200,
] as const;

/**
 * Map a raw gravity score onto the 0..1 blast gauge so that tier boundaries
 * land on fixed bar positions (each tier owns a fifth of the bar):
 *   T4 [0,6)    -> [0,0.2)     T3 [6,15)   -> [0.2,0.4)
 *   T2 [15,50)  -> [0.4,0.6)   T1 [50,100) -> [0.6,0.8)
 *   T0 [100,200]-> [0.8,1.0]   (clamped to 1 above 200)
 * Within a band the mapping is linear. This keeps the gauge colour zones
 * aligned with the tier chip instead of the old raw/130 magic constant.
 */
export function normaliseToBar(rawScore: number): number {
    if (rawScore <= 0) return 0;
    for (let i = 0; i < TIER_BANDS.length; i++) {
        const lower = i === 0 ? 0 : TIER_BANDS[i - 1];
        const upper = TIER_BANDS[i];
        if (rawScore <= upper) {
            return (i + (rawScore - lower) / (upper - lower)) / TIER_BANDS.length;
        }
    }
    return 1;
}
