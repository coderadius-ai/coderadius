import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import { logger } from '../../utils/logger.js';

export const getOpenAIContext = (apiKey?: string, baseURL?: string) => {
    const resolvedKey = apiKey || process.env.OPENAI_API_KEY;
    if (!resolvedKey) {
        throw new Error(
            'OpenAI requires an API key. ' +
            'Set OPENAI_API_KEY or configure it in ~/.coderadius/config/credentials.json'
        );
    }
    const resolvedBaseURL = baseURL || process.env.OPENAI_BASE_URL;
    logger.debug(`[OpenAI] Using ${resolvedBaseURL ? `custom endpoint: ${resolvedBaseURL}` : 'api.openai.com'}`);
    return createOpenAI({
        apiKey: resolvedKey,
        ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {}),
    });
};

export const getOpenAIModel = (modelName: string, apiKey?: string, baseURL?: string): MastraModelConfig => {
    const openai = getOpenAIContext(apiKey, baseURL);
    return openai.chat(modelName);
};
