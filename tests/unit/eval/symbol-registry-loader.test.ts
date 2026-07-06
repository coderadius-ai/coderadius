import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
    mockExistsSync: vi.fn(() => false),
    mockReadFileSync: vi.fn(() => ''),
    mockStatSync: vi.fn(() => ({ size: 100, isFile: () => true })),
}));

vi.mock('node:fs', () => ({
    default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync, statSync: mockStatSync },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    statSync: mockStatSync,
}));
vi.mock('../../../src/graph/mutations/config-symbols.js', () => ({
    backfillConfigSymbolDefaults: vi.fn().mockResolvedValue(undefined),
    loadConfigSymbols: vi.fn(),
}));
vi.mock('../../../src/ai/mastra/index.js', () => ({
    getMastra: vi.fn(),
}));
vi.mock('../../../src/ai/agents/config-symbol-extractor.js', () => ({
    ConfigSymbolExtractionSchema: {},
}));
vi.mock('../../../src/config/repo-context.js', () => ({
    loadRepoContext: vi.fn(() => ({ envVarDict: new Map() })),
}));
vi.mock('../../../src/telemetry/index.js', () => ({
    telemetryCollector: { addTokensForPhase: vi.fn(), incrementLLMInvocations: vi.fn() },
    traceCollector: { traceResolution: vi.fn() },
}));
vi.mock('../../../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { loadConfigSymbols } from '../../../src/graph/mutations/config-symbols.js';
import { getMastra } from '../../../src/ai/mastra/index.js';
import { loadRepoContext } from '../../../src/config/repo-context.js';
import { loadHybridRegistry } from '../../../src/eval/symbol-registry-loader.js';

const mockLoadSymbols = loadConfigSymbols as ReturnType<typeof vi.fn>;
const mockGetMastra = getMastra as ReturnType<typeof vi.fn>;
const mockLoadRepoContext = loadRepoContext as ReturnType<typeof vi.fn>;

// ─── loadHybridRegistry ───────────────────────────────────────────────────────

describe('loadHybridRegistry', () => {
    let mockGenerate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadSymbols.mockResolvedValue([]);
        mockExistsSync.mockReturnValue(false);
        mockStatSync.mockReturnValue({ size: 100, isFile: () => true });
        mockReadFileSync.mockReturnValue('');
        mockLoadRepoContext.mockReturnValue({ envVarDict: new Map() });
        
        mockGenerate = vi.fn().mockResolvedValue({ usage: {}, object: { bindings: [] } });
        mockGetMastra.mockReturnValue({
            getAgent: vi.fn().mockReturnValue({
                generate: mockGenerate,
            }),
        });
    });

    it('loads symbols from DB and returns a populated registry', async () => {
        mockLoadSymbols.mockResolvedValue([
            { key: 'App\\OrderService', value: 'order-service', category: 'di_service' },
            { key: 'App\\PaymentService', value: 'payment-service', category: 'di_service' },
        ]);

        const registry = await loadHybridRegistry({ repoName: 'my-repo', repoRoot: '/repo', changedFiles: [] });

        expect(registry.size).toBe(2);
        expect(registry.resolve('App\\OrderService')).toBeDefined();
    });

    it('returns a registry with zero size when DB has no symbols', async () => {
        const registry = await loadHybridRegistry({ repoName: 'my-repo', repoRoot: '/repo', changedFiles: [] });
        expect(registry.size).toBe(0);
    });

    it('skips re-extraction when no config files are in changedFiles', async () => {
        mockLoadSymbols.mockResolvedValue([{ key: 'App\\Svc', value: 'svc', category: 'di_service' }]);

        await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['src/Controller.php', 'src/Service.ts'],
        });

        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('skips re-extraction for ORM/entity-only changes', async () => {
        mockLoadSymbols.mockResolvedValue([{ key: 'App\\Svc', value: 'svc', category: 'di_service' }]);

        await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['src/entities/User.entity.ts'],
        });

        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('resolves env-only changes without calling the extractor', async () => {
        mockLoadSymbols.mockResolvedValue([
            { key: 'DB_NAME', value: '{DATABASE_NAME}', rawValue: '{DATABASE_NAME}', resolvedValue: '{DATABASE_NAME}', category: 'env_var' },
        ]);
        mockLoadRepoContext.mockReturnValue({
            envVarDict: new Map([
                ['DATABASE_NAME', { value: 'prod-db', sourceFile: '.env.example', confidence: 0.8 }],
            ]),
        });

        const registry = await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['.env.example'],
        });

        expect(mockGenerate).not.toHaveBeenCalled();
        expect(registry.resolve('DB_NAME')!.value).toBe('prod-db');
    });

    it('triggers re-extraction when a YAML config file is in changedFiles and exists on disk', async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 500, isFile: () => true });
        mockReadFileSync.mockReturnValue('services:');
        mockGenerate.mockResolvedValue({
            usage: {},
            object: { bindings: [{ diKey: 'App\\NewService', physicalName: 'new-svc', category: 'di_service' }] },
        });

        const registry = await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/services.yaml'],
        });

        expect(mockGenerate).toHaveBeenCalled();
        expect(registry.size).toBe(1);
        expect(registry.resolve('App\\NewService')).toBeDefined();
    });

    it('triggers re-extraction for AmqpConfig.php (contains "amqp" in name)', async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100, isFile: () => true });
        mockGenerate.mockResolvedValue({ usage: {}, object: { bindings: [] } });

        await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['src/AmqpConfig.php'],
        });

        expect(mockGenerate).toHaveBeenCalled();
    });

    it('skips calling generate() for config files not found on disk', async () => {
        mockExistsSync.mockReturnValue(false); // file not on disk
        mockGenerate.mockReset(); // or just assign a new vi.fn() if preferred, but not strictly needed 
        // We'll just leave mockGenerate as is since it's already a vi.fn()
        // Wait, the test states: 'The agent is instantiated ... but generate() is never called'
        // That mock is already created in beforeEach

        await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/services.yaml'],
        });

        // The agent is instantiated (pattern matched) but generate() is never called
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('skips re-extraction when config file exceeds size limit', async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 600 * 1024, isFile: () => true }); // > 512KB

        await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/huge.yaml'],
        });

        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('continues with DB registry when LLM re-extraction fails', async () => {
        mockLoadSymbols.mockResolvedValue([{ key: 'App\\Svc', value: 'svc', category: 'di_service' }]);
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100, isFile: () => true });
        mockGenerate.mockRejectedValue(new Error('LLM internal error'));

        const registry = await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/services.yaml'],
        });

        expect(registry.size).toBe(1);
    });

    it('merges re-extracted bindings on top of DB registry', async () => {
        mockLoadSymbols.mockResolvedValue([{ key: 'App\\OldKey', value: 'old-value', category: 'di_service' }]);
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100, isFile: () => true });
        mockGenerate.mockResolvedValue({
            usage: {},
            object: { bindings: [{ diKey: 'App\\NewKey', physicalName: 'new-value', category: 'di_service' }] },
        });

        const registry = await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/services.yaml'],
        });

        expect(registry.size).toBe(2);
        expect(registry.resolve('App\\OldKey')).toBeDefined();
        expect(registry.resolve('App\\NewKey')).toBeDefined();
    });

    it('handles empty bindings array from LLM without error', async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 100, isFile: () => true });
        mockGenerate.mockResolvedValue({ usage: {}, object: { bindings: [] } });

        const registry = await loadHybridRegistry({
            repoName: 'my-repo',
            repoRoot: '/repo',
            changedFiles: ['config/services.yaml'],
        });

        expect(registry.size).toBe(0);
    });
});
