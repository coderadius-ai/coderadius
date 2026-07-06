/**
 * Stage 2 — ioConfirmed slim instruction variant.
 *
 * When a function was pre-selected by deterministic taint/static gates, has_io
 * is already known true and the FILTER apparatus is dropped from the system
 * prompt. These tests pin the contract of the slim variant deterministically
 * (no LLM): it extracts-only, keeps every extraction rule, and is materially
 * smaller than the full filter+extract prompt.
 */
import { describe, it, expect } from 'vitest';
import { buildAnalyzerInstructions } from '../../../../src/ai/agents/unified-analyzer.js';

describe('buildAnalyzerInstructions — ioConfirmed slim variant', () => {
    const full = buildAnalyzerInstructions('fast');
    const slim = buildAnalyzerInstructions('fast', undefined, true);

    it('drops the FILTER apparatus on the io-confirmed path', () => {
        // These blocks exist only to DECIDE has_io; gone once the gate decides it.
        expect(slim).not.toContain('<filter_rules>');
        expect(slim).not.toContain('<client_state_exclusion>');
        expect(slim).not.toContain('<functional_programming_rules>');
    });

    it('asserts has_io is already true and the job is extract-only', () => {
        expect(slim).toContain('CONFIRMED to perform external I/O');
        expect(slim).toContain('has_io is ALWAYS true');
        expect(slim).toMatch(/EXTRACT/);
    });

    it('keeps every EXTRACTION-RECALL rule (recall is preserved)', () => {
        // Recall rules the sanitizer cannot reconstruct must survive.
        expect(slim).toContain('<extraction_rules>');
        expect(slim).toContain('EVIDENCE: every Database entry');
        expect(slim).toContain('CONCATENATION');
        expect(slim).toContain('<wrapper_detection>');
        // telemetry-as-infra guard is retained as an extraction rule (not a filter)
        expect(slim).toContain('Observability');
        // compact name-cleanup recall line is kept (extract names only from literals)
        expect(slim).toContain('ONLY from SQL literals');
    });

    it('Stage 1: drops the has_io-framed name-cleanup blocks on the io path', () => {
        // has_io is forced here, so the reject-list enumeration and the
        // has_io-framed anti-hallucination examples are dead weight.
        expect(slim).not.toContain('Reject as table names');
        expect(slim).not.toContain('<anti_hallucination_guard>');
        // ...but the FULL path still relies on them to calibrate has_io.
        expect(full).toContain('Reject as table names');
        expect(full).toContain('<anti_hallucination_guard>');
    });

    it('is materially smaller than the full filter+extract prompt', () => {
        expect(slim.length).toBeLessThan(full.length);
        // The dropped FILTER apparatus is ~1.5-2.5k chars (~400-600 tok).
        expect(full.length - slim.length).toBeGreaterThan(1400);
    });

    it('full (default) variant is unchanged — still performs FILTER', () => {
        expect(full).toContain('<filter_rules>');
        expect(full).toContain('performs TWO tasks');
    });

    it('language hints still compose on the io-confirmed path', () => {
        const withHints = buildAnalyzerInstructions('fast', '<php_rules>\nDoctrine entity rules\n</php_rules>', true);
        expect(withHints).toContain('<php_rules>');
        expect(withHints).not.toContain('<filter_rules>');
    });

    it('Stage 5 instruction scoping: a database-only prompt drops broker + API rules', () => {
        const db = buildAnalyzerInstructions('fast', undefined, true, new Set(['database'] as const));
        expect(db).toContain('For Databases');
        expect(db).not.toContain('For MessageChannels');     // BROKER_RULES dropped
        expect(db).not.toContain('Emergent API Calls');       // API_CALL_RULES dropped
        // smaller than the all-category io prompt
        expect(db.length).toBeLessThan(buildAnalyzerInstructions('fast', undefined, true).length);
    });

    it('Stage 5 instruction scoping: a broker-only prompt drops the DB block', () => {
        const broker = buildAnalyzerInstructions('fast', undefined, true, new Set(['broker'] as const));
        expect(broker).toContain('For MessageChannels');
        expect(broker).not.toContain('For Databases');
        expect(broker).not.toContain('Emergent API Calls');
    });

    it('Stage 5 instruction scoping: http-only keeps emergent-API rules, drops DB + broker', () => {
        const http = buildAnalyzerInstructions('fast', undefined, true, new Set(['http'] as const));
        expect(http).toContain('Emergent API Calls');
        expect(http).not.toContain('For Databases');
        expect(http).not.toContain('For MessageChannels');
    });

    it('no categories (undefined) = full extraction rules (unchanged behaviour)', () => {
        const full = buildAnalyzerInstructions('fast', undefined, true);
        expect(full).toContain('For Databases');
        expect(full).toContain('For MessageChannels');
        expect(full).toContain('Emergent API Calls');
    });
});
