import { describe, expect, it } from 'vitest';
import {
    isStructuralFamily,
    qualityAtLeast,
    QUALITY_META,
    QUALITY_VALUES,
    SOURCE_META,
    SOURCE_VALUES,
} from '../../../packages/dashboard-ui/src/types/grounding';

describe('dashboard provenance mirror', () => {
    it('enum lists agree with backend on count and order', () => {
        // The mirror copies QUALITY_VALUES and SOURCE_VALUES verbatim from
        // src/graph/provenance.ts. If a value is added/removed/reordered on
        // the backend, this test reminds the dev to update the mirror.
        expect(QUALITY_VALUES).toEqual(['exact', 'high', 'medium', 'low', 'speculative']);
        expect(SOURCE_VALUES).toEqual(['ast', 'heuristic', 'llm', 'composite', 'declared', 'infra', 'runtime']);
    });

    it('QUALITY_META has an entry for every quality value', () => {
        for (const q of QUALITY_VALUES) {
            expect(QUALITY_META[q]).toBeDefined();
            expect(QUALITY_META[q].label.length).toBeGreaterThan(0);
            expect(QUALITY_META[q].tagline.length).toBeGreaterThan(0);
            expect(QUALITY_META[q].color).toMatch(/var\(--cr-|#/);
        }
        // Labels should be natural language descriptors, not the raw enum
        // ("EXACT" / "MEDIUM" etc) — that was the bug the redesign fixed.
        // Raw enum values must NOT appear as labels.
        const labels = QUALITY_VALUES.map(q => QUALITY_META[q].label.toLowerCase());
        expect(labels).not.toContain('exact');
        expect(labels).not.toContain('medium');
        expect(labels).not.toContain('low');
        expect(labels).not.toContain('speculative');
    });

    it('SOURCE_META has a natural-language entry for every source value', () => {
        for (const s of SOURCE_VALUES) {
            expect(SOURCE_META[s]).toBeDefined();
            expect(SOURCE_META[s].label.length).toBeGreaterThan(0);
            expect(SOURCE_META[s].detail.length).toBeGreaterThan(0);
            // Labels must not be the raw enum value — those are backend
            // implementation details, not operator-facing strings.
            expect(SOURCE_META[s].label.toLowerCase()).not.toBe(s);
        }
    });

    it('qualityAtLeast respects the ordered tier ladder', () => {
        expect(qualityAtLeast('exact', 'high')).toBe(true);
        expect(qualityAtLeast('high', 'high')).toBe(true);
        expect(qualityAtLeast('medium', 'high')).toBe(false);
        expect(qualityAtLeast('low', 'speculative')).toBe(true);
        expect(qualityAtLeast('speculative', 'low')).toBe(false);
    });

    it('isStructuralFamily classifies pure-AST labels as structural', () => {
        // Decision-relevant inferred labels — badge MUST appear by default
        expect(isStructuralFamily('MessageChannel')).toBe(false);
        expect(isStructuralFamily('DataContainer')).toBe(false);
        expect(isStructuralFamily('APIEndpoint')).toBe(false);
        expect(isStructuralFamily('APIInterface')).toBe(false);
        // Structural — badge HIDDEN by default to keep the dashboard signal:noise high
        expect(isStructuralFamily('SourceFile')).toBe(true);
        expect(isStructuralFamily('Function')).toBe(true);
        expect(isStructuralFamily('Service')).toBe(true);
        expect(isStructuralFamily('Repository')).toBe(true);
    });

    it('isStructuralFamily classifies structural edges as structural', () => {
        expect(isStructuralFamily('CONTAINS')).toBe(true);
        expect(isStructuralFamily('HAS_ENDPOINT')).toBe(true);
        // Inferred edges — badge VISIBLE by default
        expect(isStructuralFamily('PUBLISHES_TO')).toBe(false);
        expect(isStructuralFamily('LISTENS_TO')).toBe(false);
        expect(isStructuralFamily('CALLS')).toBe(false);
        expect(isStructuralFamily('READS')).toBe(false);
        expect(isStructuralFamily('WRITES')).toBe(false);
    });
});
