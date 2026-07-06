import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractParsedFile, type WorkerContext } from '../../../../../src/ingestion/processors/code-pipeline/parse-worker.js';
import type { ParseWorkTask } from '../../../../../src/ingestion/processors/code-pipeline/parse-protocol.js';

// extractParsedFile is thread-agnostic: these tests run it in-process against
// real tree-sitter + real language plugins on disk fixtures, pinning the
// per-mode extraction contract (fresh vs cache-hit vs unsupported files).

const TS_SERVICE = `import axios from 'axios';
import { OrderRepository } from './order-repository';

export const ORDERS_TOPIC = 'orders.created';

export interface OrderDto {
  id: string;
  total: number;
}

export class OrderService {
  constructor(private readonly repository: OrderRepository) {}

  async createOrder(payload: OrderDto): Promise<void> {
    await axios.post('https://api.acme.com/orders', payload);
    await this.repository.save(payload);
  }
}
`;

const TS_REPOSITORY = `export class OrderRepository {
  async save(order: unknown): Promise<void> {
    return;
  }
}
`;

const PHP_SERVICE = `<?php

namespace Acme\\Inventory;

class InventoryService
{
    public function __construct(private StockRepository $repository)
    {
    }

    public function reserve(string $sku): void
    {
        $this->repository->reserve($sku);
    }
}
`;

let tmpDir: string;

function makeContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
    return {
        allFilePaths: new Set(['src/order-service.ts', 'src/order-repository.ts', 'src/inventory-service.php', 'docs/readme.md']),
        dependencyMappings: [],
        scanMode: 'semantic',
        ...overrides,
    };
}

function makeTask(relativePath: string, overrides: Partial<ParseWorkTask> = {}): ParseWorkTask {
    return {
        taskId: 0,
        absolutePath: path.join(tmpDir, relativePath),
        relativePath,
        mode: 'fresh',
        needsImportMap: true,
        ...overrides,
    };
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-parse-worker-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/order-service.ts'), TS_SERVICE);
    fs.writeFileSync(path.join(tmpDir, 'src/order-repository.ts'), TS_REPOSITORY);
    fs.writeFileSync(path.join(tmpDir, 'src/inventory-service.php'), PHP_SERVICE);
    fs.writeFileSync(path.join(tmpDir, 'docs/readme.md'), '# readme\n');
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractParsedFile', () => {
    it('runs the full fresh extraction on a TypeScript file', () => {
        const result = extractParsedFile(makeTask('src/order-service.ts'), makeContext());

        expect(result.language).toBe('typescript');
        expect(result.fileContent).toBe(TS_SERVICE);
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        expect(result.chunks.map(c => c.name).join(',')).toContain('createOrder');
        // Per-chunk static data is index-aligned with chunks.
        expect(result.chunkStaticData).toHaveLength(result.chunks.length);
        expect(result.importStatements.length).toBeGreaterThanOrEqual(1);
        expect(result.constructorSources.get('OrderService')).toContain('repository');
        // interface OrderDto triggers the AST schema gate.
        expect(result.mayContainSchemas).toBe(true);
        expect(result.parseDurationMs).toBeGreaterThan(0);
        // Import map extracted: axios external, sibling file internal.
        expect(result.importMap).not.toBeNull();
        const sources = result.importMap!.imports.map(i => `${i.source}:${i.isExternal}`);
        expect(sources).toContain('axios:true');
        expect(result.importMap!.exportedSymbols).toContain('OrderService');
        // Shallow scan: no deep type metadata.
        expect(result.typeDefinitions).toBeNull();
        expect(result.referencedTypes).toBeNull();
    });

    it('extracts deep type metadata in contracts mode', () => {
        const result = extractParsedFile(
            makeTask('src/order-service.ts'),
            makeContext({ scanMode: 'contracts' }),
        );

        expect(result.typeDefinitions).not.toBeNull();
        expect(result.typeDefinitions!.get('OrderDto')).toMatchObject({
            kind: 'interface',
            properties: expect.arrayContaining([expect.objectContaining({ name: 'id' })]),
        });
        expect(result.referencedTypes).not.toBeNull();
    });

    it('parses PHP through the language plugin registry', () => {
        const result = extractParsedFile(makeTask('src/inventory-service.php'), makeContext());

        expect(result.language).toBe('php');
        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        expect(result.chunkStaticData).toHaveLength(result.chunks.length);
    });

    it('cache-hit mode rebuilds light context without chunks or per-chunk data', () => {
        const result = extractParsedFile(
            makeTask('src/order-service.ts', { mode: 'cache-hit', needsImportMap: true }),
            makeContext(),
        );

        expect(result.language).toBe('typescript');
        expect(result.fileContent).toBe(TS_SERVICE);
        // Chunks come from the merkle index on cache hits — not re-extracted.
        expect(result.chunks).toEqual([]);
        expect(result.chunkStaticData).toEqual([]);
        expect(result.importStatements).toEqual([]);
        expect(result.constructorSources.size).toBe(0);
        expect(result.mayContainSchemas).toBe(false);
        // Backfill request still extracts the import map trio.
        expect(result.importMap).not.toBeNull();
    });

    it('skips import extraction when the merkle index already has it', () => {
        const result = extractParsedFile(
            makeTask('src/order-service.ts', { mode: 'cache-hit', needsImportMap: false }),
            makeContext(),
        );

        expect(result.importMap).toBeNull();
        expect(result.classAliases).toEqual([]);
        expect(result.dependencyBindings).toEqual([]);
    });

    it('returns empty defaults for unsupported extensions in cache-hit mode', () => {
        const result = extractParsedFile(
            makeTask('docs/readme.md', { mode: 'cache-hit' }),
            makeContext(),
        );

        expect(result.language).toBe('unknown');
        expect(result.fileContent).toBe('');
        expect(result.chunks).toEqual([]);
        expect(result.parseDurationMs).toBe(0);
    });

    it('returns empty extraction for unsupported extensions in fresh mode', () => {
        const result = extractParsedFile(makeTask('docs/readme.md'), makeContext());

        expect(result.language).toBe('unknown');
        expect(result.fileContent).toBe('');
        expect(result.chunks).toEqual([]);
        expect(result.importMap).toBeNull();
        expect(result.mayContainSchemas).toBe(false);
    });

    it('throws on unreadable files (pool surfaces it as a task failure)', () => {
        expect(() => extractParsedFile(makeTask('src/missing.php'), makeContext())).toThrow();
    });
});
