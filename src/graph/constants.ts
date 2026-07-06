/**
 * Architectural Graph Constants
 *
 * Re-export surface for the topology relationship vocabulary. The canonical
 * definitions live in `packages/shared-types/topology-rels.ts` so the backend
 * (this module's importers), the dashboard (lib/topology.ts, lib/blastTier.ts)
 * and the unit tests all consume ONE source and cannot drift. Same pattern as
 * the grounding vocabulary (src/graph/grounding.ts).
 *
 * Classification semantics:
 *   DEPENDENCY_RELS: source depends ON target  (target = upstream provider)
 *   EMISSION_RELS:   source pushes data TO target (target = downstream consumer)
 *   API_RELS:        source implements/exposes an API endpoint
 */

export {
    DEPENDENCY_RELS,
    EMISSION_RELS,
    API_RELS,
    ARCH_RELS,
    DOWNSTREAM_RELS_BLAST,
    UPSTREAM_RELS_BLAST,
    BLAST_ARCH_LABELS,
    EMISSION_DIRECTION_RELS,
    PASSTHROUGH_TYPES,
    IMPL_EP_DISCOUNT,
} from '@coderadius/shared-types';
