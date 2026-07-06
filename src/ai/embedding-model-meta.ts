import type { EmbeddingProviderId } from '../config/schema.js';

interface EmbeddingModelMeta {
    dimension: number;
    providerDimensionKey?: string;
    needsNormalization: boolean;
}

const EMBEDDING_MODEL_META = new Map<string, EmbeddingModelMeta>([
    // Gemini (Vertex / Google GenAI)
    ['gemini-embedding-001', { dimension: 768, providerDimensionKey: 'outputDimensionality', needsNormalization: true }],
    ['text-embedding-004', { dimension: 768, providerDimensionKey: 'outputDimensionality', needsNormalization: true }],
    // OpenAI
    ['text-embedding-3-small', { dimension: 1536, providerDimensionKey: 'dimensions', needsNormalization: false }],
    ['text-embedding-3-large', { dimension: 3072, providerDimensionKey: 'dimensions', needsNormalization: false }],
    // Bedrock — Titan
    ['amazon.titan-embed-text-v2:0', { dimension: 1024, providerDimensionKey: 'dimensions', needsNormalization: false }],
    ['amazon.titan-embed-text-v1', { dimension: 1536, needsNormalization: false }],
    // Bedrock — Cohere
    ['cohere.embed-english-v3', { dimension: 1024, providerDimensionKey: 'outputDimension', needsNormalization: false }],
    ['cohere.embed-multilingual-v3', { dimension: 1024, providerDimensionKey: 'outputDimension', needsNormalization: false }],
]);

const PROVIDER_OPTION_NAMESPACE: Record<string, string> = {
    vertex: 'vertex',
    'google-genai': 'google',
    openai: 'openai',
    bedrock: 'bedrock',
};

export function resolveEmbeddingDimension(
    _provider: EmbeddingProviderId,
    model: string,
    configOverride?: number,
): number {
    if (configOverride) return configOverride;

    const meta = EMBEDDING_MODEL_META.get(model);
    if (meta) return meta.dimension;

    throw new Error(
        `Unknown embedding model "${model}". ` +
        `Set ai.embeddingDimension in ~/.coderadius/config/settings.json or use a known model: ${[...EMBEDDING_MODEL_META.keys()].join(', ')}`,
    );
}

export function resolveNeedsNormalization(model: string): boolean {
    return EMBEDDING_MODEL_META.get(model)?.needsNormalization ?? false;
}

export function buildProviderOptions(
    provider: EmbeddingProviderId,
    model: string,
    dimension: number,
): Record<string, Record<string, unknown>> | undefined {
    const meta = EMBEDDING_MODEL_META.get(model);
    if (!meta?.providerDimensionKey) return undefined;

    const ns = PROVIDER_OPTION_NAMESPACE[provider];
    if (!ns) return undefined;

    return { [ns]: { [meta.providerDimensionKey]: dimension } };
}
