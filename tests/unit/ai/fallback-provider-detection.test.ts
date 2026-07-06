import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectFallbackProvider } from '../../../src/ai/models/provider.js';
import { configManager } from '../../../src/config/index.js';
import type { AIConfig } from '../../../src/config/schema.js';

function makeConfig(overrides: Partial<AIConfig> = {}): Required<AIConfig> {
    return {
        provider: 'bedrock',
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        embeddingProvider: 'bedrock',
        embeddingModel: 'amazon.titan-embed-text-v2:0',
        location: 'us-east-1',
        project: '',
        ...overrides,
    };
}

function mockVertexConfig(project?: string, location?: string) {
    vi.spyOn(configManager, 'getRawConfig').mockReturnValue({
        ai: {
            providers: {
                vertex: project ? { project, location } : undefined,
            },
        },
    });
}

describe('detectFallbackProvider', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        savedEnv.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        savedEnv.GOOGLE_VERTEX_LOCATION = process.env.GOOGLE_VERTEX_LOCATION;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        delete process.env.GOOGLE_VERTEX_LOCATION;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    it('skips the primary provider', () => {
        mockVertexConfig('p', 'us-central1');
        const cfg = makeConfig({ provider: 'vertex' });
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const result = detectFallbackProvider('vertex', cfg);
        expect(result?.provider).toBe('anthropic');
    });

    it('returns vertex when vertex project is configured (location defaults)', () => {
        mockVertexConfig('my-project');
        const cfg = makeConfig();
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result).toEqual({ provider: 'vertex', model: 'gemini-2.5-flash' });
    });

    it('does NOT return vertex when no vertex project is configured', () => {
        mockVertexConfig();
        const cfg = makeConfig({ location: 'us-east-1' });
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result).toBeNull();
    });

    it('returns anthropic when ANTHROPIC_API_KEY is set and vertex unavailable', () => {
        mockVertexConfig();
        const cfg = makeConfig();
        process.env.ANTHROPIC_API_KEY = 'test-key';
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    });

    it('returns openai when only OPENAI_API_KEY is available', () => {
        mockVertexConfig();
        const cfg = makeConfig();
        process.env.OPENAI_API_KEY = 'test-key';
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
    });

    it('returns null when no alternative credentials are available', () => {
        mockVertexConfig();
        const cfg = makeConfig();
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result).toBeNull();
    });

    it('respects priority: vertex > anthropic > openai > google-genai', () => {
        mockVertexConfig('p', 'us-central1');
        const cfg = makeConfig();
        process.env.ANTHROPIC_API_KEY = 'test';
        process.env.OPENAI_API_KEY = 'test';
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test';
        const result = detectFallbackProvider('bedrock', cfg);
        expect(result?.provider).toBe('vertex');
    });
});
