import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { MastraModelConfig } from '@mastra/core/llm';
import { logger } from '../../utils/logger.js';

export const getGenAIContext = (apiKey?: string) => {
    const resolvedKey = apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!resolvedKey) {
        throw new Error(
            'Google AI Studio requires an API key. ' +
            'Set GOOGLE_GENERATIVE_AI_API_KEY or configure it in settings.json providers.google-genai.apiKey'
        );
    }
    logger.debug('[GenAI] Using Google AI Studio (API key auth)');
    return createGoogleGenerativeAI({ apiKey: resolvedKey });
};

export const getGenAIModel = (modelName: string, apiKey?: string): MastraModelConfig => {
    const google = getGenAIContext(apiKey);
    return google(modelName);
};
