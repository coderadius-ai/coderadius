import { describe, it, expect } from 'vitest';
import {
    collectEntityTableRegistry,
    buildEntityTableContext,
    type EntityTableEntry,
    type EntityTableRegistry,
} from '../../../../src/ingestion/processors/code-pipeline/entity-table-registry.js';
import type { AnalysisTask, StaticAnalysisResult } from '../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FileImportMap } from '../../../../src/ingestion/core/import-graph.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStaticTask(
    chunkName: string,
    tableName: string,
    operation: string = 'MAPS_TO',
): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: `test:${chunkName}`,
        functionHash: 'abc123',
        chunk: {
            name: chunkName,
            filepath: 'src/Entity/Record.php',
            sourceCode: `// ORM entity class ${chunkName}`,
            language: 'php',
            startLine: 1,
            startColumn: 1,
            endLine: 10,
            endColumn: 1,
        },
        fileContext: {
            absolutePath: '/repo/src/Entity/Record.php',
            relativePath: 'src/Entity/Record.php',
            repo: { name: 'test-repo', path: '/repo' } as any,
            routing: { type: 'repository', name: 'test-repo', urn: 'cr:repo:test-repo' },
            fileHash: 'hash1',
            ownerService: null,
            isManifest: false,
        },
        isResolvedStatically: true,
        staticAnalysis: {
            has_io: true,
            intent: `Doctrine entity mapped to table '${tableName}'`,
            infrastructure: [{
                name: tableName,
                type: 'Database',
                operation,
            }],
            capabilities: ['orm-entity'],
            emergent_api_calls: [],
        },
    };
}

function makeLLMTask(
    chunkName: string,
    sourceCode: string,
    imports?: string[],
): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: `test:${chunkName}`,
        functionHash: 'def456',
        chunk: {
            name: chunkName,
            filepath: 'src/Repository/RecordRepository.php',
            sourceCode,
            language: 'php',
            startLine: 1,
            startColumn: 1,
            endLine: 20,
            endColumn: 1,
        },
        fileContext: {
            absolutePath: '/repo/src/Repository/RecordRepository.php',
            relativePath: 'src/Repository/RecordRepository.php',
            repo: { name: 'test-repo', path: '/repo' } as any,
            routing: { type: 'repository', name: 'test-repo', urn: 'cr:repo:test-repo' },
            fileHash: 'hash2',
            ownerService: null,
            isManifest: false,
        },
        imports,
    };
}

function makeAnalysisResult(tasks: AnalysisTask[]): StaticAnalysisResult {
    return {
        fileContext: tasks[0]?.fileContext ?? {} as any,
        analysisTasks: tasks,
        skippedFunctionCount: 0,
        unchangedFunctionCount: 0,
        unchangedFunctions: [],
        deletedFunctions: [],
        schemaContext: null,
        rootNode: null,
        language: 'php',
    };
}

function makeImportMap(filePath: string, imports: FileImportMap['imports']): FileImportMap {
    return { filePath, imports, exportedSymbols: [] };
}

// ═════════════════════════════════════════════════════════════════════════════
// collectEntityTableRegistry()
// ═════════════════════════════════════════════════════════════════════════════

