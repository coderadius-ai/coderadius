import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/paths.js';
import { logger } from '../utils/logger.js';
import { embed, embedMany, EmbeddingModel } from 'ai';
import { getVertexContext } from './models/gemini.js';
import { getGenAIContext } from './models/google-genai.js';
import { getOpenAIContext } from './models/openai.js';
import { getBedrockProvider } from './models/bedrock.js';
import { configManager } from '../config/index.js';
import { isRateLimitError } from '../utils/congestion-control.js';
import { telemetryCollector } from '../telemetry/collector.js';
import { resolveEmbeddingDimension, resolveNeedsNormalization, buildProviderOptions } from './embedding-model-meta.js';
import type { AIConfig, EmbeddingProviderId } from '../config/schema.js';
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 500;

const NO_EMBEDDING_PROVIDERS = new Set<string>(['anthropic']);

function pickEmbeddingFallback(): EmbeddingProviderId | undefined {
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return 'google-genai';
    return 'ollama';
}

type EmbeddingResolution = {
    model: EmbeddingModel;
    providerOptions?: Record<string, Record<string, unknown>>;
    needsNormalization: boolean;
} | null;

function resolveAISdkEmbeddingModel(config: Required<AIConfig>): EmbeddingResolution {
    const embeddingProvider = config.embeddingProvider || config.provider;
    const embeddingModel = config.embeddingModel;
    const dimOverride = configManager.getEmbeddingDimensionOverride();

    switch (embeddingProvider) {
        case 'vertex': {
            const vertex = getVertexContext(config.project, config.location);
            const dim = resolveEmbeddingDimension(embeddingProvider, embeddingModel, dimOverride);
            return {
                model: vertex.embeddingModel(embeddingModel),
                providerOptions: buildProviderOptions(embeddingProvider, embeddingModel, dim),
                needsNormalization: resolveNeedsNormalization(embeddingModel),
            };
        }
        case 'google-genai': {
            const genai = getGenAIContext();
            const model = embeddingModel || 'gemini-embedding-001';
            const dim = resolveEmbeddingDimension(embeddingProvider, model, dimOverride);
            return {
                model: genai.embeddingModel(model),
                providerOptions: buildProviderOptions(embeddingProvider, model, dim),
                needsNormalization: resolveNeedsNormalization(model),
            };
        }
        case 'openai': {
            const openai = getOpenAIContext();
            const model = embeddingModel || 'text-embedding-3-small';
            const dim = resolveEmbeddingDimension(embeddingProvider, model, dimOverride);
            return {
                model: openai.embeddingModel(model),
                providerOptions: buildProviderOptions(embeddingProvider, model, dim),
                needsNormalization: resolveNeedsNormalization(model),
            };
        }
        case 'bedrock': {
            const bedrock = getBedrockProvider(config.location);
            const model = embeddingModel || 'amazon.titan-embed-text-v2:0';
            const dim = resolveEmbeddingDimension(embeddingProvider, model, dimOverride);
            return {
                model: bedrock.embeddingModel(model),
                providerOptions: buildProviderOptions(embeddingProvider, model, dim),
                needsNormalization: resolveNeedsNormalization(model),
            };
        }
        case 'ollama':
            return null;
        default: {
            if (NO_EMBEDDING_PROVIDERS.has(embeddingProvider)) {
                const fallback = pickEmbeddingFallback();
                if (fallback) {
                    logger.warn(
                        `${embeddingProvider} does not support embeddings. Using ${fallback} as fallback. ` +
                        'Set ai.embedding in ~/.coderadius/config/settings.json to configure explicitly.'
                    );
                    return resolveAISdkEmbeddingModel({ ...config, embeddingProvider: fallback });
                }
            }
            throw new Error(
                `Provider "${embeddingProvider}" does not support embeddings. ` +
                'Set ai.embedding in ~/.coderadius/config/settings.json (e.g. "openai/text-embedding-3-small").'
            );
        }
    }
}

/**
 * L2-normalize a vector in-place.
 *
 * Gemini only pre-normalizes the full 3072-dim output.
 * For reduced dimensions (768, 1536) you MUST normalize yourself
 * to get accurate cosine similarity scores.
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/text-embeddings-api
 */
