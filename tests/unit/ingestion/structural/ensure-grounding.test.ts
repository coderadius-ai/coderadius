import { describe, it, expect } from 'vitest';
import { ensureGrounding } from '../../../../src/ingestion/structural/queries.js';

describe('ensureGrounding', () => {
    it('injects default grounding when quality is missing', () => {
        const props = { name: 'test-channel', technology: 'rabbitmq' };
        const result = ensureGrounding(props);

        expect(result.source).toBe('ast');
        expect(result.quality).toBe('exact');
        expect(result.needsReview).toBe(false);
        expect(result.evidence_extractors).toEqual(['structural-plugin@v1']);
        expect(result.name).toBe('test-channel');
        expect(result.technology).toBe('rabbitmq');
    });

    it('preserves existing grounding when quality is already set', () => {
        const props = {
            name: 'test-channel',
            quality: 'high',
            source: 'composite',
            evidence_extractors: ['welder@v1'],
        };
        const result = ensureGrounding(props);

        expect(result.quality).toBe('high');
        expect(result.source).toBe('composite');
        expect(result.evidence_extractors).toEqual(['welder@v1']);
    });

    it('preserves plugin-provided grounding that overrides defaults', () => {
        const props = {
            name: 'test-channel',
            quality: 'medium',
            source: 'heuristic',
            needsReview: true,
            evidence_extractors: ['my-plugin@v2'],
        };
        const result = ensureGrounding(props);

        expect(result.quality).toBe('medium');
        expect(result.source).toBe('heuristic');
        expect(result.needsReview).toBe(true);
        expect(result.evidence_extractors).toEqual(['my-plugin@v2']);
    });

    it('does not mutate the input object', () => {
        const props = { name: 'test' };
        const result = ensureGrounding(props);

        expect(result).not.toBe(props);
        expect(props).not.toHaveProperty('quality');
    });

    it('treats null quality as missing', () => {
        const props = { name: 'test', quality: null };
        const result = ensureGrounding(props);

        expect(result.quality).toBe('exact');
        expect(result.source).toBe('ast');
    });
});
