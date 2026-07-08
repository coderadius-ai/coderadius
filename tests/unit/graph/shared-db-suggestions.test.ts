/**
 * Pins the pure grouping logic behind `cr doctor`'s shared-database
 * suggester: raw cross-repo DataContainer candidate pairs → per-database
 * `databases[]` declaration suggestions.
 *
 * The corroboration gate is the endpoint dbName (modulo env suffix), NOT the
 * table name — two repos both having a `users` table is noise; two repos
 * whose endpoints resolve the same database name is signal.
 */
import { describe, it, expect } from 'vitest';
import {
    groupSharedDbSuggestions,
    type SharedDbCandidateRow,
} from '../../../src/graph/queries/doctor.js';

function row(overrides: Partial<SharedDbCandidateRow> = {}): SharedDbCandidateRow {
    return {
        tableName: 'shipments',
        repoA: 'acme/orders',
        repoB: 'acme/billing',
        namespaceA: 'acme/orders',
        namespaceB: 'acme/billing',
        technologyA: 'mysql',
        technologyB: 'mysql',
        dbNameA: 'commerce',
        dbNameB: 'commerce',
        ...overrides,
    };
}

describe('groupSharedDbSuggestions', () => {
    it('suggests one shared database for identical dbNames across scopes', () => {
        const suggestions = groupSharedDbSuggestions([row()]);
        expect(suggestions).toEqual([{
            id: 'commerce',
            technology: 'mysql',
            repos: ['acme/billing', 'acme/orders'],
            tables: ['shipments'],
        }]);
    });

    it('matches dbNames modulo env suffix (commerce vs commerce-dev) and keys on the root', () => {
        const suggestions = groupSharedDbSuggestions([
            row({ dbNameA: 'commerce', dbNameB: 'commerce-dev' }),
        ]);
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].id).toBe('commerce');
    });

    it('merges tables and repos of the same database into one suggestion', () => {
        const suggestions = groupSharedDbSuggestions([
            row({ tableName: 'shipments' }),
            row({ tableName: 'invoices' }),
            row({
                tableName: 'shipments',
                repoB: 'acme/inventory',
                namespaceB: 'acme/inventory',
                dbNameB: 'commerce_prod',
            }),
        ]);
        expect(suggestions).toEqual([{
            id: 'commerce',
            technology: 'mysql',
            repos: ['acme/billing', 'acme/inventory', 'acme/orders'],
            tables: ['invoices', 'shipments'],
        }]);
    });

    it('rejects pairs whose dbName roots differ (same table name is not evidence)', () => {
        expect(groupSharedDbSuggestions([
            row({ dbNameA: 'orders', dbNameB: 'billing' }),
        ])).toEqual([]);
    });

    it('skips pairs already declared shared (namespace = shared)', () => {
        expect(groupSharedDbSuggestions([
            row({ namespaceA: 'shared' }),
        ])).toEqual([]);
        expect(groupSharedDbSuggestions([
            row({ namespaceB: 'shared' }),
        ])).toEqual([]);
    });

    it('drops a database whose sides disagree on technology (conflicting evidence)', () => {
        expect(groupSharedDbSuggestions([
            row({ technologyA: 'mysql', technologyB: 'postgresql' }),
        ])).toEqual([]);
    });

    it('takes the non-null technology when only one side knows it', () => {
        const suggestions = groupSharedDbSuggestions([
            row({ technologyA: null, technologyB: 'mysql' }),
        ]);
        expect(suggestions[0].technology).toBe('mysql');
    });

    it('keeps distinct databases as distinct suggestions', () => {
        const suggestions = groupSharedDbSuggestions([
            row(),
            row({
                tableName: 'campaigns',
                dbNameA: 'marketing',
                dbNameB: 'marketing-dev',
                technologyA: 'postgresql',
                technologyB: 'postgresql',
            }),
        ]);
        expect(suggestions.map(s => s.id).sort()).toEqual(['commerce', 'marketing']);
    });
});
