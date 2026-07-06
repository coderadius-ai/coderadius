import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfig, ConfigSchema, AIConfig, ProviderId, PROVIDER_IDS, EmbeddingProviderId, EMBEDDING_PROVIDER_IDS } from './schema.js';
import { logger } from '../utils/logger.js';
import { paths } from './paths.js';

export type ActionContext = 'ingest' | 'doc' | 'chat' | 'mcp';

/**
 * Model tiers express intent, not mechanism: `fast` for high-volume work,
 * `smart` for quality work. Each action context maps to exactly one tier,
 * so a generic file-level default can never silently shadow the quality
 * contexts (the bug that motivated this design).
 */
export type ModelTier = 'fast' | 'smart';

const TIER_BY_ACTION: Record<ActionContext, ModelTier> = {
    ingest: 'fast',
    mcp: 'fast',
    chat: 'smart',
    doc: 'smart',
};

export function tierForAction(action?: ActionContext): ModelTier {
    return action ? TIER_BY_ACTION[action] : 'fast';
}

const TIER_DEFAULT_MODEL: Record<ModelTier, string> = {
    fast: 'gemini-3.1-flash-lite',
    smart: 'gemini-3.1-pro',
};

export interface ResolvedAiConfig {
    config: Required<AIConfig>;
    tier: ModelTier;
    /** Per-field provenance: which layer set the resolved value (e.g. 'ai.fast', 'env'). */
    sources: Partial<Record<keyof AIConfig, string>>;
}

class ConfigManager {
    private static instance: ConfigManager;
    private config: AppConfig = {};
    private isLoaded = false;

    private readonly configPath = paths.config.settings;

    private constructor() { }

    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    public reload(): void {
        this.isLoaded = false;
        this.config = this.loadFromFile();
        this.isLoaded = true;
    }

    private loadFromFile(): Partial<AppConfig> {
        if (!fs.existsSync(this.configPath)) {
            return {};
        }

        try {
            const fileContent = fs.readFileSync(this.configPath, 'utf-8');
            const parsedJson = JSON.parse(fileContent);
            const result = ConfigSchema.safeParse(parsedJson);

            if (result.success) {
                return result.data;
            } else {
                console.error(`\nInvalid configuration in ${this.configPath}:`);
                console.error(JSON.stringify(result.error.issues, null, 2));
                console.error(`\nPlease run 'cr init' to regenerate a valid configuration file.\n`);
                process.exit(1);
                return {};
            }
        } catch (error) {
            logger.warn(`Failed to read configuration file at ${this.configPath}: ${(error as Error).message}`);
            return {};
        }
    }

    private loadFromEnv(action?: ActionContext): Partial<AIConfig> {
        let envProvider: string | undefined;
        let envModel: string | undefined;
        let envEmbeddingModel: string | undefined;
        let location: string | undefined;
        let project: string | undefined;

        // General AI Env Vars
        if (process.env.MODEL_PROVIDER) envProvider = process.env.MODEL_PROVIDER;
        if (process.env.MODEL_NAME) envModel = process.env.MODEL_NAME;
        if (process.env.EMBEDDING_MODEL) envEmbeddingModel = process.env.EMBEDDING_MODEL;
        if (process.env.GOOGLE_VERTEX_LOCATION) location = process.env.GOOGLE_VERTEX_LOCATION;
        if (process.env.GOOGLE_VERTEX_PROJECT) project = process.env.GOOGLE_VERTEX_PROJECT;

        // Specific Action Env Vars (Overrides general)
        if (action) {
            const actionUpper = action.toUpperCase();
            if (process.env[`MODEL_PROVIDER_${actionUpper}`]) {
                envProvider = process.env[`MODEL_PROVIDER_${actionUpper}`];
            }
            if (process.env[`MODEL_NAME_${actionUpper}`]) {
                envModel = process.env[`MODEL_NAME_${actionUpper}`];
            }
            if (process.env[`EMBEDDING_MODEL_${actionUpper}`]) {
                envEmbeddingModel = process.env[`EMBEDDING_MODEL_${actionUpper}`];
            }
        }

        const modelConfig = this.parseModelString(envModel);
        const embConfig = this.parseModelString(envEmbeddingModel, true);

        const envConfig: Partial<AIConfig> = {
            ...modelConfig,
            ...embConfig,
        };

        // Explicit provider env var overrides the one parsed from model string if provided
        if (envProvider && (PROVIDER_IDS as readonly string[]).includes(envProvider)) {
            envConfig.provider = envProvider as ProviderId;
        }

        if (location) envConfig.location = location;
        if (project) envConfig.project = project;

        return envConfig;
    }

