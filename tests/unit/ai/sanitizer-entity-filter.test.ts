import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import { extractResolvedEntityContext } from '../../../src/ingestion/processors/code-pipeline/entity-table-registry.js';
import type { UnifiedAnalysis } from '../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// extractResolvedEntityContext()
// ═════════════════════════════════════════════════════════════════════════════

describe('extractResolvedEntityContext()', () => {
    it('should extract entity short names and table names from formatted context string', () => {
        const context = `
--- Resolved Entity Table Names (ground truth from ORM annotations) ---
The following entity classes are imported and have KNOWN table mappings.
You MUST use these table names — do NOT infer from class name.

  Record → table "records"
  Invoice → table "invoices"

When you see a Repository, Service, or Handler...
--- End Entity Table Names ---`;

        const ctx = extractResolvedEntityContext(context);
        expect(ctx).toBeDefined();
        expect(ctx!.entityNames.has('Record')).toBe(true);
        expect(ctx!.entityNames.has('Invoice')).toBe(true);
        expect(ctx!.tableNames.has('records')).toBe(true);
        expect(ctx!.tableNames.has('invoices')).toBe(true);
        expect(ctx!.entityNames.size).toBe(2);
        expect(ctx!.tableNames.size).toBe(2);
    });

    it('should return undefined for empty/null context', () => {
        expect(extractResolvedEntityContext(undefined)).toBeUndefined();
        expect(extractResolvedEntityContext('')).toBeUndefined();
    });

    it('should return undefined for context with no parseable mappings', () => {
        expect(extractResolvedEntityContext('random text without mappings')).toBeUndefined();
    });

    it('should handle schema-qualified and special-char table names (dbo.records, user$auth)', () => {
        const context = `
--- Resolved Entity Table Names (ground truth from ORM annotations) ---

  Invoice → table "dbo.records"
  Auth → table "user$auth"
  Header → table "sales.invoice_headers"

--- End Entity Table Names ---`;

        const ctx = extractResolvedEntityContext(context);
        expect(ctx).toBeDefined();
        expect(ctx!.tableNames.has('dbo.records')).toBe(true);
        expect(ctx!.tableNames.has('user$auth')).toBe(true);
        expect(ctx!.tableNames.has('sales.invoice_headers')).toBe(true);
        expect(ctx!.entityNames.has('Invoice')).toBe(true);
        expect(ctx!.entityNames.has('Auth')).toBe(true);
        expect(ctx!.entityNames.has('Header')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeAnalysis() — Entity & Table Filters
// ═════════════════════════════════════════════════════════════════════════════

describe('Sanitizer — Entity & Table Filters', () => {
    function makeDeepAnalysis(overrides: Partial<any> = {}): UnifiedAnalysis {
        return {
            has_io: true,
            intent: 'reads from database',
            infrastructure: [{
                name: 'records',
                type: 'Database',
                operation: 'READS',
                evidence: 'SELECT * FROM records',
            }],
            capabilities: ['database-reader'],
            produced_payloads: [],
            consumed_payloads: [],
            emergent_api_calls: [],
            ...overrides,
        } as UnifiedAnalysis;
    }

    it('should strip produced_payloads matching known entity class names', () => {
        const analysis = makeDeepAnalysis({
            produced_payloads: [
                { name: 'Record', fields: [{ name: 'id', type: 'int' }] },
                { name: 'OrderCreatedEvent', fields: [{ name: 'orderId', type: 'string' }] },
            ],
        });

        const entityClassNames = new Set(['Record']);
        const sourceCode = 'return $this->createQueryBuilder("r")->getQuery()->getResult();';

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'findAll', entityClassNames });

        const produced = (result as any).produced_payloads;
        expect(produced).toHaveLength(1);
        expect(produced[0].name).toBe('OrderCreatedEvent');
    });

    it('should strip consumed_payloads matching known entity class names', () => {
        const analysis = makeDeepAnalysis({
            consumed_payloads: [
                { name: 'Record', fields: [{ name: 'id', type: 'int' }] },
            ],
        });

        const entityClassNames = new Set(['Record']);
        const sourceCode = '$this->em->persist($record);';

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'save', entityClassNames });

        const consumed = (result as any).consumed_payloads;
        expect(consumed).toHaveLength(0);
    });

    it('should preserve ground-truth tables even if NOT in source code', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'records',
                type: 'Database',
                operation: 'READS',
                evidence: 'ORM query on Record',
            }],
        });

        const sourceCode = 'return $this->findAll();'; // Word 'records' is MISSING
        const allowedTableNames = new Set(['records']);

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'findAll', allowedTableNames });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(1);
        expect(infra[0].name).toBe('records');
    });

    it('should still drop hallucinated tables NOT in allowed list', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'ghost_table',
                type: 'Database',
                operation: 'READS',
                evidence: 'SELECT * FROM ghost_table',
            }],
        });

        const sourceCode = 'return $this->findAll();'; // 'ghost_table' is MISSING
        const allowedTableNames = new Set(['records']);

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'findAll', allowedTableNames });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(0);
    });

    // ── Event-Driven Architecture edge cases ──────────────────────────────────

    it('should NOT strip legitimate event payload (e.g. OrderCreatedEvent) just because entity names are set', () => {
        // This is the critical event-driven safety check:
        // entityClassNames = ['Record'] must ONLY strip 'Record', not 'OrderCreatedEvent'
        const analysis = makeDeepAnalysis({
            produced_payloads: [
                { name: 'OrderCreatedEvent', fields: [{ name: 'orderId', type: 'string' }] },
                { name: 'Record', fields: [{ name: 'id', type: 'int' }] }, // This one should be stripped
            ],
        });

        const entityClassNames = new Set(['Record']);
        const sourceCode = '$this->messageBus->dispatch(new OrderCreatedEvent($orderId));';

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'handle', entityClassNames });

        const produced = (result as any).produced_payloads;
        expect(produced).toHaveLength(1);
        expect(produced[0].name).toBe('OrderCreatedEvent');
    });

    it('should preserve schema-qualified ground-truth tables (dbo.records) even when absent from source', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'dbo.records',
                type: 'Database',
                operation: 'READS',
                evidence: 'ORM query on Record entity',
            }],
        });

        const sourceCode = 'return $this->findLatestValid($id);'; // 'dbo.records' is MISSING
        const allowedTableNames = new Set(['dbo.records']);

        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.php', functionName: 'findLatestValid', allowedTableNames });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(1);
        expect(infra[0].name).toBe('dbo.records');
    });

    it('should return analysis unchanged when has_io is false (early exit)', () => {
        const analysis: any = {
            has_io: false,
            intent: 'pure calculation, no I/O',
            infrastructure: [], // Would be touched if has_io were true
            capabilities: [],
            produced_payloads: [
                { name: 'Record', fields: [] }, // Would be stripped if has_io were true
            ],
            emergent_api_calls: [],
        };

        const entityClassNames = new Set(['Record']);
        const result = sanitizeAnalysis(analysis as any, { sourceCode: 'some code', consumerFilePath: 'test.php', functionName: 'calculate', entityClassNames });

        // Should return the EXACT same object (not a clone, not modified)
        expect(result).toBe(analysis);
        expect((result as any).produced_payloads).toHaveLength(1);
    });

    it('should preserve framework-signal-backed inbound paths even when the full prefixed path is absent from the method body', () => {
        const analysis = makeDeepAnalysis({
            intent: 'handles HTTP request',
            infrastructure: [],
            emergent_api_calls: [{
                method: 'GET',
                path: '/users/:id',
                direction: 'INBOUND',
                protocol: 'http',
            }],
        });

        const sourceCode = `
@UseGuards(AuthGuard)
@Get('/:id')
findOne() {
  return this.usersService.findOne();
}`;

        const result = sanitizeAnalysis(
            analysis,
            sourceCode,
            undefined,
            'users.controller.ts',
            'UsersController.findOne',
            undefined,
            undefined,
            new Set(['/users/:id']),
        );

        expect((result as any).emergent_api_calls).toHaveLength(1);
        expect((result as any).emergent_api_calls[0].path).toBe('/users/:id');
    });

    it('should preserve tables found in QueryBuilder pattern (Fallback C)', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'outbox',
                type: 'Database',
                operation: 'WRITES',
                evidence: 'Writes to outbox table',
            }],
        });

        // The name 'outbox' is present, but only inside a QueryBuilder-style call
        const sourceCode = 'this.createQueryBuilder().from("outbox").insert().execute();';
        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.ts', functionName: 'save' });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(1);
        expect(infra[0].name).toBe('outbox');
    });

    it('should preserve collections found in Mongo collection() pattern (Fallback C)', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'app_users',
                type: 'Database',
                operation: 'READS',
                evidence: 'Reads from app_users collection',
            }],
        });

        const sourceCode = 'this.db.collection(\'app_users\').find({}).toArray();';
        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.ts', functionName: 'find' });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(1);
        expect(infra[0].name).toBe('app_users');
    });

    it('should preserve tables found in TypeORM getRepository pattern (Fallback C)', () => {
        const analysis = makeDeepAnalysis({
            infrastructure: [{
                name: 'legacy_data',
                type: 'Database',
                operation: 'READS',
                evidence: 'Reads from legacy_data',
            }],
        });

        const sourceCode = 'const repo = getRepository(`legacy_data`);';
        const result = sanitizeAnalysis(analysis, { sourceCode, consumerFilePath: 'test.ts', functionName: 'read' });

        const infra = (result as any).infrastructure;
        expect(infra).toHaveLength(1);
        expect(infra[0].name).toBe('legacy_data');
    });
});

