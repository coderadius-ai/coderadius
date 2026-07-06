import type { Command } from 'commander';
import { configManager, type ActionContext } from '../../../config/index.js';

const ENV_VAR_MAP: Record<string, { key: string; secret?: boolean }[]> = {
    vertex: [
        { key: 'GOOGLE_VERTEX_PROJECT' },
        { key: 'GOOGLE_VERTEX_LOCATION' },
        { key: 'GOOGLE_APPLICATION_CREDENTIALS' },
    ],
    'google-genai': [
        { key: 'GOOGLE_GENERATIVE_AI_API_KEY', secret: true },
    ],
    anthropic: [
        { key: 'ANTHROPIC_API_KEY', secret: true },
    ],
    openai: [
        { key: 'OPENAI_API_KEY', secret: true },
        { key: 'OPENAI_BASE_URL' },
    ],
    ollama: [
        { key: 'OLLAMA_BASE_URL' },
    ],
    bedrock: [
        { key: 'AWS_REGION' },
        { key: 'AWS_ACCESS_KEY_ID', secret: true },
        { key: 'AWS_SECRET_ACCESS_KEY', secret: true },
    ],
};

function printProviderEnv(label: string, provider: string, model: string): void {
    console.log(`# ${label}: ${provider} / ${model}`);
    console.log(`export MODEL_PROVIDER=${provider}`);
    console.log(`export MODEL_NAME=${model}`);

    const vars = ENV_VAR_MAP[provider] || [];
    for (const v of vars) {
        const value = process.env[v.key];
        if (value && !v.secret) {
            console.log(`export ${v.key}=${value}`);
        } else {
            console.log(`export ${v.key}=${v.secret ? '<set-your-key>' : '<set-value>'}`);
        }
    }
}

export function registerConfigEnvCommand(configCmd: Command): void {
    configCmd
        .command('env')
        .description('Print environment variables needed for CI')
        .action(() => {
            configManager.reload();
            const config = configManager.getAiConfig();

            printProviderEnv('LLM', config.provider, config.model);
            console.log();

            const embProvider = config.embeddingProvider || config.provider;
            const embModel = config.embeddingModel;
            if (embProvider !== config.provider) {
                console.log(`# Embeddings: ${embProvider} / ${embModel}`);
                console.log(`export EMBEDDING_MODEL=${embProvider}/${embModel}`);
                const vars = ENV_VAR_MAP[embProvider] || [];
                for (const v of vars) {
                    if (process.env[v.key]) continue;
                    console.log(`export ${v.key}=${v.secret ? '<set-your-key>' : '<set-value>'}`);
                }
            } else {
                console.log(`# Embeddings: same provider (${embProvider} / ${embModel})`);
            }
            console.log();
        });
}
