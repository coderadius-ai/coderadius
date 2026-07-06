import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Characterization pins for buildSymbolRegistryForRepo — the
// cache/LLM/persistence lifecycle that had zero coverage. Each case pins ONE
// decision of the orchestrator (symbol-extraction.ts:567-772) and of
// buildTargetPlan (:223-301). Hermetic: temp-dir fixture repos, scripted
// agents, in-memory config-symbols mutations.

const h = vi.hoisted(() => {
    const state = {
        stored: [] as Array<Record<string, unknown>>,
        cache: {} as Record<string, unknown>,
        softDeleted: [] as Array<{ keys: string[]; qName: string; commit: string }>,
        dependents: new Map<string, string[]>(),
        envDict: new Map<string, { value: string; sourceFile: string; confidence: number }>(),
        scoutCalls: 0,
        scoutImpl: null as ((csv: string) => unknown) | null,
        extractCalls: [] as string[],
        extractImpl: null as ((input: string) => unknown) | null,
    };
    return { state };
});

vi.mock('../../../src/graph/mutations/config-symbols.js', () => ({
    backfillConfigSymbolDefaults: vi.fn(async () => {}),
    loadConfigSymbols: vi.fn(async () => h.state.stored),
    loadRegistryCache: vi.fn(async (qName: string) => ({ symbolCacheState: h.state.cache[qName] ?? null })),
    loadSymbolDependentsBatch: vi.fn(async (keys: string[]) => {
        const out = new Map<string, string[]>();
        for (const k of keys) if (h.state.dependents.has(k)) out.set(k, h.state.dependents.get(k)!);
        return out;
    }),
    saveSymbolExtractionCacheState: vi.fn(async (qName: string, cacheState: unknown) => {
        h.state.cache[qName] = cacheState;
    }),
    softDeleteSymbols: vi.fn(async (keys: string[], qName: string, commit: string) => {
        h.state.softDeleted.push({ keys, qName, commit });
    }),
}));

vi.mock('../../../src/ai/mastra/index.js', () => ({
    getMastra: () => ({
        getAgent: (name: string) => ({
            generate: async (input: string) => {
                if (name === 'infraDiscoveryAgent') {
                    h.state.scoutCalls++;
                    if (h.state.scoutImpl) return h.state.scoutImpl(input);
                    return { object: { target_files: [] }, usage: {} };
                }
                h.state.extractCalls.push(input.split('\n')[0].replace('File: ', ''));
                if (h.state.extractImpl) return h.state.extractImpl(input);
                return { object: { bindings: [] }, usage: {} };
            },
        }),
    }),
}));

vi.mock('../../../src/config/repo-context.js', () => ({
    loadRepoContext: () => ({
        hints: { databases: [], decorators: [], hints: [] },
        identities: [],
        envVarDict: h.state.envDict,
    }),
}));

import { buildSymbolRegistryForRepo, extractSymbolFile, classifySymbolTarget } from '../../../src/ingestion/core/symbol-extraction.js';
import type { ResolvedRepo } from '../../../src/graph/types.js';

const DOCTRINE_PATH = 'config/doctrine.yaml';
const DOCTRINE_CONTENT = 'doctrine:\n  dbal:\n    connections:\n      default: { url: "%env(DATABASE_URL)%" }\n';
const MESSAGING_PHP_PATH = 'config/messaging.php';
const MESSAGING_PHP_CONTENT = `<?php
$container->register('acme.order.publisher', \\Acme\\Order\\OrderPublisher::class)
    ->addTag('messenger.publisher', ['queue' => 'acme.order.created']);
`;

const ORDERS_BINDING = { diKey: 'acme.orders.connection', physicalName: 'orders_db', category: 'database', technology: 'postgres' };

let repoDir: string;

function writeRepo(files: Record<string, string>): ResolvedRepo {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(repoDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return { name: 'inventory', org: 'acme', path: repoDir, commit: 'C1' } as ResolvedRepo;
}

function extractReturns(bindings: Array<Record<string, unknown>>): void {
    h.state.extractImpl = () => ({ object: { bindings }, usage: {} });
}

async function build(repo: ResolvedRepo, over: Record<string, unknown> = {}) {
    return buildSymbolRegistryForRepo({ repo, persistCacheState: true, ...over });
}

beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symreg-'));
    h.state.stored = [];
    h.state.cache = {};
    h.state.softDeleted = [];
    h.state.dependents = new Map();
    h.state.envDict = new Map();
    h.state.scoutCalls = 0;
    h.state.scoutImpl = null;
    h.state.extractCalls = [];
    h.state.extractImpl = null;
});

afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('buildSymbolRegistryForRepo — fresh build', () => {
    it('extracts a deterministic-classified config target via the LLM and persists a healthy cache state', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        extractReturns([ORDERS_BINDING]);

        const result = await build(repo);

        expect(h.state.extractCalls).toEqual([DOCTRINE_PATH]);
        expect(result.registry.getAll().map(b => b.key)).toContain('acme.orders.connection');
        expect(result.diagnostics).toMatchObject({ added: 1, llmCalls: 1, cacheHits: 0, failed: 0 });
        expect(result.status).toBe('healthy');
        expect(result.cacheState.sources[DOCTRINE_PATH]).toMatchObject({ status: 'success' });
        expect(h.state.cache['acme/inventory']).toBe(result.cacheState);
    });

    it('resolves env templates in extracted physical names against the repo env dict', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        h.state.envDict.set('ORDERS_DB_NAME', { value: 'orders_production', sourceFile: '.env', confidence: 0.9 });
        extractReturns([{ ...ORDERS_BINDING, physicalName: '%env(ORDERS_DB_NAME)%' }]);

        const result = await build(repo);

        const binding = result.registry.getAll().find(b => b.key === 'acme.orders.connection');
        expect(binding?.resolvedValue).toBe('orders_production');
        expect(result.diagnostics.envResolved).toBe(1);
    });
});

describe('buildSymbolRegistryForRepo — cache lifecycle', () => {
    it('second unchanged run hits the plan cache and the per-file cache: zero LLM activity', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        extractReturns([ORDERS_BINDING]);
        await build(repo);
        h.state.extractCalls = [];

        const result = await build(repo);

        expect(h.state.scoutCalls).toBe(0);
        expect(h.state.extractCalls).toEqual([]);
        expect(result.diagnostics).toMatchObject({ cacheHits: 1, llmCalls: 0 });
        expect(result.registry.getAll().map(b => b.key)).toContain('acme.orders.connection');
    });

    it('a content change re-extracts only the changed file', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT, [MESSAGING_PHP_PATH]: MESSAGING_PHP_CONTENT });
        extractReturns([ORDERS_BINDING]);
        await build(repo);
        h.state.extractCalls = [];

        fs.writeFileSync(path.join(repoDir, DOCTRINE_PATH), DOCTRINE_CONTENT + '      replica: { url: "%env(REPLICA_URL)%" }\n');
        const result = await build(repo);

        expect(h.state.extractCalls).toEqual([DOCTRINE_PATH]);
        expect(result.diagnostics).toMatchObject({ changed: 1, llmCalls: 1 });
    });

    it('an extractor-version bump invalidates the per-file cache even with unchanged content', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        extractReturns([ORDERS_BINDING]);
        await build(repo);
        h.state.extractCalls = [];
        const saved = h.state.cache['acme/inventory'] as { sources: Record<string, { extractorVersion: string }> };
        saved.sources[DOCTRINE_PATH].extractorVersion = 'config-symbol-extractor-v0';

        const result = await build(repo);

        expect(h.state.extractCalls).toEqual([DOCTRINE_PATH]);
        expect(result.diagnostics.llmCalls).toBe(1);
    });
});

describe('buildSymbolRegistryForRepo — failure handling', () => {
    it('extractor failure on a previously-cached file preserves the previous bindings as partial', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        extractReturns([ORDERS_BINDING]);
        await build(repo);

        fs.writeFileSync(path.join(repoDir, DOCTRINE_PATH), DOCTRINE_CONTENT + '# changed\n');
        h.state.extractImpl = () => { throw new Error('schema mismatch'); };
        const result = await build(repo);

        expect(result.status).toBe('partial');
        expect(result.diagnostics.failed).toBe(1);
        expect(result.cacheState.sources[DOCTRINE_PATH]).toMatchObject({ status: 'partial', error: 'schema mismatch' });
        expect(result.registry.getAll().map(b => b.key)).toContain('acme.orders.connection');
    });

    it('extractor failure on a brand-new file records a failed source with no bindings', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        h.state.extractImpl = () => { throw new Error('llm schema mismatch'); };

        const result = await build(repo);

        expect(result.cacheState.sources[DOCTRINE_PATH]).toMatchObject({ status: 'failed', rawBindings: [] });
        expect(result.status).toBe('partial');
    });

    it('the target plan is fully deterministic: no scout agent is ever requested', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT, '.env': 'DATABASE_URL=postgres://orders\n' });
        extractReturns([ORDERS_BINDING]);

        const result = await build(repo);

        expect(h.state.scoutCalls).toBe(0);
        expect(result.targetPlan.targets.map(t => t.path)).toEqual([DOCTRINE_PATH]);
        expect(h.state.extractCalls).toEqual([DOCTRINE_PATH]);
        expect(result.status).toBe('healthy');
    });
});

describe('buildSymbolRegistryForRepo — target planning', () => {
    it('the target plan hash is stable across rebuilds of an unchanged repo', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT, '.env': 'DATABASE_URL=postgres://orders\n' });
        extractReturns([ORDERS_BINDING]);

        const first = await build(repo, { fresh: true });
        const second = await build(repo, { fresh: true });

        expect(second.targetPlan.targetPlanHash).toBe(first.targetPlan.targetPlanHash);
        expect(second.targetPlan.candidateInventoryHash).toBe(first.targetPlan.candidateInventoryHash);
    });

    it('a provider-parseable PHP config takes the deterministic pre-pass: no LLM call, binding registered', async () => {
        const repo = writeRepo({ [MESSAGING_PHP_PATH]: MESSAGING_PHP_CONTENT });

        const result = await build(repo);

        expect(h.state.extractCalls).toEqual([]);
        expect(result.diagnostics.llmCalls).toBe(0);
        const binding = result.registry.getAll().find(b => b.key === 'acme.order.publisher');
        expect(binding).toMatchObject({ physicalName: 'acme.order.created', technology: 'rabbitmq' });
    });
});