describe('Sanitizer — Purely Dynamic Placeholder Guard', () => {
    const makePlaceholderAnalysis = (infra: { name: string; type: string; operation: string; evidence?: string }) => ({
        has_io: true,
        intent: 'mock intent',
        infrastructure: [infra],
        capabilities: [],
        produced_payloads: [],
        consumed_payloads: [],
        emergent_api_calls: [],
    });


    it('should drop ObjectStorage with purely dynamic name {args.ts}', () => {
        const analysis = makePlaceholderAnalysis({
            name: '{args.ts}',
            type: 'ObjectStorage',
            operation: 'WRITES',
        });
        const result = sanitizeAnalysis(analysis as any, 'fs.writeFileSync(args.ts, data)', undefined, 'test.ts', 'generate');
        expect((result as any).infrastructure).toHaveLength(0);
    });

    it('should drop Database with purely dynamic name {self.table_name} (Python)', () => {
        const analysis = makePlaceholderAnalysis({
            name: '{self.table_name}',
            type: 'Database',
            operation: 'WRITES',
        });
        const result = sanitizeAnalysis(analysis as any, 'cursor.execute(f"INSERT INTO {self.table_name}")', undefined, 'test.py', 'save');
        expect((result as any).infrastructure).toHaveLength(0);
    });

    // Note: MessageChannel placeholders are NOT caught by the early cross-type guard
    // (which skips MessageChannel to allow DI resolution first). They are caught by the
    // post-DI guard at the end of the MessageChannel block in sanitizer.ts.
    it('should drop MessageChannel with purely dynamic name {cfg.TopicName} (Go)', () => {
        const analysis = makePlaceholderAnalysis({
            name: '{cfg.TopicName}',
            type: 'MessageChannel',
            operation: 'WRITES',
        });
        const result = sanitizeAnalysis(analysis as any, 'publisher.Publish(cfg.TopicName, msg)', undefined, 'test.go', 'publish');
        expect((result as any).infrastructure).toHaveLength(0);
    });

    it('should preserve legitimate dynamic stub booking_slot_{type}', () => {
        const analysis = makePlaceholderAnalysis({
            name: 'booking_slot_{type}',
            type: 'Database',
            operation: 'WRITES',
            evidence: "DELETE FROM booking_slot_{type}",
        });
        const result = sanitizeAnalysis(analysis as any, "DELETE FROM booking_slot_{type}", undefined, 'test.php', 'purge');
        expect((result as any).infrastructure).toHaveLength(1);
    });
});
