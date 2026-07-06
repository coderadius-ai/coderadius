/**
 * Grounding precedence for infrastructure items, shared by the
 * per-kind interpreters and the remaining inline graph-writer cases.
 *
 * Moved verbatim from graph-writer.ts.
 */
import {
    astGrounding,
    compositeGrounding,
    llmGrounding,
    type GroundingFields,
} from '../../../../graph/grounding.js';

/**
 * Shape of an infrastructure item with grounding metadata.
 * The fields are optional and overlap with `InfraRef` from unified-analyzer;
 * we use a structural type so both LLM-emitted items and static-bypass items
 * flow through the same helper.
 */
export type InfraWithGrounding = {
    grounding?: GroundingFields;
    source?: 'ast' | 'llm';
    resolved_via?: string;
};

/**
 * Compute the grounding block for a single infrastructure item.
 *
 * Priority:
 *   1. Explicit `infra.grounding` — highest, used by DI binding registry
 *      static-bypass path. Carries `source='ast'` for AST+AST same-source
 *      merges, with `evidence.extractors` listing all producers
 *      (e.g. `['di-binding-resolver@v1','di-propagator-hop1@v1']`).
 *   2. `infra.source === 'ast'` — framework-signal overlay path; stamps
 *      `astGrounding('framework-signal-overlay@v1')`.
 *   3. LLM default — `llm/medium`, upgraded to composite via `resolved_via`
 *      (DI registry, logical-channel binding) when present.
 *
 * The fallback extractor lets each branch keep its own provenance tag in
 * the LLM path (e.g. `'graph-writer@v1'`); for the static-bypass path the
 * caller's branch is never reached because `grounding` is supplied upfront.
 */
export function groundingForInfra(
    infra: InfraWithGrounding,
    fallbackLlmExtractor: string,
): GroundingFields {
    if (infra.grounding) return infra.grounding;
    if (infra.source === 'ast') return astGrounding('framework-signal-overlay@v1');
    let prov = llmGrounding('unified-analyzer', fallbackLlmExtractor, 'unified-analyzer@v1', 'medium');
    if (infra.resolved_via) {
        prov = compositeGrounding(prov, astGrounding(`static-${infra.resolved_via}@v1`));
    }
    return prov;
}
