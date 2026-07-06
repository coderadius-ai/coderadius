import { describe, it, expect } from 'vitest';
import { buildStaticAnalysisFromResolvedInvocations } from '../../../../src/ingestion/core/value-resolution/index.js';
import type { ResolvedInvocationArg, CriticalInvocationFact } from '../../../../src/ingestion/core/value-resolution/types.js';

/**
 * Static-bypass guard: a function whose value-resolution result contains BOTH
 * a fully-resolved DB invocation AND any unresolved non-prompt-only critical
 * invocation MUST fall through to the LLM. Otherwise the message-channel-side
 * (which only resolves on the LLM path via the DI registry) is silently
 * dropped.
 *
 * Pure-resolved cases (all invocations complete + high confidence) keep
 * bypassing the LLM as before.
 */

function inv(overrides: Partial<CriticalInvocationFact> = {}): CriticalInvocationFact {
    return {
        filePath: 'src/Foo.ts',
        language: 'typescript',
        callee: 'db.execute',
        resourceExpression: '',
        resourceRole: 'sqlQuery',
        resourceType: 'Database',
        operation: 'WRITES',
        confidence: 1,
        startLine: 10,
        endLine: 20,
        ...overrides,
    };
}

function complete(invocation: CriticalInvocationFact, resolvedValue: string, confidence = 1): ResolvedInvocationArg {
    return {
        invocation,
        originalExpression: invocation.resourceExpression,
        resolvedValue,
        trace: [],
        confidence,
        complete: true,
    };
}

function incomplete(invocation: CriticalInvocationFact, confidence: number, failureReason: ResolvedInvocationArg['failureReason'] = 'unknown'): ResolvedInvocationArg {
    return {
        invocation,
        originalExpression: invocation.resourceExpression,
        trace: [],
        confidence,
        complete: false,
        failureReason,
    };
}

