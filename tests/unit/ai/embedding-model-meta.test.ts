import { describe, it, expect } from 'vitest';
import {
    resolveEmbeddingDimension,
    resolveNeedsNormalization,
    buildProviderOptions,
} from '../../../src/ai/embedding-model-meta.js';

describe('resolveEmbeddingDimension', () => {
    it('returns 768 for gemini-embedding-001', () => {
        expect(resolveEmbeddingDimension('vertex', 'gemini-embedding-001')).toBe(768);
    });

    it('returns 1024 for amazon.titan-embed-text-v2:0', () => {
        expect(resolveEmbeddingDimension('bedrock', 'amazon.titan-embed-text-v2:0')).toBe(1024);
    });

    it('returns 1536 for text-embedding-3-small', () => {
        expect(resolveEmbeddingDimension('openai', 'text-embedding-3-small')).toBe(1536);
    });

    it('uses configOverride when provided', () => {
        expect(resolveEmbeddingDimension('bedrock', 'amazon.titan-embed-text-v2:0', 512)).toBe(512);
    });

    it('uses configOverride for unknown models', () => {
        expect(resolveEmbeddingDimension('ollama', 'custom-model', 384)).toBe(384);
    });

    it('throws for unknown model without configOverride', () => {
        expect(() => resolveEmbeddingDimension('ollama', 'unknown-model'))
            .toThrow('Unknown embedding model "unknown-model"');
    });
});

describe('resolveNeedsNormalization', () => {
    it('returns true for Gemini models', () => {
        expect(resolveNeedsNormalization('gemini-embedding-001')).toBe(true);
    });

    it('returns false for OpenAI models', () => {
        expect(resolveNeedsNormalization('text-embedding-3-small')).toBe(false);
    });

    it('returns false for unknown models', () => {
        expect(resolveNeedsNormalization('unknown')).toBe(false);
    });
});

describe('buildProviderOptions', () => {
    it('returns outputDimensionality for vertex', () => {
        expect(buildProviderOptions('vertex', 'gemini-embedding-001', 768))
            .toEqual({ vertex: { outputDimensionality: 768 } });
    });

    it('returns outputDimensionality for google-genai', () => {
        expect(buildProviderOptions('google-genai', 'gemini-embedding-001', 768))
            .toEqual({ google: { outputDimensionality: 768 } });
    });

    it('returns dimensions for openai', () => {
        expect(buildProviderOptions('openai', 'text-embedding-3-small', 1536))
            .toEqual({ openai: { dimensions: 1536 } });
    });

    it('returns dimensions for bedrock titan', () => {
        expect(buildProviderOptions('bedrock', 'amazon.titan-embed-text-v2:0', 1024))
            .toEqual({ bedrock: { dimensions: 1024 } });
    });

    it('returns outputDimension for bedrock cohere', () => {
        expect(buildProviderOptions('bedrock', 'cohere.embed-english-v3', 1024))
            .toEqual({ bedrock: { outputDimension: 1024 } });
    });

    it('returns undefined for models without dimension control', () => {
        expect(buildProviderOptions('bedrock', 'amazon.titan-embed-text-v1', 1536))
            .toBeUndefined();
    });

    it('returns undefined for ollama', () => {
        expect(buildProviderOptions('ollama', 'nomic-embed-text', 768))
            .toBeUndefined();
    });
});