function l2Normalize(vec: number[]): number[] {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
}

/** Reject after ms with a clear timeout error */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)), ms)
        ),
    ]);
}

// ─── Deterministic Embedding Cache ───────────────────────────────────────────

const CACHE_DIR = paths.cache.dir;
const CACHE_FILE = paths.cache.embeddings;
const CACHE_VERSION = 2;

function hashText(text: string, provider: string, model: string): string {
    return crypto.createHash('sha256').update(`${provider}:${model}:${text}`).digest('hex').substring(0, 32);
}

interface CacheEnvelope {
    version: number;
    entries: Record<string, number[]>;
}

class EmbeddingCache {
    private cache: Map<string, number[]>;
    private dirty = false;

    constructor() {
        this.cache = new Map();
    }

    static load(): EmbeddingCache {
        const instance = new EmbeddingCache();
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
                const parsed = JSON.parse(raw);

                if (parsed && typeof parsed === 'object' && parsed.version === CACHE_VERSION) {
                    for (const [key, value] of Object.entries(parsed.entries ?? {})) {
                        instance.cache.set(key, value as number[]);
                    }
                } else {
                    logger.info('[EmbeddingCache] Cache format upgraded (model-scoped keys). Previous cache cleared.');
                    instance.dirty = true;
                }
            }
        } catch (err) {
            logger.warn(`[EmbeddingCache] Failed to load cache: ${(err as Error).message}`);
        }
        return instance;
    }

    get(hash: string): number[] | undefined {
        return this.cache.get(hash);
    }

    set(hash: string, embedding: number[]) {
        this.cache.set(hash, embedding);
        this.dirty = true;
    }

    save() {
        if (!this.dirty) return;
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            const envelope: CacheEnvelope = { version: CACHE_VERSION, entries: {} };
            for (const [key, value] of this.cache) {
                envelope.entries[key] = value;
            }
            fs.writeFileSync(CACHE_FILE, JSON.stringify(envelope));
            this.dirty = false;
        } catch (err) {
            logger.warn(`[EmbeddingCache] Failed to save cache: ${(err as Error).message}`);
        }
    }

    get size(): number {
        return this.cache.size;
    }
}

let _cache: EmbeddingCache | null = null;
function getCache(): EmbeddingCache {
    if (!_cache) _cache = EmbeddingCache.load();
    return _cache;
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

async function fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = MAX_RETRIES,
): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) return response;

            if (response.status >= 500 && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                logger.warn(`[Ollama] HTTP ${response.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        } catch (err) {
            if (attempt < retries && (
                (err instanceof Error && err.name === 'AbortError') ||
                (err instanceof Error && err.message.includes('fetch failed'))
            )) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                logger.warn(`[Ollama] ${(err as Error).message}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`[Ollama] All ${retries} retries exhausted`);
}

// ─── Single Embedding (backward compatible) ──────────────────────────────────