describe('collectEntityTableRegistry()', () => {
    it('should collect FQCN→TableName from static MAPS_TO tasks', () => {
        const results = [
            makeAnalysisResult([
                makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records'),
            ]),
        ];
        const registry = collectEntityTableRegistry(results);
        expect(registry).toHaveLength(1);
        expect(registry[0].fqcn).toBe('Acme\\Entity\\Record');
        expect(registry[0].tableName).toBe('records');
        expect(registry[0].shortName).toBe('Record');
        expect(registry[0].namespace).toBe('Acme\\Entity');
    });

    it('should ignore non-static tasks', () => {
        const llmTask = makeLLMTask('Acme\\Repository\\RecordRepository.findByExternalId', '$this->createQueryBuilder("r")');
        const results = [makeAnalysisResult([llmTask])];
        const registry = collectEntityTableRegistry(results);
        expect(registry).toHaveLength(0);
    });

    it('should ignore non-MAPS_TO infrastructure entries (READS, WRITES)', () => {
        const results = [makeAnalysisResult([makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records', 'READS')])];
        const registry = collectEntityTableRegistry(results);
        expect(registry).toHaveLength(0);
    });

    it('should handle multiple entities from different files', () => {
        const task1 = makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records');
        const task2 = makeStaticTask('Acme\\Entity\\Invoice::__class_metadata', 'invoices');
        task2.chunk.filepath = 'src/Entity/Invoice.php';
        const registry = collectEntityTableRegistry([makeAnalysisResult([task1]), makeAnalysisResult([task2])]);
        expect(registry).toHaveLength(2);
        expect(registry.map(e => e.tableName).sort()).toEqual(['invoices', 'records']);
    });

    it('should handle multiple entities in the same file', () => {
        const task1 = makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records');
        const task2 = makeStaticTask('Acme\\Entity\\RecordHistory::__class_metadata', 'record_history');
        const registry = collectEntityTableRegistry([makeAnalysisResult([task1, task2])]);
        expect(registry).toHaveLength(2);
    });

    it('should extract correct shortName and namespace from deep FQCN', () => {
        const results = [makeAnalysisResult([makeStaticTask('App\\Domain\\Billing\\Entity\\Invoice::__class_metadata', 'invoices')])];
        const registry = collectEntityTableRegistry(results);
        expect(registry[0].shortName).toBe('Invoice');
        expect(registry[0].namespace).toBe('App\\Domain\\Billing\\Entity');
    });

    it('should handle entity without namespace (root namespace)', () => {
        const results = [makeAnalysisResult([makeStaticTask('Record::__class_metadata', 'records')])];
        const registry = collectEntityTableRegistry(results);
        expect(registry).toHaveLength(1);
        expect(registry[0].fqcn).toBe('Record');
        expect(registry[0].shortName).toBe('Record');
        expect(registry[0].namespace).toBe('');
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    it('should return empty registry for empty input array', () => {
        expect(collectEntityTableRegistry([])).toHaveLength(0);
    });

    it('should ignore static tasks with chunk name NOT ending in ::__class_metadata', () => {
        // A statically-resolved factory method is not an entity metadata chunk
        const task = makeStaticTask('Acme\\Entity\\Record.create', 'records');
        expect(collectEntityTableRegistry([makeAnalysisResult([task])])).toHaveLength(0);
    });

    it('should only collect MAPS_TO from tasks with mixed infrastructure types', () => {
        // One MAPS_TO + one READS (same table) + one Cache → should yield exactly 1 entry
        const task: AnalysisTask = {
            ...makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records'),
            staticAnalysis: {
                has_io: true,
                intent: 'ORM entity',
                infrastructure: [
                    { name: 'records', type: 'Database', operation: 'MAPS_TO' },
                    { name: 'some_cache', type: 'Cache', operation: 'READS' },
                    { name: 'records', type: 'Database', operation: 'READS' },
                ],
                capabilities: [],
                emergent_api_calls: [],
            },
        };
        const registry = collectEntityTableRegistry([makeAnalysisResult([task])]);
        expect(registry).toHaveLength(1);
        expect(registry[0].tableName).toBe('records');
    });

    it('should handle static task with null/undefined infrastructure gracefully', () => {
        const task: AnalysisTask = {
            ...makeStaticTask('Acme\\Entity\\Record::__class_metadata', 'records'),
            staticAnalysis: {
                has_io: false,
                intent: 'empty entity',
                infrastructure: undefined as any,
                capabilities: [],
                emergent_api_calls: [],
            },
        };
        expect(collectEntityTableRegistry([makeAnalysisResult([task])])).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildEntityTableContext()
// ═════════════════════════════════════════════════════════════════════════════

describe('buildEntityTableContext()', () => {
    const registry: EntityTableRegistry = [
        { fqcn: 'Acme\\Entity\\Record', tableName: 'records', shortName: 'Record', namespace: 'Acme\\Entity' },
        { fqcn: 'Acme\\Entity\\Invoice', tableName: 'invoices', shortName: 'Invoice', namespace: 'Acme\\Entity' },
    ];

    // ─── Tier 1: Exact FQCN import match ─────────────────────────────

    describe('Tier 1: Exact FQCN import match', () => {
        it('should match `use Acme\\Entity\\Record;` via structured ImportMap', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.findByExternalId',
                'function findByExternalId($eid) { return $this->createQueryBuilder("r")->where("r.externalId = :eid"); }',
                ['use Acme\\Entity\\Record;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity\\Record', specifiers: ['Record'], isExternal: false },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('Record');
            expect(result).toContain('records');
        });

        it('should match import resolved to entity file path (PSR-4)', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->createQueryBuilder("r"); }',
                ['use Acme\\Entity\\Record;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'src/Entity/Record.php', specifiers: ['Record'], isExternal: true },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
        });

        it('should match aliased import (use ... as ...) via structured ImportMap', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { $rec = new Rec(); }',
                ['use Acme\\Entity\\Record as Rec;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity\\Record', specifiers: ['Rec'], isExternal: false },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
        });

        it('should match via raw import string fallback when no ImportMap is provided', () => {
            // Simulates TypeScript/Python context where fileImportMap may be unavailable
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->createQueryBuilder("r")->getResult(); }',
                ['use Acme\\Entity\\Record;'],
            );
            const result = buildEntityTableContext(task, registry, undefined);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
        });

        it('should match aliased import via raw import string fallback (use ... as ...)', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { $r = new Rec(); return $r; }',
                ['use Acme\\Entity\\Record as Rec;'],
            );
            // Raw string contains the FQCN, so it should still match
            const result = buildEntityTableContext(task, registry, undefined);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
        });

        it('should return null when no import matches and shortName not in source', () => {
            const task = makeLLMTask(
                'Acme\\Service\\PaymentService.process',
                'function process($data) { $this->gateway->charge($data); }',
                ['use Acme\\Gateway\\PaymentGateway;'],
            );
            const importMap = makeImportMap('src/Service/PaymentService.php', [
                { source: 'Acme\\Gateway\\PaymentGateway', specifiers: ['PaymentGateway'], isExternal: false },
            ]);
            expect(buildEntityTableContext(task, registry, importMap)).toBeNull();
        });

        it('should match TypeScript symbol imports from .entity modules', () => {
            const tsRegistry: EntityTableRegistry = [
                {
                    fqcn: 'OrderTableSchema',
                    tableName: 'shopping_carts',
                    shortName: 'OrderTableSchema',
                    namespace: '',
                    sourcePath: 'apps/api/src/database/entities/Order.entity.ts',
                    moduleBasename: 'Order.entity',
                    moduleStem: 'Order',
                },
            ];
            const task: AnalysisTask = {
                kind: 'analysis',
                functionId: 'test:CheckoutService.save',
                functionHash: 'hash-ts-1',
                chunk: {
                    name: 'CheckoutService.save',
                    filepath: 'apps/api/src/application/CheckoutService.ts',
                    sourceCode: 'return this.dataSource.getRepository(OrderTableSchema).save(payload);',
                    language: 'typescript',
                    startLine: 1,
                    startColumn: 1,
                    endLine: 5,
                    endColumn: 1,
                },
                fileContext: {
                    absolutePath: '/repo/apps/api/src/application/CheckoutService.ts',
                    relativePath: 'apps/api/src/application/CheckoutService.ts',
                    repo: { name: 'test-repo', path: '/repo' } as any,
                    routing: { type: 'repository', name: 'test-repo', urn: 'cr:repo:test-repo' },
                    fileHash: 'hash-ts-file',
                    ownerService: null,
                    isManifest: false,
                },
                imports: ["import { OrderTableSchema } from '@apps/api/src/database/entities/Order.entity';"],
            };
            const importMap = makeImportMap('apps/api/src/application/CheckoutService.ts', [
                {
                    source: '@apps/api/src/database/entities/Order.entity',
                    specifiers: ['OrderTableSchema'],
                    isExternal: false,
                },
            ]);

            const result = buildEntityTableContext(task, tsRegistry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('OrderTableSchema');
            expect(result).toContain('shopping_carts');
        });
    });

    // ─── Tier 2: Namespace prefix import ─────────────────────────────

    describe('Tier 2: Namespace prefix import', () => {
        it('should match `use Acme\\Entity;` when shortName appears in source', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->em->getRepository(Entity\\Record::class)->find(1); }',
                ['use Acme\\Entity;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity', specifiers: ['Entity'], isExternal: true },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('Record');
            expect(result).toContain('records');
        });

        it('should only match entities whose shortName appears in source body (NOT all under namespace)', () => {
            // Source only mentions "Invoice", not "Record"
            const task = makeLLMTask(
                'Acme\\Repository\\InvoiceRepository.count',
                'function count() { return $this->em->getRepository(Entity\\Invoice::class)->count(); }',
                ['use Acme\\Entity;'],
            );
            const importMap = makeImportMap('src/Repository/InvoiceRepository.php', [
                { source: 'Acme\\Entity', specifiers: ['Entity'], isExternal: true },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('Invoice');
            expect(result).toContain('invoices');
            expect(result).not.toContain('"records"');
        });

        it('should NOT fire Tier 2 when shortName absent from both source and imports', () => {
            // The function body has no entity mentions at all — Tier 2 must not match
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.flush',
                'function flush() { $this->em->flush(); }',
                ['use Acme\\Entity;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity', specifiers: ['Entity'], isExternal: true },
            ]);
            expect(buildEntityTableContext(task, registry, importMap)).toBeNull();
        });

        it('should match via raw namespace import fallback (no ImportMap)', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->em->getRepository(Entity\\Record::class)->find(1); }',
                ['use Acme\\Entity;'],
            );
            const result = buildEntityTableContext(task, registry, undefined);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
        });
    });

    // ─── Tier 3: Same-namespace implicit ─────────────────────────────

    describe('Tier 3: Same-namespace implicit', () => {
        it('should match when file namespace equals entity namespace', () => {
            const task = makeLLMTask(
                'Acme\\Entity\\RecordValidator.validate',
                'function validate(Record $record) { return $record->isValid(); }',
                [],
            );
            const importMap = makeImportMap('src/Entity/RecordValidator.php', []);
            const result = buildEntityTableContext(task, registry, importMap, 'Acme\\Entity');
            expect(result).not.toBeNull();
            expect(result).toContain('Record');
            expect(result).toContain('records');
        });

        it('should NOT match when file namespace differs from entity namespace', () => {
            const task = makeLLMTask(
                'Other\\Domain\\RecordService.save',
                'function save(Record $record) { $this->repo->persist($record); }',
                [],
            );
            const importMap = makeImportMap('src/Domain/RecordService.php', []);
            // 'Other\Domain' !== 'Acme\Entity'
            expect(buildEntityTableContext(task, registry, importMap, 'Other\\Domain')).toBeNull();
        });

        it('should return null when fileNamespace is absent (Tier 3 cannot fire)', () => {
            const task = makeLLMTask(
                'Acme\\Entity\\RecordValidator.validate',
                'function validate(Record $record) { return $record->isValid(); }',
                [],
            );
            const importMap = makeImportMap('src/Entity/RecordValidator.php', []);
            // No fileNamespace provided
            expect(buildEntityTableContext(task, registry, importMap, undefined)).toBeNull();
        });
    });

    // ─── Collision safety ────────────────────────────────────────────

    describe('Collision safety', () => {
        const registryWithCollision: EntityTableRegistry = [
            { fqcn: 'Acme\\Entity\\Record', tableName: 'records', shortName: 'Record', namespace: 'Acme\\Entity' },
            { fqcn: 'Other\\Entity\\Record', tableName: 'other_records', shortName: 'Record', namespace: 'Other\\Entity' },
        ];

        it('should resolve to only Acme entity when import is exact FQCN', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->createQueryBuilder("r"); }',
                ['use Acme\\Entity\\Record;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity\\Record', specifiers: ['Record'], isExternal: false },
            ]);
            const result = buildEntityTableContext(task, registryWithCollision, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
            expect(result).not.toContain('other_records');
        });
    });

    // ─── Degenerate / boundary inputs ────────────────────────────────

    describe('Degenerate inputs', () => {
        it('should return null immediately for empty registry', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->createQueryBuilder("r"); }',
                ['use Acme\\Entity\\Record;'],
            );
            expect(buildEntityTableContext(task, [], undefined)).toBeNull();
        });

        it('should return null when task has no imports and no fileNamespace', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.find',
                'function find() { return $this->flush(); }',
                undefined,
            );
            expect(buildEntityTableContext(task, registry, undefined, undefined)).toBeNull();
        });
    });

    // ─── Output format ───────────────────────────────────────────────

    describe('Output format', () => {
        it('should include header, ground truth label, and entity→table mapping', () => {
            const task = makeLLMTask(
                'Acme\\Repository\\RecordRepository.findByExternalId',
                'function findByExternalId($eid) { return $this->createQueryBuilder("r"); }',
                ['use Acme\\Entity\\Record;'],
            );
            const importMap = makeImportMap('src/Repository/RecordRepository.php', [
                { source: 'Acme\\Entity\\Record', specifiers: ['Record'], isExternal: false },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('Resolved Entity Table Names');
            expect(result).toContain('ground truth');
            expect(result).toContain('Record');
            expect(result).toContain('"records"');
        });

        it('should include all matched entities in a single context block', () => {
            const task = makeLLMTask(
                'Acme\\Service\\DataService.process',
                'function process(Record $r, Invoice $i) { /* uses both */ }',
                ['use Acme\\Entity\\Record;', 'use Acme\\Entity\\Invoice;'],
            );
            const importMap = makeImportMap('src/Service/DataService.php', [
                { source: 'Acme\\Entity\\Record', specifiers: ['Record'], isExternal: false },
                { source: 'Acme\\Entity\\Invoice', specifiers: ['Invoice'], isExternal: false },
            ]);
            const result = buildEntityTableContext(task, registry, importMap);
            expect(result).not.toBeNull();
            expect(result).toContain('records');
            expect(result).toContain('invoices');
        });
    });
});
