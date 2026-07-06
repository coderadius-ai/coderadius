/**
 * Phase 1 (Fix #1) — mergeAstWithLlm contract.
 *
 * Critical assertions:
 *   1. AST OVERRIDES LLM on basename match (NOT concat).
 *   2. AST-only entries are added (LLM may miss the function entirely).
 *   3. LLM-only entries pass through unchanged.
 *   4. Direction filter is correct (produced AST is not merged with consumed LLM).
 *   5. FQCN matching is basename-aware (plugin emits `basename`, no normalize helper).
 */
import { describe, it, expect } from 'vitest';
import { mergeAstWithLlm } from '../../../../../src/ingestion/processors/code-pipeline/interpret/payloads.js';
import type { AstResolvedPayload } from '../../../../../src/ingestion/processors/code-pipeline/types.js';

describe('mergeAstWithLlm', () => {
    it('AST overrides LLM fields on basename match (override, not concat)', () => {
        const llm = [
            {
                name: 'RenewalRequest',
                fields: [
                    { name: 'wrongField', type: 'string' },
                ],
            },
        ];
        const ast: AstResolvedPayload[] = [
            {
                direction: 'produced',
                fqcn: 'RenewalRequest',
                basename: 'RenewalRequest',
                origin: 'return-type',
                fields: [
                    { name: 'renewalId', type: 'string' },
                    { name: 'customerId', type: 'int' },
                ],
                source: 'ast',
            },
        ];
        const out = mergeAstWithLlm(llm, ast, 'produced');
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('RenewalRequest');
        // AST fields, NOT the LLM's wrongField — full override.
        expect(out[0].fields).toEqual([
            { name: 'renewalId', type: 'string' },
            { name: 'customerId', type: 'int' },
        ]);
        // wrongField must NOT be present anywhere.
        expect(out[0].fields.find(f => f.name === 'wrongField')).toBeUndefined();
        expect(out[0].sourceTag).toBe('composite');
    });

    it('adds AST-only entries the LLM did not surface', () => {
        const llm: Array<{ name: string; fields: Array<{ name: string; type: string }> }> = [];
        const ast: AstResolvedPayload[] = [
            {
                direction: 'produced',
                fqcn: 'ShipmentProposal',
                basename: 'ShipmentProposal',
                origin: 'return-type',
                fields: [{ name: 'amount', type: 'int' }],
                source: 'ast',
            },
        ];
        const out = mergeAstWithLlm(llm, ast, 'produced');
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('ShipmentProposal');
        expect(out[0].sourceTag).toBe('ast');
        expect(out[0].fields).toEqual([{ name: 'amount', type: 'int' }]);
    });

    it('FQCN-named AST matches LLM short name via basename', () => {
        const llm = [
            { name: 'RenewalRequest', fields: [] },
        ];
        const ast: AstResolvedPayload[] = [
            {
                direction: 'produced',
                fqcn: 'Acme\\Orders\\RenewalRequest',
                basename: 'RenewalRequest',
                origin: 'parameter',
                fields: [{ name: 'id', type: 'string' }],
                source: 'ast',
            },
        ];
        const out = mergeAstWithLlm(llm, ast, 'produced');
        expect(out).toHaveLength(1);
        expect(out[0].sourceTag).toBe('composite');
        expect(out[0].fields).toEqual([{ name: 'id', type: 'string' }]);
    });

    it('passes LLM-only entries through (LLM emits, AST misses)', () => {
        const llm = [
            {
                name: 'WeirdPayload',
                fields: [{ name: 'foo', type: 'string' }],
            },
        ];
        const ast: AstResolvedPayload[] = [];
        const out = mergeAstWithLlm(llm, ast, 'produced');
        expect(out).toHaveLength(1);
        expect(out[0].sourceTag).toBe('llm');
        expect(out[0].fields).toEqual([{ name: 'foo', type: 'string' }]);
    });

    it('respects direction (consumed AST not merged with produced LLM)', () => {
        const llm = [
            { name: 'RenewalRequest', fields: [{ name: 'x', type: 'string' }] },
        ];
        const ast: AstResolvedPayload[] = [
            {
                direction: 'consumed',
                fqcn: 'RenewalRequest',
                basename: 'RenewalRequest',
                origin: 'parameter',
                fields: [{ name: 'id', type: 'string' }],
                source: 'ast',
            },
        ];
        const outProduced = mergeAstWithLlm(llm, ast, 'produced');
        // produced direction: LLM stays alone, no AST match.
        expect(outProduced).toHaveLength(1);
        expect(outProduced[0].sourceTag).toBe('llm');
        expect(outProduced[0].fields).toEqual([{ name: 'x', type: 'string' }]);

        const outConsumed = mergeAstWithLlm([], ast, 'consumed');
        expect(outConsumed).toHaveLength(1);
        expect(outConsumed[0].sourceTag).toBe('ast');
    });

    it('preserves isOpaque flag on LLM-only opaque passthrough', () => {
        const llm = [
            {
                name: 'OpaqueThing',
                fields: [{ name: '_opaque_reference', type: 'object' }],
            },
        ];
        const out = mergeAstWithLlm(llm, [], 'produced');
        expect(out).toHaveLength(1);
        expect(out[0].isOpaque).toBe(true);
        expect(out[0].sourceTag).toBe('llm');
    });

    it('clears isOpaque when AST resolves an opaque-marked payload', () => {
        const llm = [
            {
                name: 'RenewalRequest',
                fields: [{ name: '_opaque_reference', type: 'object' }],
            },
        ];
        const ast: AstResolvedPayload[] = [
            {
                direction: 'produced',
                fqcn: 'RenewalRequest',
                basename: 'RenewalRequest',
                origin: 'parameter',
                fields: [{ name: 'renewalId', type: 'string' }],
                source: 'ast',
            },
        ];
        const out = mergeAstWithLlm(llm, ast, 'produced');
        expect(out[0].isOpaque).toBe(false);
        expect(out[0].fields).toEqual([{ name: 'renewalId', type: 'string' }]);
    });
});
