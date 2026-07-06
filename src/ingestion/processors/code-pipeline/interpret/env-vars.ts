/**
 * interpretEnvVars — pure delta emission for a function's env-var reads:
 * one EnvVar node per name (resolved value/source from the
 * repo-wide dictionary when available, coalesce-on-retouch via prop omission)
 * plus the function→EnvVar READS_ENV edge.
 */
import { buildUrn } from '../../../../graph/urn.js';
import { astGrounding } from '../../../../graph/grounding.js';
import { emptyDelta, type GraphDelta, type PropRecord } from '../../../../graph/write-model/delta.js';
import type { EnvVarBinding } from '../../infra-manifest-resolver.js';

export function interpretEnvVars(
    envVars: string[],
    envVarDict: Map<string, EnvVarBinding>,
    ctx: { functionId: string; commitHash: string },
): { delta: GraphDelta } {
    const delta = emptyDelta();
    const prov = astGrounding('env-var-resolver@v1');

    for (const name of envVars) {
        const binding = envVarDict.get(name.toUpperCase());
        const urn = buildUrn('envvar', name);
        const props: PropRecord = { valid_to_commit: null };
        if (binding?.value != null) props.resolvedValue = binding.value;
        if (binding?.sourceFile) props.valueSourceFile = binding.sourceFile;

        delta.nodes.push({
            label: 'EnvVar',
            urn,
            propsOnce: { name, valid_from_commit: ctx.commitHash },
            props,
            grounding: prov,
        });
        delta.edges.push({
            type: 'READS_ENV',
            from: { label: 'Function', urn: ctx.functionId },
            to: { label: 'EnvVar', urn },
            propsOnce: { valid_from_commit: ctx.commitHash },
            props: { valid_to_commit: null },
            grounding: prov,
        });
    }
    return { delta };
}