export async function generateEmbedding(text: string): Promise<number[] | null> {
    const config = configManager.getAiConfig('ingest');
    const cache = getCache();
    const provider = config.embeddingProvider || config.provider;
    const model = config.embeddingModel;
    const hash = hashText(text, provider, model);

    const cached = cache.get(hash);
    if (cached) return cached;

    const resolved = resolveAISdkEmbeddingModel(config);

    if (resolved) {
        try {
            const { embedding, usage } = await withTimeout(
                embed({
                    model: resolved.model,
                    value: text,
                    ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions as any } : {}),
                }),
                TIMEOUT_MS,
                `embed(${model})`,
            );
            if (usage && usage.tokens) {
                telemetryCollector.addEmbeddingTokens(usage.tokens);
            }
            const result = resolved.needsNormalization ? l2Normalize(embedding) : embedding;
            cache.set(hash, result);
            cache.save();
            return result;
        } catch (err) {
            logger.warn(`[Embedding] Generation error: ${(err as Error).message}`);
            return null;
        }
    }

    const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const ollamaEmbModel = model || process.env.OLLAMA_EMBEDDING_MODEL || 'qwen2.5-coder:7b';
    try {
        const response = await fetchWithRetry(`${ollamaBase}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ollamaEmbModel, prompt: text }),
        });

        const data = await response.json() as { embedding: number[] };

        if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
            logger.warn('[Ollama] Empty or invalid embedding response');
            return null;
        }

        telemetryCollector.addEmbeddingTokens(Math.ceil(text.length / 4));

        cache.set(hash, data.embedding);
        cache.save();
        return data.embedding;
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            logger.warn(`[Ollama] Embedding generation timed out (${TIMEOUT_MS}ms)`);
        } else {
            logger.warn(`[Ollama] Embedding generation error: ${(err as Error).message}`);
        }
        return null;
    }
}

// ─── Batch Embedding ─────────────────────────────────────────────────────────

export async function generateEmbeddingsBatch(
    texts: string[],
): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await generateEmbedding(texts[0])];

    const config = configManager.getAiConfig('ingest');
    const cache = getCache();
    const provider = config.embeddingProvider || config.provider;
    const model = config.embeddingModel;
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const misses: { index: number; text: string; hash: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
        const hash = hashText(texts[i], provider, model);
        const cached = cache.get(hash);
        if (cached) {
            results[i] = cached;
        } else {
            misses.push({ index: i, text: texts[i], hash });
        }
    }

    if (misses.length === 0) return results;

    const resolved = resolveAISdkEmbeddingModel(config);

    if (resolved) {
        try {
            const { embeddings, usage } = await withTimeout(
                embedMany({
                    model: resolved.model,
                    values: misses.map(m => m.text),
                    ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions as any } : {}),
                }),
                TIMEOUT_MS,
                `embedMany(${model}, ${misses.length} items)`,
            );
            if (usage && usage.tokens) {
                telemetryCollector.addEmbeddingTokens(usage.tokens);
            }
            for (let j = 0; j < misses.length; j++) {
                const result = resolved.needsNormalization ? l2Normalize(embeddings[j]) : embeddings[j];
                results[misses[j].index] = result;
                cache.set(misses[j].hash, result);
            }
            cache.save();
            return results;
        } catch (err) {
            // Quota pressure: the per-item fallback would turn 1 failed
            // request into N failed requests against the same exhausted
            // quota. Skip it; the graph simply stores no embedding for
            // these functions (recomputed on the next run, cache-first).
            if (isRateLimitError(err)) {
                logger.warn(
                    `[Embedding] Batch rate-limited; skipping ${misses.length} embeddings `
                    + `(per-item fallback suppressed under quota pressure)`,
                );
                return results;
            }
            logger.warn(`[Embedding] Batch embedding failed, falling back to individual: ${(err as Error).message}`);
        }
    } else {
        try {
            const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
            const ollamaEmbModel = model || process.env.OLLAMA_EMBEDDING_MODEL || 'qwen2.5-coder:7b';
            const response = await fetchWithRetry(`${ollamaBase}/api/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ollamaEmbModel,
                    input: misses.map(m => m.text),
                }),
            });

            const data = await response.json() as { embeddings: number[][] };

            if (Array.isArray(data.embeddings) && data.embeddings.length === misses.length) {
                const totalChars = misses.reduce((acc, m) => acc + m.text.length, 0);
                telemetryCollector.addEmbeddingTokens(Math.ceil(totalChars / 4));

                for (let j = 0; j < misses.length; j++) {
                    const embedding = data.embeddings[j];
                    if (Array.isArray(embedding) && embedding.length > 0) {
                        results[misses[j].index] = embedding;
                        cache.set(misses[j].hash, embedding);
                    }
                }
                cache.save();
                return results;
            }
        } catch (err) {
            logger.warn(`[Ollama] Batch embedding failed, falling back to individual: ${(err as Error).message}`);
        }
    }

    for (const miss of misses) {
        if (results[miss.index] === null) {
            results[miss.index] = await generateEmbedding(miss.text);
        }
    }

    return results;
}

export function flushEmbeddingCache(): void {
    if (_cache) _cache.save();
}
