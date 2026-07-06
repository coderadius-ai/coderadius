import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// Import config manager (which is a singleton)
import { configManager } from '../../../src/config/index.js';

describe('ConfigManager', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        // Delete all relevant env vars to start clean
        delete process.env.MODEL_PROVIDER;
        delete process.env.MODEL_NAME;
        delete process.env.EMBEDDING_MODEL;
        delete process.env.GOOGLE_VERTEX_LOCATION;
        delete process.env.GOOGLE_VERTEX_PROJECT;
        delete process.env.MODEL_PROVIDER_CHAT;
        delete process.env.MODEL_NAME_CHAT;
        delete process.env.EMBEDDING_MODEL_CHAT;

        vi.spyOn(fs, 'existsSync').mockReturnValue(false);
        vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');

        // Force reload to clear any previously loaded state
        configManager.reload();
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    function mockSettingsJson(configObj: any) {
        vi.spyOn(fs, 'existsSync').mockImplementation((filePath: string | Buffer | URL) => {
            if (filePath.toString().includes('settings.json')) return true;
            return false;
        });
        vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: string | Buffer | URL | number) => {
            if (filePath.toString().includes('settings.json')) return JSON.stringify(configObj);
            return '{}';
        });
        configManager.reload();
    }

    describe('tier resolution', () => {
        it('should map fast-tier contexts to the fast built-in default', () => {
            for (const action of [undefined, 'ingest', 'mcp'] as const) {
                const config = configManager.getAiConfig(action);
                expect(config.provider).toBe('vertex');
                expect(config.model).toBe('gemini-3.1-flash-lite');
            }
        });

        it('should map smart-tier contexts (chat, doc) to the smart built-in default', () => {
            for (const action of ['chat', 'doc'] as const) {
                const config = configManager.getAiConfig(action);
                expect(config.provider).toBe('vertex');
                expect(config.model).toBe('gemini-3.1-pro');
            }
        });

        it('should NOT let ai.fast shadow smart-tier contexts', () => {
            // Regression: a generic file-level default used to override the
            // doc/chat quality defaults, silently downgrading them.
            mockSettingsJson({
                ai: {
                    fast: 'vertex/gemini-3.1-flash-lite'
                }
            });

            expect(configManager.getAiConfig('doc').model).toBe('gemini-3.1-pro');
            expect(configManager.getAiConfig('chat').model).toBe('gemini-3.1-pro');
            expect(configManager.getAiConfig('ingest').model).toBe('gemini-3.1-flash-lite');
        });

        it('should apply ai.smart to smart-tier contexts only', () => {
            mockSettingsJson({
                ai: {
                    smart: 'anthropic/claude-sonnet-4-20250514'
                }
            });

            expect(configManager.getAiConfig('doc').provider).toBe('anthropic');
            expect(configManager.getAiConfig('doc').model).toBe('claude-sonnet-4-20250514');
            expect(configManager.getAiConfig('chat').model).toBe('claude-sonnet-4-20250514');
            // Fast tier untouched
            expect(configManager.getAiConfig('ingest').provider).toBe('vertex');
            expect(configManager.getAiConfig('ingest').model).toBe('gemini-3.1-flash-lite');
        });

        it('should let a per-action override beat its tier', () => {
            mockSettingsJson({
                ai: {
                    smart: 'vertex/gemini-3.1-pro',
                    chat: 'vertex/gemini-3.5-flash'
                }
            });

            expect(configManager.getAiConfig('chat').model).toBe('gemini-3.5-flash');
            expect(configManager.getAiConfig('doc').model).toBe('gemini-3.1-pro');
        });

        it('should parse provider/model string from ai.fast', () => {
            mockSettingsJson({
                ai: {
                    fast: 'openai/gpt-4o'
                }
            });

            const config = configManager.getAiConfig();
            expect(config.provider).toBe('openai');
            expect(config.model).toBe('gpt-4o');
        });
    });

    describe('provenance', () => {
        it('should report built-in tier as the source when nothing is configured', () => {
            const resolved = configManager.resolveAiConfig('doc');
            expect(resolved.tier).toBe('smart');
            expect(resolved.sources.model).toBe('built-in (smart)');
        });

        it('should report the file tier key as the source', () => {
            mockSettingsJson({
                ai: {
                    fast: 'vertex/gemini-3.1-flash-lite',
                    smart: 'vertex/gemini-3.1-pro'
                }
            });

            expect(configManager.resolveAiConfig('ingest').sources.model).toBe('ai.fast');
            expect(configManager.resolveAiConfig('doc').sources.model).toBe('ai.smart');
        });

        it('should report the per-action key as the source when it wins', () => {
            mockSettingsJson({
                ai: {
                    smart: 'vertex/gemini-3.1-pro',
                    chat: 'vertex/gemini-3.5-flash'
                }
            });

            expect(configManager.resolveAiConfig('chat').sources.model).toBe('ai.chat');
        });

        it('should report env as the source when an env var wins', () => {
            mockSettingsJson({
                ai: {
                    fast: 'vertex/gemini-3.1-flash-lite'
                }
            });
            process.env.MODEL_NAME = 'anthropic/claude-3-opus';

            expect(configManager.resolveAiConfig('ingest').sources.model).toBe('env');
        });
    });

    it('should parse ai.embedding into embeddingProvider and embeddingModel', () => {
        mockSettingsJson({
            ai: {
                embedding: 'openai/text-embedding-3-small'
            }
        });

        const config = configManager.getAiConfig();
        expect(config.embeddingProvider).toBe('openai');
        expect(config.embeddingModel).toBe('text-embedding-3-small');
    });

    it('should correctly merge vertex project and location from providers block', () => {
        mockSettingsJson({
            ai: {
                fast: 'vertex/gemini-3.1-pro',
                providers: {
                    vertex: {
                        project: 'test-gcp-project',
                        location: 'europe-west1'
                    }
                }
            }
        });

        const config = configManager.getAiConfig();
        expect(config.provider).toBe('vertex');
        expect(config.model).toBe('gemini-3.1-pro');
        expect(config.project).toBe('test-gcp-project');
        expect(config.location).toBe('europe-west1');
    });

    it('should load provider/model format from general environment variables', () => {
        process.env.MODEL_NAME = 'ollama/llama-3.1';
        process.env.EMBEDDING_MODEL = 'ollama/nomic-embed-text';

        const config = configManager.getAiConfig();
        expect(config.provider).toBe('ollama');
        expect(config.model).toBe('llama-3.1');
        expect(config.embeddingProvider).toBe('ollama');
        expect(config.embeddingModel).toBe('nomic-embed-text');
    });

    it('should allow MODEL_PROVIDER env var to override the parsed provider from MODEL_NAME', () => {
        process.env.MODEL_NAME = 'openai/gpt-4o'; // Provides openai
        process.env.MODEL_PROVIDER = 'anthropic';   // Overrides to anthropic

        const config = configManager.getAiConfig();
        expect(config.provider).toBe('anthropic');
        expect(config.model).toBe('gpt-4o');
    });

    it('should load action-specific environment variables', () => {
        process.env.MODEL_NAME = 'vertex/gemini-3.1-flash';
        process.env.MODEL_NAME_CHAT = 'openai/o1-mini';

        const defaultConfig = configManager.getAiConfig();
        expect(defaultConfig.provider).toBe('vertex');
        expect(defaultConfig.model).toBe('gemini-3.1-flash');

        const chatConfig = configManager.getAiConfig('chat');
        expect(chatConfig.provider).toBe('openai');
        expect(chatConfig.model).toBe('o1-mini');
    });

    it('should prioritize environment variables over settings.json', () => {
        mockSettingsJson({
            ai: {
                fast: 'openai/gpt-4',
                providers: {
                    vertex: {
                        project: 'json-project',
                        location: 'json-location'
                    }
                }
            }
        });

        process.env.MODEL_NAME = 'anthropic/claude-3-opus';
        process.env.GOOGLE_VERTEX_PROJECT = 'env-project';

        const config = configManager.getAiConfig();
        expect(config.provider).toBe('anthropic');
        expect(config.model).toBe('claude-3-opus');
        expect(config.project).toBe('env-project');

        // Ensure location was still merged from settings.json since env var didn't override it
        expect(config.location).toBe('json-location');
    });

    it('should bridge bedrock region to location field', () => {
        mockSettingsJson({
            ai: {
                fast: 'bedrock/openai.gpt-oss-20b-1:0',
                providers: {
                    bedrock: {
                        region: 'eu-west-1'
                    }
                }
            }
        });

        const config = configManager.getAiConfig();
        expect(config.provider).toBe('bedrock');
        expect(config.model).toBe('openai.gpt-oss-20b-1:0');
        expect(config.location).toBe('eu-west-1');
    });

    it('should allow AWS_REGION env var to override bedrock region from settings', () => {
        mockSettingsJson({
            ai: {
                fast: 'bedrock/some-model',
                providers: {
                    bedrock: {
                        region: 'eu-west-1'
                    }
                }
            }
        });

        process.env.GOOGLE_VERTEX_LOCATION = 'us-east-1';

        const config = configManager.getAiConfig();
        expect(config.location).toBe('us-east-1');
    });

    it('should exit the process with exit code 1 when the configuration schema is invalid', () => {
        const exitMock = vi.spyOn(process, 'exit').mockImplementation((() => { }) as any);
        const errorMock = vi.spyOn(console, 'error').mockImplementation(() => { });

        mockSettingsJson({
            ai: {
                fast: { provider: 'vertex' } // Invalid: should be a string, not an object
            }
        });

        configManager.getAiConfig();

        expect(exitMock).toHaveBeenCalledWith(1);
        expect(errorMock).toHaveBeenCalled();
    });
});
