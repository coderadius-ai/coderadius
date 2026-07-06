import { z } from 'zod';

export const PROVIDER_IDS = ['vertex', 'google-genai', 'anthropic', 'openai', 'ollama', 'bedrock'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

/** Providers that support embedding models */
export const EMBEDDING_PROVIDER_IDS = ['vertex', 'google-genai', 'openai', 'ollama', 'bedrock'] as const;
export type EmbeddingProviderId = typeof EMBEDDING_PROVIDER_IDS[number];

export interface AIConfig {
    provider?: ProviderId;
    model?: string;
    embeddingProvider?: EmbeddingProviderId;
    embeddingModel?: string;
    location?: string;
    project?: string;
}

export const ConfigSchema = z.object({
    ai: z.object({
        /** Fast tier: high-volume work (ingest, mcp). "provider/model" format. */
        fast: z.string().optional(),
        /** Smart tier: quality work (chat, doc). "provider/model" format. */
        smart: z.string().optional(),
        ingest: z.string().optional(),
        ingestFallback: z.string().optional(),
        doc: z.string().optional(),
        chat: z.string().optional(),
        mcp: z.string().optional(),
        embedding: z.string().optional(),
        embeddingDimension: z.number().int().positive().optional(),
        providers: z.object({
            vertex: z.object({
                project: z.string().optional(),
                location: z.string().optional(),
                credentialsFile: z.string().optional(),
            }).optional(),
            'google-genai': z.object({
                apiKey: z.string().optional(),
            }).optional(),
            anthropic: z.object({
                apiKey: z.string().optional(),
                maxTokens: z.number().optional(),
            }).optional(),
            openai: z.object({
                apiKey: z.string().optional(),
                baseURL: z.string().optional(),
            }).optional(),
            ollama: z.object({
                baseURL: z.string().optional(),
            }).optional(),
            bedrock: z.object({
                region: z.string().optional(),
                profile: z.string().optional(),
            }).optional(),
        }).optional()
    }).optional(),
    /**
     * Ingestion pipeline settings.
     *
     * Controls auto-discovery behavior for the Datastore binding layer.
     */
    tenant: z.object({
        name: z.string(),
        slug: z.string(),
        description: z.string().optional(),
    }).optional(),
    ingestion: z.object({
        /**
         * When true, raw database hostnames from connection strings are
         * persisted on DatabaseEndpoint nodes (ep.host property).
         *
         * When false (default), hostnames are NEVER stored — only the
         * sha256-truncated endpointKey is persisted. This is the safe
         * default for enterprise environments where hostnames may be
         * sensitive infrastructure data.
         *
         * @default false
         */
        allowPlainTextHosts: z.boolean().default(false),
    }).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
