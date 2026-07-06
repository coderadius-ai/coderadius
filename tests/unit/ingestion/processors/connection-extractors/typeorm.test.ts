import { describe, it, expect } from 'vitest';
import { typeormExtractor } from '../../../../../src/ingestion/processors/connection-extractors/plugins/typeorm.js';

const ctx = { repoPath: '/tmp/repo' };

describe('typeorm extractor', () => {
    it('matches data-source.ts and ormconfig.ts', () => {
        expect(typeormExtractor.matches('/r/data-source.ts', 'data-source.ts')).toBe(true);
        expect(typeormExtractor.matches('/r/src/ormconfig.ts', 'ormconfig.ts')).toBe(true);
        expect(typeormExtractor.matches('/r/random.ts', 'random.ts')).toBe(false);
    });

    it('parses literal database/host/port from new DataSource({...})', () => {
        const src = `
            import { DataSource } from 'typeorm';
            export const AppDataSource = new DataSource({
                type: 'mysql',
                host: 'db.acme.com',
                port: 3306,
                database: 'app_main',
                entities: [User, Order],
                synchronize: false,
            });
        `;
        const out = typeormExtractor.extract('/r/data-source.ts', src, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].technology).toBe('mysql');
        expect(out[0].host).toBe('db.acme.com');
        expect(out[0].port).toBe(3306);
        expect(out[0].dbName).toBe('app_main');
        expect(out[0].templateSyntax).toBe('none');
        expect(out[0].entityBindings).toEqual(expect.arrayContaining(['User', 'Order']));
    });

    it('preserves process.env templates verbatim', () => {
        const src = `
            new DataSource({
                type: 'mysql',
                host: process.env.DATABASE_HOST,
                port: 3306,
                database: process.env.DATABASE_NAME,
                entities: [Save],
            });
        `;
        const out = typeormExtractor.extract('/r/data-source.ts', src, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].host).toContain('process.env.DATABASE_HOST');
        expect(out[0].dbName).toContain('process.env.DATABASE_NAME');
        expect(out[0].templateSyntax).toBe('js-template');
        expect(out[0].entityBindings).toEqual(['Save']);
    });

    it('handles postgres with bracket-form process.env', () => {
        const src = `
            new DataSource({
                type: 'postgres',
                host: process.env['PG_HOST'],
                port: 5432,
                database: process.env["PG_DB"],
                entities: [Quote],
            });
        `;
        const out = typeormExtractor.extract('/r/data-source.ts', src, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].technology).toBe('postgres');
        expect(out[0].templateSyntax).toBe('js-template');
    });

    it('returns empty when type/host/database are missing', () => {
        const src = `new DataSource({ name: 'cache', entities: [] });`;
        expect(typeormExtractor.extract('/r/data-source.ts', src, ctx)).toEqual([]);
    });
});
