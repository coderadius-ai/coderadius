import { describe, it, expect } from 'vitest';
import { interpretProcess } from '../../../src/ingestion/processors/code-pipeline/interpret/system-process.js';
import { buildUrn } from '../../../src/graph/urn.js';

// Pins the Process infra case extracted from persistFunction —
// SystemProcess node + SPAWNS edge, grounding via groundingForInfra
// (explicit DI-bypass grounding wins over the generic infra fallback).

const CTX = {
    functionId: 'acme/inventory:src/jobs.php:runExport',
    commitHash: 'commit-proc-1',
};

describe('interpretProcess', () => {
    it('emits the SystemProcess node and the SPAWNS edge', () => {
        const { delta } = interpretProcess({ name: 'pdf-renderer' }, CTX);

        const [sp] = delta.nodes;
        expect(sp.label).toBe('SystemProcess');
        expect(sp.urn).toBe(buildUrn('systemprocess', 'pdf-renderer'));
        expect(sp.propsOnce).toEqual({ name: 'pdf-renderer', valid_from_commit: CTX.commitHash });
        expect(sp.props).toEqual({ valid_to_commit: null });
        expect(sp.grounding.source).toBe('llm');

        const [spawns] = delta.edges;
        expect(spawns.type).toBe('SPAWNS');
        expect(spawns.from).toEqual({ label: 'Function', urn: CTX.functionId });
        expect(spawns.to).toEqual({ label: 'SystemProcess', urn: sp.urn });
    });

    it('explicit infra.grounding wins (DI bypass parity)', () => {
        const explicit = {
            source: 'ast' as const, quality: 'exact' as const,
            evidence: { extractors: ['di-binding-resolver@v1'] },
        };
        const { delta } = interpretProcess({ name: 'pdf-renderer', grounding: explicit }, CTX);
        expect(delta.nodes[0].grounding.evidence.extractors).toEqual(['di-binding-resolver@v1']);
    });
});
