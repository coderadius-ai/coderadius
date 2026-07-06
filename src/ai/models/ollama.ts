import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';

export const getOllamaModel = (modelName?: string): MastraModelConfig => {
    const configuredBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    // Use the OpenAI-compatible endpoint of Ollama
    const baseURL = configuredBase.endsWith('/v1') ? configuredBase : `${configuredBase}/v1`;

    const ollamaOpenAI = createOpenAI({
        baseURL,
        apiKey: 'ollama', // key is required by the SDK but ignored by local Ollama
    });

    return ollamaOpenAI.chat(modelName || process.env.OLLAMA_COMPLETION_MODEL || 'qwen3.5:9b');
};
