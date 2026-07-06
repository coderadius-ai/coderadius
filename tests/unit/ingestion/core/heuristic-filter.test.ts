import { describe, it, expect } from 'vitest';
import { likelyHasIOWithTaint, isDIConstructor } from '../../../../src/ingestion/core/heuristic-filter.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import type { FileTaintInfo } from '../../../../src/ingestion/core/import-graph.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChunk(name: string, sourceCode: string, filepath = 'test.ts', language: CodeChunk['language'] = 'typescript'): CodeChunk {
    return {
        name,
        sourceCode,
        filepath,
        language,
        startLine: 1,
        startColumn: 1,
        endLine: 10,
        endColumn: 1,
    };
}

function makeTaintInfo(opts: {
    symbols?: string[];
    aliases?: [string, string][];
} = {}): FileTaintInfo {
    return {
        taintedSymbols: new Set(opts.symbols ?? []),
        taintedAliases: new Map(opts.aliases ?? []),
    };
}

// ─── Gate 2: Tainted Symbol Detection ────────────────────────────────────────

describe('Gate 4 — Tainted Symbol Detection', () => {
    it('should pass when function body references a tainted symbol', () => {
        const chunk = makeChunk('useApi', 'const client = new ApiGateway(); client.get("/data");');
        const taint = makeTaintInfo({ symbols: ['ApiGateway'] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(4);
            expect(verdict.reason).toBe('tainted:ApiGateway');
        }
    });

    it('should NOT pass when function body does NOT reference any tainted symbol', () => {
        // Pure function body — no tainted symbols present
        const chunk = makeChunk('calculateTotal', `
function calculateTotal(items: Array<{ quantity: number }>): number {
    let total = 0;
    for (const item of items) {
        total += item.quantity;
    }
    return total;
}
        `);
        const taint = makeTaintInfo({ symbols: ['Pool', 'Channel', 'Connection'] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should skip generic symbols like * and default', () => {
        const chunk = makeChunk('pureFunc', 'function pureFunc() { return 42; }');
        const taint = makeTaintInfo({ symbols: ['*', 'default'] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass when the only tainted symbol match is the function\'s own name (self-reference)', () => {
        // Regression: calculateSimpleTotal is exported from a tainted file,
        // so it becomes a tainted symbol. Gate 2 would match its own declaration.
        const chunk = makeChunk('calculateSimpleTotal', `
export function calculateSimpleTotal(items: Array<{ quantity: number }>): number {
    let total = 0;
    for (const item of items) {
        total += item.quantity;
    }
    return total;
}
        `);
        const taint = makeTaintInfo({
            symbols: ['Pool', 'Channel', 'Connection', 'calculateSimpleTotal', 'isDummyUuid'],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass isDummyUuid even when it is a tainted symbol (self-reference)', () => {
        const chunk = makeChunk('isDummyUuid', `
export function isDummyUuid(str: string): boolean {
    return str.length === 36;
}
        `);
        const taint = makeTaintInfo({
            symbols: ['Pool', 'isDummyUuid', 'calculateSimpleTotal'],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should still pass when a genuine tainted symbol is used alongside a self-name', () => {
        // Even though createOrder is itself tainted, it genuinely uses Pool
        const chunk = makeChunk('createOrder', `
export async function createOrder(customerId: string) {
    const client = await Pool.connect();
    return client.query('SELECT 1');
}
        `);
        const taint = makeTaintInfo({
            symbols: ['Pool', 'createOrder'],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        // Should pass via Gate 1 (regex:database) or Gate 2 (tainted:Pool)
        expect(verdict.passed).toBe(true);
    });

    it('should handle dotted names like Class.method for self-name exclusion', () => {
        const chunk = makeChunk('FulfillmentController.validate', `
validate(x: number): boolean {
    return x > 0;
}
        `);
        const taint = makeTaintInfo({
            symbols: ['FulfillmentController', 'validate'],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });
});

// ─── Gate 3: DI Alias Detection ─────────────────────────────────────────────

describe('Gate 5 — DI Alias Detection', () => {
    it('should pass when function uses a tainted DI alias', () => {
        // Source deliberately avoids Gate 1 keywords (no fetch/query/publish etc.)
        // so the filter falls through to Gate 3 (DI alias check)
        const chunk = makeChunk('FulfillmentController.sync', 'const result = this.api.invoke(data);');
        const taint = makeTaintInfo({ aliases: [['this.api', 'ApiGateway']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(5);
            expect(verdict.reason).toBe('alias:this.api');
        }
    });

    it('should NOT pass when function does not use any DI alias', () => {
        const chunk = makeChunk('validate', 'function validate(x: number) { return x > 0; }');
        const taint = makeTaintInfo({ aliases: [['this.api', 'ApiGateway']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass when alias only appears inside a JSDoc comment (comment poisoning)', () => {
        // Regression: FulfillmentController.calculateShippingCost had a JSDoc comment
        // that mentioned "this.api" in prose, causing a false positive.
        const chunk = makeChunk('calculateShippingCost', `/**
 * Pure business logic — should still be filtered OUT
 * even with taint analysis enabled, because it doesn't reference this.api.
 */
calculateShippingCost(weight: number, distance: number): number {
    const baseCost = 5.99;
    const weightFactor = weight * 0.15;
    const distanceFactor = distance * 0.02;
    return Math.round((baseCost + weightFactor + distanceFactor) * 100) / 100;
}`);
        const taint = makeTaintInfo({ aliases: [['this.api', 'ApiGateway']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass when alias only appears inside a line comment', () => {
        const chunk = makeChunk('pureCalc', `pureCalc(x: number): number {
    // this.api is not used here
    return x * 2;
}`);
        const taint = makeTaintInfo({ aliases: [['this.api', 'ApiGateway']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });
});

// ─── Gate 4: UseCase Entrypoints ────────────────────────────────────────────

describe('Gate 1 — UseCase Entrypoints', () => {
    it('should pass application handle entrypoints even without regex or taint', () => {
        const chunk = makeChunk(
            'SearchRegistryByCriteriaUseCase.handle',
            'return this.registrySearchService.findRegistriesByCriteria(criteria, pagination);',
            'src/application/registry/SearchRegistryByCriteriaUseCase.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(1);
            expect(verdict.reason).toBe('usecase:entry-point');
        }
    });

    it('should pass .execute in *.usecase.ts files', () => {
        const chunk = makeChunk(
            'CloseMutationQuote.execute',
            'return this.quoteRepository.close(id);',
            'src/domain/quote/CloseMutationQuote.usecase.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(1);
        }
    });

    it('should NOT pass generic service methods via Gate 4', () => {
        const chunk = makeChunk(
            'RegistrySearchService.validateCriteria',
            'return Object.values(criteria).every(value => value === undefined);',
            'src/application/registry/RegistrySearchService.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });
});

// ─── Gate 5: Repository Naming Conventions ──────────────────────────────────

describe('Gate 2 — Architectural Conventions', () => {
    it('should pass repository wrapper methods via naming convention', () => {
        const chunk = makeChunk(
            'QuoteRepository.findQuoteById',
            'return this.repository.findById(id);',
            'src/infrastructure/QuoteRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(2);
            expect(verdict.reason).toBe('convention:repository-method');
        }
    });

    it('should NOT pass CRUD-like service helpers outside the data layer', () => {
        const chunk = makeChunk(
            'QuoteService.getQuoteLabel',
            'return `${quote.kind}:${quote.status}`;',
            'src/application/QuoteService.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    // Cache-style verbs (Pattern 1 from Gate 1 removal experiment) — flush, forget,
    // clear, evict, put, invalidate are I/O on cache repositories. Body kept neutral
    // (no `cache`/`memcached`/`flush` substrings outside the chunk name) so we
    // measure Gate 5 in isolation from Gate 1's regex.
    it.each([
        ['flush', 'UserStore.flush'],
        ['forget', 'UserStore.forget'],
        ['set', 'UserStore.set'],
        ['clear', 'UserStore.clear'],
        ['evict', 'UserStore.evictUser'],
        ['put', 'UserStore.putValue'],
        ['invalidate', 'UserStore.invalidateAll'],
    ])('should pass cache-verb %s on Repository/Store classes', (_verb, name) => {
        const chunk = makeChunk(name, 'return value;', 'src/infrastructure/UserStore.ts');
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) expect(verdict.gate).toBe(2);
    });

    // SQL builder verbs (Pattern 4) — join, union, aggregate, select, merge.
    // Body neutral to keep Gate 1 silent.
    it.each([
        ['join', 'AcmeSearchRepository.joinOperationToUnionOfSubQuery'],
        ['union', 'AcmeRepository.unionByDate'],
        ['aggregate', 'AcmeRepository.aggregateByMonth'],
        ['select', 'AcmeRepository.selectActiveRows'],
        ['merge', 'AcmeRepository.mergeWithDraft'],
    ])('should pass SQL-builder verb %s on Repository classes', (_verb, name) => {
        const chunk = makeChunk(name, 'return value;', 'src/infrastructure/AcmeRepository.ts');
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) expect(verdict.gate).toBe(2);
    });

    it('should NOT pass unknown verb on Repository class (guard against over-broad match)', () => {
        const chunk = makeChunk(
            'UserStore.normalizeEmailAddress',
            'return value.trim().toLowerCase();',
            'src/infrastructure/UserStore.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    // Pattern 2: anonymous arrow-functions inside a Repository class inherit
    // the class signal even when their chunk name (with_A, callback@L:C) cannot
    // match the verb whitelist. The class signal comes via chunk.parentClassName.
    it('should pass anonymous chunk (nameIsAmbiguous=true) inside a Repository class via parentClassName', () => {
        const chunk: CodeChunk = {
            ...makeChunk('with_A', 'return value;', 'src/infrastructure/AcmeRepository.ts'),
            nameIsAmbiguous: true,
            parentClassName: 'AcmeRepository',
        };
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) expect(verdict.gate).toBe(2);
    });

    it('should NOT pass anonymous chunk whose parentClassName is not a Repository (guard against over-broad match)', () => {
        const chunk: CodeChunk = {
            ...makeChunk('with_A', 'return value;', 'src/domain/Calculator.ts'),
            nameIsAmbiguous: true,
            parentClassName: 'Calculator',
        };
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass NON-ambiguous chunk with weird method name even if inside Repository (the name-resolved case keeps the verb gate)', () => {
        const chunk: CodeChunk = {
            ...makeChunk('AcmeRepository.normalizeEmail', 'return value;', 'src/infrastructure/AcmeRepository.ts'),
            nameIsAmbiguous: false,
            parentClassName: 'AcmeRepository',
        };
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });
});

// ─── Purity Veto Regression Tests ────────────────────────────────────────────

describe('Purity Veto — Pure Functions in Tainted Files', () => {
    const orderControllerTaint = makeTaintInfo({
        symbols: ['Pool', 'Channel', 'Connection'],
    });

    it('should NOT pass calculateSimpleTotal even in a tainted file', () => {
        const chunk = makeChunk('calculateSimpleTotal', `
export function calculateSimpleTotal(items: Array<{ productId: string; quantity: number }>): number {
    let total = 0;
    for (const item of items) {
        total += item.quantity;
    }
    return total;
}
        `);
        const verdict = likelyHasIOWithTaint(chunk, orderControllerTaint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass isDummyUuid even in a tainted file', () => {
        const chunk = makeChunk('isDummyUuid', `
export function isDummyUuid(str: string): boolean {
    return str.length === 36;
}
        `);
        const verdict = likelyHasIOWithTaint(chunk, orderControllerTaint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass getOrderServiceGreeting even in a tainted file', () => {
        const chunk = makeChunk('getOrderServiceGreeting', `
export function getOrderServiceGreeting(): string {
    return "Welcome to the Order Service!";
}
        `);
        const verdict = likelyHasIOWithTaint(chunk, orderControllerTaint);
        expect(verdict.passed).toBe(false);
    });

    it('should still pass createOrder which genuinely uses I/O via Gate 2 (tainted symbol)', () => {
        const chunk = makeChunk('createOrder', `
export async function createOrder(customerId: string, items: Array<{ productId: string; quantity: number }>) {
    const client = await pgPool.connect();
    const result = await client.query('INSERT INTO orders ...');
    await rabbitChannel.publish('orders_exchange', 'order.created', Buffer.from(JSON.stringify({ orderId })));
    return { orderId, status: 'PENDING' };
}
        `);
        // Include the local variable names as tainted symbols — simulates a
        // taint chain where `pgPool` and `rabbitChannel` came from imports
        // whose sources are in the sink registry.
        const taint = makeTaintInfo({ symbols: ['pgPool', 'rabbitChannel', 'Pool', 'Channel'] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) expect(verdict.gate).toBe(4);
    });
});

// ─── ORM Entity Metadata (Synthetic Chunk) ───────────────────────────────────

describe('ORM Entity Metadata — Synthetic Chunk Regression', () => {
    it('should pass Gate 6 for a Doctrine DocBlock class metadata chunk', () => {
        const chunk = makeChunk('App\\Entity\\OrderRecord::__class_metadata', `
// ORM entity
/**
 * @ORM\\Table(name="order_records")
 * @ORM\\Entity(repositoryClass="OrderRecordRepository")
 */
class OrderRecord
/** @ORM\\Column(name="customer_id", type="integer") */
protected $customerId;
const STATUS_PENDING = 'pending';
        `, 'src/Entity/OrderRecord.php', 'php');
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(3);
            expect(verdict.reason).toBe('synthetic-chunk:orm-metadata');
        }
    });

    it('should pass Gate 6 for a PHP 8 attribute class metadata chunk', () => {
        const chunk = makeChunk('App\\Entity\\OrderRecord::__class_metadata', `
// ORM entity
#[ORM\\Table(name: "order_records")]
#[ORM\\Entity]
class OrderRecordModern
protected int $id;
protected int $customerId;
        `, 'src/Entity/OrderRecordModern.php', 'php');
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(3);
            expect(verdict.reason).toBe('synthetic-chunk:orm-metadata');
        }
    });

    it('should still reject a naked PHP getter with NO class context (no context bleeding)', () => {
        const chunk = makeChunk('OrderRecord.getId', `
public function getId()
{
    return $this->id;
}
        `, 'src/Entity/OrderRecord.php');
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });
});

// ─── Polyglot Constructor Exclusion ──────────────────────────────────────────

describe('Constructor Exclusion — isDIConstructor', () => {
    it('should identify TypeScript constructors', () => {
        expect(isDIConstructor('SaveService.constructor')).toBe(true);
        expect(isDIConstructor('OrderController.constructor')).toBe(true);
    });

    it('should identify PHP constructors with namespace', () => {
        expect(isDIConstructor('App\\Service\\SaveService.__construct')).toBe(true);
        expect(isDIConstructor('TravelApp\\Events\\PubSubPublisher.__construct')).toBe(true);
    });

    it('should identify PHP constructors without namespace', () => {
        expect(isDIConstructor('SaveService.__construct')).toBe(true);
    });

    it('should identify Python __init__', () => {
        expect(isDIConstructor('SaveService.__init__')).toBe(true);
        expect(isDIConstructor('OrderRepository.__init__')).toBe(true);
    });

    it('should NOT match Go factory functions (NewXxx can do real IO)', () => {
        expect(isDIConstructor('NewSaveService')).toBe(false);
        expect(isDIConstructor('NewOrderRepository')).toBe(false);
    });

    it('should NOT match regular methods', () => {
        expect(isDIConstructor('SaveService.save')).toBe(false);
        expect(isDIConstructor('OrderController.handle')).toBe(false);
        expect(isDIConstructor('App\\Controller\\OrderController.process')).toBe(false);
    });

    it('should NOT match function names that contain constructor as a substring', () => {
        expect(isDIConstructor('constructorHelper')).toBe(false);
        expect(isDIConstructor('Service.getConstructorArgs')).toBe(false);
    });
});

describe('Constructor Exclusion — likelyHasIOWithTaint integration', () => {
    const taint = makeTaintInfo({
        symbols: ['SaveRepository', 'EventBus'],
        aliases: [['this.saveRepo', 'SaveRepository']],
    });

    it('should block TS constructor even with tainted symbols in body', () => {
        const chunk = makeChunk(
            'SaveService.constructor',
            'constructor(private saveRepo: SaveRepository, private eventBus: EventBus) {}',
        );
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should block PHP __construct even with tainted symbols in body', () => {
        const chunk: CodeChunk = {
            name: 'App\\Service\\SaveService.__construct',
            sourceCode: 'public function __construct(private SaveRepository $saveRepo, private EventBus $eventBus) {}',
            filepath: 'src/Service/SaveService.php',
            language: 'php',
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
        };
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should block Python __init__ even with tainted symbols in body', () => {
        const chunk: CodeChunk = {
            name: 'SaveService.__init__',
            sourceCode: 'def __init__(self, save_repo: SaveRepository, event_bus: EventBus): self.save_repo = save_repo',
            filepath: 'services/save_service.py',
            language: 'python',
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
        };
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT block a regular method that genuinely uses tainted symbol', () => {
        const chunk = makeChunk(
            'SaveService.persist',
            'async persist(data: any) { return this.saveRepo.save(data); }',
        );
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPT-2 — Observability Alias Blocklist
//
// Problem: `this.logger`, `this.tracer`, `this.metrics` are tainted DI aliases
// (they ARE technically I/O sinks) but they NEVER carry business data relevant
// to architectural extraction. 31 wasted LLM calls in a customer trace.
//
// Strategy: Skip Gate 3 alias matches that hit the observability blocklist.
// ═══════════════════════════════════════════════════════════════════════════════

describe('OPT-2 — Observability Alias Blocklist', () => {
    it('should NOT pass when only alias is this.logger', () => {
        const chunk = makeChunk(
            'SomeService.doWork',
            'this.logger.info("processing..."); return computeResult(data);',
        );
        const taint = makeTaintInfo({ aliases: [['this.logger', 'Logger']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass when only alias is this.tracer', () => {
        const chunk = makeChunk(
            'TracerService.trace',
            'this.tracer.startSpan("op"); return result;',
        );
        const taint = makeTaintInfo({ aliases: [['this.tracer', 'TracerService']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass when only alias is this.metrics', () => {
        const chunk = makeChunk(
            'MetricService.record',
            'this.metrics.increment("counter"); return data;',
        );
        const taint = makeTaintInfo({ aliases: [['this.metrics', 'MetricsService']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass PHP-style $this->logger', () => {
        const chunk: CodeChunk = {
            name: 'App\\Service\\Worker.process',
            sourceCode: '$this->logger->info("working"); return $result;',
            filepath: 'src/Service/Worker.php',
            language: 'php',
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
        };
        const taint = makeTaintInfo({ aliases: [['$this->logger', 'Logger']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass Python-style self.logger', () => {
        const chunk: CodeChunk = {
            name: 'Worker.process',
            sourceCode: 'self.logger.info("working"); return result',
            filepath: 'services/worker.py',
            language: 'python',
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
        };
        const taint = makeTaintInfo({ aliases: [['self.logger', 'Logger']] });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(false);
    });

    // ── Regression Safety ────────────────────────────────────────────────

    it('should STILL pass when both this.logger AND this.api are aliases', () => {
        const chunk = makeChunk(
            'SomeService.callExternal',
            'this.logger.info("calling api"); return this.api.get("/data");',
        );
        const taint = makeTaintInfo({
            aliases: [['this.logger', 'Logger'], ['this.api', 'ApiGateway']],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(5);
            expect(verdict.reason).toBe('alias:this.api');
        }
    });

    it('should STILL pass when this.logger AND this.repo are aliases', () => {
        const chunk = makeChunk(
            'UserService.saveUser',
            'this.logger.debug("saving"); return this.repo.save(user);',
        );
        const taint = makeTaintInfo({
            aliases: [['this.logger', 'Logger'], ['this.repo', 'UserRepository']],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.reason).toBe('alias:this.repo');
        }
    });

    it('should STILL pass when this.log is an alias but a non-logger alias is also present', () => {
        // After Gate 1 removal, real I/O can only fire here via Gate 2 (symbol)
        // or Gate 3 (a different, non-observability alias). The observability
        // blocklist only skips THE specific alias `this.log`; other tainted
        // aliases on the same chunk still let the chunk pass via Gate 3.
        const chunk = makeChunk(
            'SomeService.query',
            'this.log.info("querying"); return this.db.execute("SELECT 1");',
        );
        const taint = makeTaintInfo({
            aliases: [['this.log', 'Logger'], ['this.db', 'PgPool']],
        });
        const verdict = likelyHasIOWithTaint(chunk, taint);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) expect(verdict.gate).toBe(5);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPT-3 — Repository Convention Negative Method Filter
//
// Problem: Gate 5 passes ALL methods in Repository files whose name starts
// with find/get/create/etc., but helpers like `validate`, `format`, `check`,
// `build`, `map`, `transform` are pure computation. 23 wasted calls.
//
// Strategy: Add negative method-name patterns to exclude non-DB helper methods.
// ═══════════════════════════════════════════════════════════════════════════════

describe('OPT-3 — Repository Convention Negative Method Filter', () => {
    it('should NOT pass validate* methods in Repository files', () => {
        const chunk = makeChunk(
            'QuoteRepository.validateQuoteState',
            'return quote.status === "ACTIVE" && quote.amount > 0;',
            'src/infrastructure/QuoteRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass build* methods in Repository files', () => {
        const chunk = makeChunk(
            'SaveRepository.buildWhereClause',
            'return { status: "active", ...filters };',
            'src/infrastructure/repository/SaveRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass format* methods in Repository files', () => {
        const chunk = makeChunk(
            'UserRepository.formatResult',
            'return { id: row.id, name: `${row.first} ${row.last}` };',
            'src/infrastructure/repository/UserRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass map/transform/convert methods in Repository files', () => {
        const chunk = makeChunk(
            'OrderRepository.mapToEntity',
            'return { orderId: raw.id, status: raw.status_code };',
            'src/infrastructure/OrderRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    it('should NOT pass is*/has*/should* check methods in Repository files', () => {
        const chunk = makeChunk(
            'QuoteRepository.isExpired',
            'return new Date() > quote.expiresAt;',
            'src/infrastructure/QuoteRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(false);
    });

    // ── Regression Safety ────────────────────────────────────────────────

    it('should STILL pass find* methods in Repository files', () => {
        const chunk = makeChunk(
            'QuoteRepository.findQuoteById',
            'return this.repository.findById(id);',
            'src/infrastructure/QuoteRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
        if (verdict.passed) {
            expect(verdict.gate).toBe(2);
            expect(verdict.reason).toBe('convention:repository-method');
        }
    });

    it('should STILL pass save* methods in Repository files', () => {
        const chunk = makeChunk(
            'QuoteRepository.saveQuote',
            'return this.em.persist(entity);',
            'src/infrastructure/QuoteRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
    });

    it('should STILL pass delete* methods in Repository files', () => {
        const chunk = makeChunk(
            'UserRepository.deleteById',
            'return this.repo.delete({ id });',
            'src/infrastructure/repository/UserRepository.ts',
        );
        const verdict = likelyHasIOWithTaint(chunk);
        expect(verdict.passed).toBe(true);
    });
});
