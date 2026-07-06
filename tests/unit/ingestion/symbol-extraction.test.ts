import { describe, it, expect } from 'vitest';
import {
    classifySymbolTarget,
    computeSymbolDiff,
    resolveRawSymbolValue,
} from '../../../src/ingestion/core/symbol-extraction.js';
import type { EnvVarBinding } from '../../../src/ingestion/processors/infra-manifest-resolver.js';
import type { StoredConfigSymbol } from '../../../src/graph/mutations/config-symbols.js';
import type { SymbolBinding } from '../../../src/ingestion/core/symbol-registry.js';

describe('symbol-extraction target classification', () => {
    it('keeps ORM entities out of the Symbol Extractor', () => {
        expect(classifySymbolTarget('src/entities/User.entity.ts')).toBe('orm_schema');
        expect(classifySymbolTarget('src/Entity/PolicyEntity.php')).toBe('orm_schema');
    });

    it('keeps infra DB schema modules in the Symbol Extractor', () => {
        expect(classifySymbolTarget('apps/console/src/infrastructure/database/WarrantyDbSchema.module.ts')).toBe('symbol_config');
        expect(classifySymbolTarget('apps/api/src/infrastructure/messageBus/provider/MessageBus.provider.ts')).toBe('symbol_config');
    });

    it('does not classify every infrastructure source file as symbol config', () => {
        expect(classifySymbolTarget('src/infrastructure/cms/CmsRepository.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/console/src/infrastructure/database/SynchronizeDb.service.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/console/src/infrastructure/database/SynchronizeDbService.interface.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/api/src/infrastructure/partialQuote/builder/PartialQuote.builder.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/api/src/infrastructure/partialQuote/PartialQuote.module.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/console/src/infrastructure/App.module.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/api/src/infrastructure/quote/provider/CloseQuoteUsecase.provider.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/api/src/infrastructure/cmb/provider/InitCmbUsecase.provider.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/event-consumer/src/infrastructure/quote/quoteReady.consumer.ts')).toBe('regular_source');
        expect(classifySymbolTarget('apps/event-consumer/.http/rabbitmq.http')).toBe('regular_source');
        expect(classifySymbolTarget('apps/api/config/vitest.unit.config.ts')).toBe('ignored');
    });

    it('classifies known config and env files separately', () => {
        expect(classifySymbolTarget('config/services.yaml')).toBe('symbol_config');
        expect(classifySymbolTarget('db/connections.json')).toBe('symbol_config');
        expect(classifySymbolTarget('src/datasource/config.xml')).toBe('symbol_config');
        expect(classifySymbolTarget('.env.example')).toBe('env_source');
    });

    it('ignores enterprise cache/test dependency directories without substring false positives', () => {
        expect(classifySymbolTarget('apps/distributor/config/services.yaml')).toBe('symbol_config');
        expect(classifySymbolTarget('vendor/acme/package/config/services.yaml')).toBe('ignored');
        expect(classifySymbolTarget('.venv/lib/python/site-packages/config.py')).toBe('ignored');
        expect(classifySymbolTarget('venv/lib/python/site-packages/config.py')).toBe('ignored');
        expect(classifySymbolTarget('e2e/config/services.yaml')).toBe('ignored');
        expect(classifySymbolTarget('cypress/fixtures/services.yaml')).toBe('ignored');
    });
});

describe('symbol-extraction env resolution', () => {
    it('resolves brace and Symfony env templates deterministically', () => {
        const dict = new Map<string, EnvVarBinding>([
            ['DATABASE_NAME', { value: 'prod-db', sourceFile: '.env.example', confidence: 0.9 }],
            ['RABBIT_TOPIC', { value: 'orders.created', sourceFile: 'values.yaml', confidence: 0.8 }],
        ]);

        expect(resolveRawSymbolValue('{DATABASE_NAME}', dict)).toEqual({ value: 'prod-db', resolved: true });
        expect(resolveRawSymbolValue('prefix.%env(RABBIT_TOPIC)%', dict)).toEqual({ value: 'prefix.orders.created', resolved: true });
        expect(resolveRawSymbolValue('{MISSING}', dict)).toEqual({ value: '{MISSING}', resolved: false });
    });
});

// ─── Regression coverage: cache invalidation diff guards ─────────────────────
//
// Pins the contract of `computeSymbolDiff`. A false-positive deletion in this
// loop cascades all the way to `loadSymbolDependentsBatch → tainted files →
// forced LLM re-analysis on unchanged code` (the bug that turned a 4-second
// no-op re-run into a 360-second full re-run on acme-monolith).