describe('buildStaticAnalysisFromResolvedInvocations — bypass guard', () => {
    it('returns null when ANY non-prompt-only invocation is unresolved (mixed DB+broker)', () => {
        const dbCall = complete(
            inv({
                callee: 'db.execute',
                resourceExpression: '"INSERT INTO orders ..."',
                resourceType: 'Database',
                operation: 'WRITES',
                resourceRole: 'sqlQuery',
            }),
            'INSERT INTO orders (id) VALUES (?)',
        );
        const brokerCall = incomplete(
            inv({
                callee: 'broker.publish',
                resourceExpression: 'config.topics.paymentCompleted',
                resourceType: 'MessageChannel',
                operation: 'WRITES',
                resourceRole: 'topic',
                confidence: 0.4, // low — would slip through the old 0.5 threshold
            }),
            0.4,
            'unresolved_import',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([dbCall, brokerCall]);
        expect(result).toBeNull();
    });

    it('returns null when an unresolved invocation has confidence below the old 0.5 threshold', () => {
        // Regression for Bug B: the old guard `!complete && confidence >= 0.5`
        // missed unresolved invocations whose confidence dropped below 0.5
        // (typical for failed DI lookups).
        const broker = incomplete(
            inv({
                resourceType: 'MessageChannel',
                resourceRole: 'queue',
                operation: 'WRITES',
            }),
            0.3,
            'dynamic',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([broker]);
        expect(result).toBeNull();
    });

    it('still returns the static analysis when ALL invocations are complete and high-confidence', () => {
        const dbCall = complete(
            inv({
                callee: 'collection.find',
                resourceExpression: '"users"',
                resourceType: 'Database',
                operation: 'READS',
                resourceRole: 'sqlQuery',
            }),
            'users',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([dbCall]);
        expect(result).not.toBeNull();
        expect(result!.has_io).toBe(true);
        expect(result!.infrastructure).toHaveLength(1);
        expect(result!.infrastructure[0]).toMatchObject({
            type: 'Database',
            operation: 'READS',
            name: 'users',
        });
    });

    it('returns null when input contains a prompt-only role (pre-existing safety)', () => {
        const cls = incomplete(
            inv({
                resourceType: 'MessageChannel',
                resourceRole: 'messageClass',
                operation: 'WRITES',
            }),
            0.9,
        );
        // Even though the class is "complete-ish", prompt-only roles always
        // route to the LLM. Adding a complete DB call must not unlock the
        // static path.
        const dbCall = complete(
            inv({ resourceType: 'Database', resourceRole: 'sqlQuery', operation: 'WRITES' }),
            'orders',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([cls, dbCall]);
        expect(result).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(buildStaticAnalysisFromResolvedInvocations([])).toBeNull();
    });

    it('still returns the static analysis when an unresolved Database connection-string co-exists with complete SQL', () => {
        // Regression check on the narrowed scope. A function like
        //   const pool = new Pool({ connectionString: process.env.DB_ORDERS });
        //   await pool.query('SELECT * FROM users WHERE id = $1', [...]);
        // produces both:
        //   - a complete sqlQuery invocation for `users` (resolves cleanly)
        //   - an incomplete `connectionString` Database invocation for the env var
        // The static path MUST remain valid in this case — the actual table
        // identity is fully known, only the connection metadata is opaque.
        const sqlQuery = complete(
            inv({
                callee: 'pool.query',
                resourceExpression: '"SELECT * FROM users"',
                resourceType: 'Database',
                operation: 'READS',
                resourceRole: 'sqlQuery',
            }),
            'users',
        );
        const connStringRef = incomplete(
            inv({
                callee: 'process.env',
                resourceType: 'Database',
                resourceRole: 'connectionString',
                operation: 'READS',
            }),
            0.3,
            'dynamic',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([sqlQuery, connStringRef]);
        expect(result).not.toBeNull();
        expect(result!.infrastructure.some(i => i.name === 'users' && i.type === 'Database')).toBe(true);
    });

    it('still returns the static analysis when an unresolved Cache key co-exists with complete SQL', () => {
        // Cache lookups are recovered statically when the key is a literal;
        // an unresolved cache invocation is not enough to gate the bypass.
        // Only MessageChannel triggers the guard.
        const sqlQuery = complete(
            inv({ resourceType: 'Database', resourceRole: 'sqlQuery', operation: 'WRITES' }),
            'orders',
        );
        const cacheMiss = incomplete(
            inv({ resourceType: 'Cache', resourceRole: 'cacheKey', operation: 'WRITES' }),
            0.2,
            'dynamic',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([sqlQuery, cacheMiss]);
        expect(result).not.toBeNull();
    });

    // ─── SQL-fragment guard ─────────────────────────────────────────────────
    //
    // Regression: when PHP/JS code builds a query via concatenation —
    //   $sql = 'SELECT a, b, c, ';
    //   $sql .= 'd FROM users WHERE …';
    //   $db->preparedQuery($sql, …);
    // the value resolver follows only the FIRST `=` assignment and resolves
    // `$sql` to the prefix without a table name. Previously the resolver
    // would emit a Database resource whose NAME was the SQL fragment itself
    // (`'SELECT a, b, c, '`), producing a bogus DataContainer literally
    // titled with the fragment. The guard defers the case to the LLM, which
    // sees the full source code and can extract the real table name.

    it('drops a Database resource whose resolved value is a SQL fragment without a recoverable table', () => {
        const sqlPrefix = complete(
            inv({
                callee: 'db.preparedQuery',
                resourceType: 'Database', resourceRole: 'sql', operation: 'WRITES',
            }),
            'SELECT comune, prov, istat, code AS codice_catastale, ',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([sqlPrefix]);
        // No usable name → no static infra → null analysis (LLM path takes over).
        expect(result).toBeNull();
    });

    it('keeps a Database resource when the resolved value is a clean table identifier', () => {
        // Bare identifier (no spaces, no SQL keywords) → accepted as the
        // table name even when extractSqlTableName fails to find FROM/INTO.
        const tableLiteral = complete(
            inv({
                callee: 'db.from',
                resourceType: 'Database', resourceRole: 'table', operation: 'READS',
            }),
            'users',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([tableLiteral]);
        expect(result).not.toBeNull();
        expect(result!.infrastructure[0].name).toBe('users');
    });

    it('extracts the table from a full SELECT … FROM statement', () => {
        const fullSelect = complete(
            inv({
                callee: 'db.execute',
                resourceType: 'Database', resourceRole: 'sql', operation: 'READS',
            }),
            'SELECT id, name FROM products WHERE deleted_at IS NULL',
        );
        const result = buildStaticAnalysisFromResolvedInvocations([fullSelect]);
        expect(result).not.toBeNull();
        expect(result!.infrastructure[0].name).toBe('products');
    });
});