    private getTierDefaults(tier: ModelTier): Required<AIConfig> {
        return {
            provider: 'vertex',
            model: TIER_DEFAULT_MODEL[tier],
            embeddingProvider: 'vertex',
            embeddingModel: 'gemini-embedding-001',
            location: 'global',
            project: ''
        };
    }

    /** Provider-specific structural settings from the file (vertex project/location, bedrock region). */
    private getFileProviderConfig(): Partial<AIConfig> {
        const providerConfig: Partial<AIConfig> = {};
        if (this.config.ai?.providers?.vertex?.project) {
            providerConfig.project = this.config.ai.providers.vertex.project;
        }
        if (this.config.ai?.providers?.vertex?.location) {
            providerConfig.location = this.config.ai.providers.vertex.location;
        }
        if (this.config.ai?.providers?.bedrock?.region) {
            providerConfig.location = this.config.ai.providers.bedrock.region;
        }
        return providerConfig;
    }

    private parseModelString(value?: string, isEmbedding = false): Partial<AIConfig> {
        if (!value) return {};
        const parts = value.split('/');
        if (parts.length === 2) {
            if (isEmbedding) {
                return { embeddingProvider: parts[0] as EmbeddingProviderId, embeddingModel: parts[1] };
            }
            return { provider: parts[0] as ProviderId, model: parts[1] };
        }
        if (isEmbedding) {
            return { embeddingModel: value };
        }
        return { model: value };
    }

    public resolveAiConfig(action?: ActionContext): ResolvedAiConfig {
        if (!this.isLoaded) {
            this.config = this.loadFromFile();
            this.isLoaded = true;
        }

        const tier = tierForAction(action);

        // Ordered layers, later entries override earlier ones.
        // Each resolved field remembers the layer that set it (provenance).
        const layers: Array<{ name: string; values: Partial<AIConfig> }> = [
            { name: `built-in (${tier})`, values: this.getTierDefaults(tier) },
            { name: 'ai.providers', values: this.getFileProviderConfig() },
            { name: `ai.${tier}`, values: this.parseModelString(this.config.ai?.[tier]) },
            { name: 'ai.embedding', values: this.parseModelString(this.config.ai?.embedding, true) },
            { name: `ai.${action}`, values: action ? this.parseModelString(this.config.ai?.[action]) : {} },
            { name: 'env', values: this.loadFromEnv(action) },
        ];

        const config = {} as Required<AIConfig>;
        const sources: Partial<Record<keyof AIConfig, string>> = {};
        for (const layer of layers) {
            for (const [key, value] of Object.entries(layer.values)) {
                if (value === undefined) continue;
                (config as Record<string, unknown>)[key] = value;
                sources[key as keyof AIConfig] = layer.name;
            }
        }

        return { config, tier, sources };
    }

    public getAiConfig(action?: ActionContext): Required<AIConfig> {
        return this.resolveAiConfig(action).config;
    }

