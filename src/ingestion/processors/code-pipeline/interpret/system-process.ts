/**
 * interpretProcess — pure interpreter for the `Process` infra kind,
 * extracted from persistFunction's inline case: one SystemProcess node plus
 * the function→process SPAWNS edge. Grounding follows groundingForInfra
 * (explicit DI-bypass grounding wins).
 */
import { buildUrn } from '../../../../graph/urn.js';
import { emptyDelta, type GraphDelta, type NodeRef } from '../../../../graph/write-model/delta.js';
import { groundingForInfra, type InfraWithGrounding } from './infra-grounding.js';

export interface ProcessInterpretContext {
    functionId: string;
    commitHash: string;
}

export function interpretProcess(
    item: InfraWithGrounding & { name: string },
    ctx: ProcessInterpretContext,
): { delta: GraphDelta } {
    const prov = groundingForInfra(item, 'graph-writer@v1');
    const urn = buildUrn('systemprocess', item.name);
    const spRef: NodeRef = { label: 'SystemProcess', urn };

    const delta = emptyDelta();
    delta.nodes.push({
        label: 'SystemProcess',
        urn,
        propsOnce: { name: item.name, valid_from_commit: ctx.commitHash },
        props: { valid_to_commit: null },
        grounding: prov,
    });
    delta.edges.push({
        type: 'SPAWNS',
        from: { label: 'Function', urn: ctx.functionId },
        to: spRef,
        propsOnce: { valid_from_commit: ctx.commitHash },
        props: { valid_to_commit: null },
        grounding: prov,
    });
    return { delta };
}
