import { getGeminiModel } from './gemini.js';
import { getGenAIModel } from './google-genai.js';
import { getAnthropicModel } from './anthropic.js';
import { getOpenAIModel } from './openai.js';
import { getOllamaModel } from './ollama.js';
import { getBedrockModel } from './bedrock.js';
import { configManager, ActionContext } from '../../config/index.js';
import type { AIConfig, ProviderId } from '../../config/schema.js';
import type { MastraModelConfig } from '@mastra/core/llm';

export function getModel(action?: ActionContext): MastraModelConfig {
    const config = configManager.getAiConfig(action);

    switch (config.provider) {
        case 'vertex':
            if (!config.project || !config.location) {
                throw new Error(
                    'Vertex AI requires project and location. ' +
                    'Run `cr init` or set GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION.'
                );
            }
            return getGeminiModel(config.model, config.project, config.location);

        case 'google-genai':
            return getGenAIModel(config.model);

        case 'anthropic':
            return getAnthropicModel(config.model);

        case 'openai':
            return getOpenAIModel(config.model);

        case 'ollama':
            return getOllamaModel(config.model);

        case 'bedrock':
            return getBedrockModel(config.model, config.location);

        default:
            throw new Error(
                `Unknown provider: "${config.provider}". ` +
                `Supported: vertex, google-genai, anthropic, openai, ollama, bedrock`
            );
    }
}

export function getModelByProvider(provider: ProviderId, model: string, cfg: Required<AIConfig>): MastraModelConfig {
    switch (provider) {
        case 'vertex': {
            const raw = configManager.getRawConfig();
            const vertexProject = raw.ai?.providers?.vertex?.project || cfg.project;
            const vertexLocation = raw.ai?.providers?.vertex?.location
                || process.env.GOOGLE_VERTEX_LOCATION
                || 'global';
            if (!vertexProject) {
                throw new Error('Vertex AI fallback requires project. Set ai.providers.vertex.project in settings.json.');
            }
            return getGeminiModel(model, vertexProject, vertexLocation);
        }
        case 'google-genai':
            return getGenAIModel(model);
        case 'anthropic':
            return getAnthropicModel(model);
        case 'openai':
            return getOpenAIModel(model);
        case 'ollama':
            return getOllamaModel(model);
        case 'bedrock':
            return getBedrockModel(model, cfg.location);
        default:
            throw new Error(`Unknown fallback provider: "${provider}"`);
    }
}

interface FallbackCandidate {
    provider: ProviderId;
    model: string;
}

const FALLBACK_CANDIDATES: Array<FallbackCandidate & { check: (cfg: Required<AIConfig>) => boolean }> = [
    {
        provider: 'vertex',
        model: 'gemini-2.5-flash',
        check: () => {
            const raw = configManager.getRawConfig();
            return !!(raw.ai?.providers?.vertex?.project);
        },
    },
    {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        check: () => !!process.env.ANTHROPIC_API_KEY,
    },
    {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        check: () => !!process.env.OPENAI_API_KEY,
    },
    {
        provider: 'google-genai',
        model: 'gemini-2.5-flash',
        check: () => !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    },
];

export function detectFallbackProvider(
    primaryProvider: ProviderId,
    cfg: Required<AIConfig>,
): FallbackCandidate | null {
    for (const candidate of FALLBACK_CANDIDATES) {
        if (candidate.provider === primaryProvider) continue;
        if (candidate.check(cfg)) return { provider: candidate.provider, model: candidate.model };
    }
    return null;
}

