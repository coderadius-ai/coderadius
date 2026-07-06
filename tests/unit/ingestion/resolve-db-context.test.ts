/**
 * DataContainer DB Context Resolution — Unit Tests
 *
 * Tests the resolveDbContext logic and matchesTablePattern helper
 * by mirroring the pure logic from resolveContainerScope in db-scope-resolver.ts.
 *
 * The matchesTablePattern tests validate glob pattern matching independently.
 * The resolveDbContext tests verify array-order-preserving scope resolution.
 */
import { describe, it, expect } from 'vitest';
import type { RepoHints } from '../../../src/config/repo-hints.js';

// ── Mirror of private helpers ────────────────────────────────────────────────
// These must stay in sync with the implementation.

function matchesTablePattern(pattern: string, tableName: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*') && !pattern.startsWith('*')) {
        return tableName.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith('*') && !pattern.endsWith('*')) {
        return tableName.endsWith(pattern.slice(1));
    }
    return pattern === tableName;
}

/** Mirrors resolveContainerScope — iterates databases[] directly. */
function resolveDbContext(
    tableName: string,
    qualifiedRepoName: string,
    repoHints: RepoHints,
): string {
    const databases = repoHints.databases ?? [];
    for (const db of databases) {
        if (!db.tables || db.tables.length === 0) continue;
        const normalizedTable = tableName.toLowerCase();
        for (const pattern of db.tables) {
            if (matchesTablePattern(pattern.toLowerCase(), normalizedTable)) {
                return db.id;
            }
        }
    }
    return qualifiedRepoName;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REPO_NAME = 'order/payments-api';

const hintsWithScope: RepoHints = {
    decorators: [],
    databases: [
        { id: 'legacy-shared-db', technology: 'mysql', shared: false, tables: ['orders', 'users', 'wp_*', '*_logs'] },
        { id: 'inventory-db', technology: 'mysql', shared: false, tables: ['products', 'stock_items'] },
    ],
    hints: [],
    message_channels: { aliases: [] },
};

const hintsNoScope: RepoHints = {
    decorators: [],
    databases: [],
    hints: [],
    message_channels: { aliases: [] },
};

// ── matchesTablePattern ───────────────────────────────────────────────────────

describe('matchesTablePattern', () => {
    it('exact match: found', () => {
        expect(matchesTablePattern('orders', 'orders')).toBe(true);
    });

    it('exact match: not found', () => {
        expect(matchesTablePattern('orders', 'order_items')).toBe(false);
    });

    it('prefix wildcard wp_*: matches wordpress tables', () => {
        expect(matchesTablePattern('wp_*', 'wp_posts')).toBe(true);
        expect(matchesTablePattern('wp_*', 'wp_options')).toBe(true);
        expect(matchesTablePattern('wp_*', 'wp_')).toBe(true);   // edge: empty suffix
    });

    it('prefix wildcard wp_*: does NOT match non-wp table', () => {
        expect(matchesTablePattern('wp_*', 'products')).toBe(false);
        expect(matchesTablePattern('wp_*', 'wp')).toBe(false);    // must have the underscore
    });

    it('suffix wildcard *_logs: matches audit tables', () => {
        expect(matchesTablePattern('*_logs', 'audit_logs')).toBe(true);
        expect(matchesTablePattern('*_logs', 'event_logs')).toBe(true);
        expect(matchesTablePattern('*_logs', '_logs')).toBe(true);  // edge: empty prefix
    });

    it('suffix wildcard *_logs: does NOT match non-logs table', () => {
        expect(matchesTablePattern('*_logs', 'logs_archive')).toBe(false);
        expect(matchesTablePattern('*_logs', 'orders')).toBe(false);
    });

    it('match-all * matches anything', () => {
        expect(matchesTablePattern('*', 'orders')).toBe(true);
        expect(matchesTablePattern('*', 'wp_posts')).toBe(true);
        expect(matchesTablePattern('*', '')).toBe(true);
    });

    it('mid-string wildcard is treated as exact match (not supported)', () => {
        // "order_*_log" — treated as literal string, no match
        expect(matchesTablePattern('order_*_log', 'order_payment_log')).toBe(false);
    });
});

// ── resolveDbContext ──────────────────────────────────────────────────────────

describe('resolveDbContext', () => {
    it('returns qualifiedRepoName when no databases configured', () => {
        expect(resolveDbContext('orders', REPO_NAME, hintsNoScope)).toBe(REPO_NAME);
    });

    it('returns qualifiedRepoName for unmatched table even with scope configured', () => {
        expect(resolveDbContext('shipping_rates', REPO_NAME, hintsWithScope)).toBe(REPO_NAME);
    });

    it('resolves exact table name to correct db context', () => {
        expect(resolveDbContext('orders', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('users', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('products', REPO_NAME, hintsWithScope)).toBe('inventory-db');
    });

    it('resolves via prefix glob pattern (wp_*)', () => {
        expect(resolveDbContext('wp_posts', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('wp_options', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
    });

    it('resolves via suffix glob pattern (*_logs)', () => {
        expect(resolveDbContext('audit_logs', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('event_logs', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
    });

    it('is case-insensitive (tableName casing does not matter)', () => {
        expect(resolveDbContext('ORDERS', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('Orders', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
        expect(resolveDbContext('WP_POSTS', REPO_NAME, hintsWithScope)).toBe('legacy-shared-db');
    });

    it('returns first matching db when a table could match multiple (first-wins)', () => {
        const ambiguousHints: RepoHints = {
            decorators: [],
            databases: [
                { id: 'db-a', technology: 'mysql', shared: false, tables: ['users'] },
                { id: 'db-b', technology: 'mysql', shared: false, tables: ['users'] },
            ],
            hints: [],
            message_channels: { aliases: [] },
        };
        expect(resolveDbContext('users', REPO_NAME, ambiguousHints)).toBe('db-a');
    });

    it('returns qualifiedRepoName when databases have no tables', () => {
        const emptyScope: RepoHints = {
            decorators: [],
            databases: [{ id: 'empty-db', technology: 'mysql', shared: false, tables: [] }],
            hints: [],
            message_channels: { aliases: [] },
        };
        expect(resolveDbContext('orders', REPO_NAME, emptyScope)).toBe(REPO_NAME);
    });
});