    /**
     * Bridges structural configuration in settings.json to environment variables
     * for external SDKs (like AI SDK) that expect flat env vars.
     * Does not override existing environment variables (e.g., from .env or CLI).
     */
    public bridgeSettingsToEnv(): void {
        if (!this.isLoaded) {
            this.config = this.loadFromFile();
            this.isLoaded = true;
        }

        const providers = this.config.ai?.providers;

        // ── Vertex AI ────────────────────────────────────────────────────
        if (providers?.vertex) {
            if (providers.vertex.project && !process.env.GOOGLE_VERTEX_PROJECT) {
                process.env.GOOGLE_VERTEX_PROJECT = providers.vertex.project;
                logger.debug('[Config] Bridged vertex.project from settings.json');
            }
            if (providers.vertex.location && !process.env.GOOGLE_VERTEX_LOCATION) {
                process.env.GOOGLE_VERTEX_LOCATION = providers.vertex.location;
                logger.debug('[Config] Bridged vertex.location from settings.json');
            }
            if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                let credsPath = providers.vertex.credentialsFile;
                if (!credsPath) {
                    const defaultPath = paths.config.gcpServiceAccount;
                    if (fs.existsSync(defaultPath)) {
                        credsPath = defaultPath;
                    }
                }
                if (credsPath) {
                    if (credsPath.startsWith('~/')) {
                        credsPath = path.join(os.homedir(), credsPath.slice(2));
                    }
                    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(credsPath);
                    logger.debug(`[Config] Bridged GOOGLE_APPLICATION_CREDENTIALS to ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
                }
            }
        }

        // ── Google AI Studio (GenAI) ─────────────────────────────────────
        if (providers?.['google-genai']?.apiKey && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
            process.env.GOOGLE_GENERATIVE_AI_API_KEY = providers['google-genai'].apiKey;
            logger.debug('[Config] Bridged google-genai.apiKey from settings.json');
        }

        // ── Anthropic ────────────────────────────────────────────────────
        if (providers?.anthropic?.apiKey && !process.env.ANTHROPIC_API_KEY) {
            process.env.ANTHROPIC_API_KEY = providers.anthropic.apiKey;
            logger.debug('[Config] Bridged anthropic.apiKey from settings.json');
        }

        // ── OpenAI ───────────────────────────────────────────────────────
        if (providers?.openai?.apiKey && !process.env.OPENAI_API_KEY) {
            process.env.OPENAI_API_KEY = providers.openai.apiKey;
            logger.debug('[Config] Bridged openai.apiKey from settings.json');
        }
        if (providers?.openai?.baseURL && !process.env.OPENAI_BASE_URL) {
            process.env.OPENAI_BASE_URL = providers.openai.baseURL;
            logger.debug('[Config] Bridged openai.baseURL from settings.json');
        }

        // ── Ollama ───────────────────────────────────────────────────────
        if (providers?.ollama?.baseURL && !process.env.OLLAMA_BASE_URL) {
            process.env.OLLAMA_BASE_URL = providers.ollama.baseURL;
            logger.debug('[Config] Bridged ollama.baseURL from settings.json');
        }

        // ── AWS Bedrock ─────────────────────────────────────────────────
        if (providers?.bedrock?.region && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
            process.env.AWS_REGION = providers.bedrock.region;
            logger.debug('[Config] Bridged bedrock.region from settings.json');
        }
    }

    /** Returns the raw loaded config (for `config show`) */
    public getRawConfig(): AppConfig {
        if (!this.isLoaded) {
            this.config = this.loadFromFile();
            this.isLoaded = true;
        }
        return this.config;
    }

    /** Returns the path to the settings file */
    public getConfigPath(): string {
        return this.configPath;
    }

    /**
     * Whether raw database hostnames should be persisted on DatabaseEndpoint nodes.
     * Defaults to false (privacy-safe).
     */
    public getAllowPlainTextHosts(): boolean {
        const config = this.getRawConfig();
        return config.ingestion?.allowPlainTextHosts ?? false;
    }

    /**
     * Explicit embedding dimension override from config or env var.
     * Returns undefined when not set (the embedding registry derives it from the model).
     */
    public getEmbeddingDimensionOverride(): number | undefined {
        const envDim = process.env.EMBEDDING_DIMENSION;
        if (envDim) {
            const parsed = parseInt(envDim, 10);
            if (!Number.isNaN(parsed) && parsed > 0) return parsed;
        }
        const config = this.getRawConfig();
        return config.ai?.embeddingDimension;
    }

    /**
     * Ingest fallback model in "provider/model" format.
     * Used by the unified analyzer when the primary model's structured-output decoder fails.
     */
    public getIngestFallback(): string | undefined {
        const env = process.env.INGEST_FALLBACK_MODEL;
        if (env) return env;
        const config = this.getRawConfig();
        return config.ai?.ingestFallback;
    }
}

export const configManager = ConfigManager.getInstance();
