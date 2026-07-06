import { createAnthropic } from '@ai-sdk/anthropic';
import type { MastraModelConfig } from '@mastra/core/llm';
import { logger } from '../../utils/logger.js';

export const getAnthropicModel = (modelName: string, apiKey?: string): MastraModelConfig => {
    const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!resolvedKey) {
        throw new Error(
            'Anthropic requires an API key. ' +
            'Set ANTHROPIC_API_KEY or configure it in ~/.coderadius/config/credentials.json'
        );
    }
    logger.debug(`[Anthropic] Using model ${modelName}`);
    const anthropic = createAnthropic({ apiKey: resolvedKey });
    return anthropic(modelName);
};