const baseStored = (overrides: Partial<StoredConfigSymbol> = {}): StoredConfigSymbol => ({
    key: 'acme.notification.publisher',
    value: 'orders.notifications',
    category: 'di_service',
    resolvedValue: 'orders.notifications',
    sourceFile: 'config/services.yaml',
    ...overrides,
});

const baseBinding = (overrides: Partial<SymbolBinding> = {}): SymbolBinding => ({
    key: 'acme.notification.publisher',
    value: 'orders.notifications',
    category: 'di_service',
    sourceFile: 'config/services.yaml',
    confidence: 'static',
    ...overrides,
});

describe('symbol-extraction computeSymbolDiff', () => {
    const noFailure = { failedSources: new Set<string>(), preserveStoredDueToOpaqueFailure: false };

    it('reports a binding as deleted when it is gone from the current registry', () => {
        const stored = [baseStored()];
        const { changedKeys, deletedKeys } = computeSymbolDiff(stored, [], noFailure);
        expect(deletedKeys).toEqual(['acme.notification.publisher']);
        expect(changedKeys).toEqual([]);
    });

    it('reports a binding as changed when its resolved value drifted', () => {
        const stored = [baseStored({ resolvedValue: 'old.value' })];
        const current = [baseBinding({ value: 'new.value' })];
        const { changedKeys, deletedKeys } = computeSymbolDiff(stored, current, noFailure);
        expect(changedKeys).toEqual(['acme.notification.publisher']);
        expect(deletedKeys).toEqual([]);
    });

    it('does NOT report unchanged bindings as changed or deleted', () => {
        const stored = [baseStored()];
        const current = [baseBinding()];
        const { changedKeys, deletedKeys } = computeSymbolDiff(stored, current, noFailure);
        expect(changedKeys).toEqual([]);
        expect(deletedKeys).toEqual([]);
    });

    it('does NOT mark class-only DI bindings as deleted when absent from current registry', () => {
        // REGRESSION GUARD: class-only DI bindings (boundComponent set, no
        // physicalName) are produced by DiBindingResolver in
        // static-analyzer-pass AFTER buildSymbolRegistryForRepo. They are
        // never present in the current registry at diff time. Marking them
        // deleted would taint every consumer file and force a full LLM
        // re-analysis on unchanged code (acme-monolith: 4s → 360s).
        const stored = [
            baseStored({
                key: 'Acme\\Inventory\\Notification\\NotificationPublisher',
                value: 'Acme\\Inventory\\Notification\\NotificationPublisher',
                boundComponent: 'Acme\\Inventory\\Notification\\NotificationPublisher',
                physicalName: undefined,
                sourceFile: 'config/containerBuilder.php',
            }),
        ];
        const { deletedKeys } = computeSymbolDiff(stored, [], noFailure);
        expect(deletedKeys).toEqual([]);
    });

    it('DOES mark physical-named DI bindings as deleted when absent (legacy path still works)', () => {
        // Counterpart guard: a binding with a real physicalName lives inside
        // the symbol extractor's target plan. If it vanishes from the
        // current registry, that IS a genuine deletion and consumers MUST
        // be tainted.
        const stored = [
            baseStored({
                key: 'acme.notification.publisher',
                physicalName: 'orders.notifications',
                boundComponent: 'Acme\\Inventory\\Notification\\NotificationPublisher',
            }),
        ];
        const { deletedKeys } = computeSymbolDiff(stored, [], noFailure);
        expect(deletedKeys).toEqual(['acme.notification.publisher']);
    });

    it('skips deletion when the stored symbol\'s source file failed mid-run', () => {
        const stored = [baseStored({ sourceFile: 'config/services.yaml' })];
        const { deletedKeys } = computeSymbolDiff(stored, [], {
            failedSources: new Set(['config/services.yaml']),
            preserveStoredDueToOpaqueFailure: false,
        });
        expect(deletedKeys).toEqual([]);
    });

    it('skips all deletions under preserveStoredDueToOpaqueFailure', () => {
        const stored = [baseStored(), baseStored({ key: 'other.key' })];
        const { deletedKeys } = computeSymbolDiff(stored, [], {
            failedSources: new Set(),
            preserveStoredDueToOpaqueFailure: true,
        });
        expect(deletedKeys).toEqual([]);
    });

    it('treats absent resolvedValue as a fallback to value', () => {
        const stored = [baseStored({ resolvedValue: undefined, value: 'orders.notifications' })];
        const current = [baseBinding({ value: 'orders.notifications' })];
        const { changedKeys, deletedKeys } = computeSymbolDiff(stored, current, noFailure);
        expect(changedKeys).toEqual([]);
        expect(deletedKeys).toEqual([]);
    });
});