describe('buildSymbolRegistryForRepo — diff, taint, deletion', () => {
    it('a stored symbol whose source is gone is soft-deleted and its dependents tainted', async () => {
        const repo = writeRepo({ [MESSAGING_PHP_PATH]: MESSAGING_PHP_CONTENT });
        h.state.stored = [{
            key: 'acme.legacy.connection', value: 'legacy_db', resolvedValue: 'legacy_db',
            rawValue: 'legacy_db', category: 'database', sourceFile: 'config/removed.yaml',
            extractorVersion: 'config-symbol-extractor-v2',
        }];
        h.state.dependents.set('acme.legacy.connection', ['src/orders/LegacyRepository.php']);

        const result = await build(repo);

        expect(h.state.softDeleted).toEqual([
            { keys: ['acme.legacy.connection'], qName: 'acme/inventory', commit: 'C1' },
        ]);
        expect([...result.taintedFiles]).toEqual(['src/orders/LegacyRepository.php']);
    });

    it('opaque failure with legacy stored symbols preserves them and suppresses deletions', async () => {
        const repo = writeRepo({ [DOCTRINE_PATH]: DOCTRINE_CONTENT });
        h.state.stored = [{
            key: 'acme.legacy.connection', value: 'legacy_db', resolvedValue: 'legacy_db',
            rawValue: 'legacy_db', category: 'database', sourceFile: 'legacy',
            extractorVersion: 'config-symbol-extractor-v2',
        }];
        h.state.extractImpl = () => { throw new Error('llm schema mismatch'); };

        const result = await build(repo);

        expect(result.registry.getAll().map(b => b.key)).toContain('acme.legacy.connection');
        expect(h.state.softDeleted).toEqual([]);
    });
});

describe('buildSymbolRegistryForRepo — manual symbols', () => {
    it('registers coderadius.yaml manual symbols with manual confidence', async () => {
        const repo = writeRepo({ [MESSAGING_PHP_PATH]: MESSAGING_PHP_CONTENT });

        const result = await build(repo, {
            manualSymbols: [{ key: 'acme.payments.queue', value: 'acme.payment.requested' }],
        });

        const manual = result.registry.getAll().find(b => b.key === 'acme.payments.queue');
        expect(manual).toMatchObject({
            value: 'acme.payment.requested',
            sourceFile: 'coderadius.yaml',
            confidence: 'manual',
        });
    });
});

describe('classifySymbolTarget — branch matrix', () => {
    it.each([
        ['config/doctrine.yaml', 'symbol_config'],
        ['config/packages/messenger.yaml', 'symbol_config'],
        ['app/config/services.php', 'symbol_config'],
        ['.env', 'env_source'],
        ['.env.production', 'env_source'],
        ['src/orders/order.entity.ts', 'orm_schema'],
        ['prisma/schema.prisma', 'orm_schema'],
        ['vitest.config.ts', 'ignored'],
        ['webpack.config.js', 'ignored'],
        ['tests/fixtures/doctrine.yaml', 'ignored'],
        ['src/orders/order-service.ts', 'regular_source'],
        ['src/config/database.config.ts', 'symbol_config'],
        ['src/orders/queue.module.ts', 'symbol_config'],
    ] as const)('%s → %s', (relPath, expected) => {
        expect(classifySymbolTarget(relPath)).toBe(expected);
    });
});

describe('extractSymbolFile — input guards', () => {
    it('rejects missing paths, directories and oversized files before any LLM call', async () => {
        const repo = writeRepo({ 'config/dir-marker/doctrine.yaml': 'x', 'config/huge.yaml': 'k: v\n'.repeat(110_000) });

        await expect(extractSymbolFile(repo, 'config/missing.yaml')).rejects.toThrow('file not found');
        await expect(extractSymbolFile(repo, 'config/dir-marker')).rejects.toThrow('not a file');
        await expect(extractSymbolFile(repo, 'config/huge.yaml')).rejects.toThrow('file too large');
        expect(h.state.extractCalls).toEqual([]);
    });

    it('normalizes windows-style and leading-slash paths to repo-relative form', async () => {
        const repo = writeRepo({ 'config/doctrine.yaml': 'doctrine: {}\n' });
        extractReturns([ORDERS_BINDING]);

        const result = await extractSymbolFile(repo, '/config\\doctrine.yaml');

        expect(result.relPath).toBe('config/doctrine.yaml');
        expect(result.bindings.map(b => b.diKey)).toEqual(['acme.orders.connection']);
    });
});
