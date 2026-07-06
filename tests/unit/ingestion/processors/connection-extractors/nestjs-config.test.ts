import { describe, it, expect } from 'vitest';
import {
    extractZodSchemaKeys,
    classifyDatabaseKeys,
    buildHintsFromClassified,
    nestjsConfigExtractor,
} from '../../../../../src/ingestion/processors/connection-extractors/plugins/nestjs-config.js';

const ctx = { repoPath: '/tmp/repo' };

// ─── extractZodSchemaKeys ────────────────────────────────────────────────────

describe('extractZodSchemaKeys', () => {
    it('extracts SCREAMING_SNAKE keys from z.object block', () => {
        const src = `
            const schema = z.object({
                DATABASE_HOST: z.string().min(1),
                DATABASE_PORT: z.string().min(1).optional(),
                DATABASE_NAME: z.string().min(1),
                DATABASE_USER: z.string().min(1),
            })
        `;
        const blocks = extractZodSchemaKeys(src);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].keys).toEqual([
            'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER',
        ]);
        expect(blocks[0].literals.size).toBe(0);
    });

    it('extracts z.literal values', () => {
        const src = `
            z.object({
                DATABASE_TYPE: z.literal('mysql'),
                DATABASE_HOST: z.string(),
                DATABASE_NAME: z.string(),
            })
        `;
        const blocks = extractZodSchemaKeys(src);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].literals.get('DATABASE_TYPE')).toBe('mysql');
    });

    it('handles z.strictObject', () => {
        const src = `
            z.strictObject({
                DB_HOST: z.string(),
                DB_NAME: z.string(),
            })
        `;
        const blocks = extractZodSchemaKeys(src);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].keys).toEqual(['DB_HOST', 'DB_NAME']);
    });

    it('finds multiple z.object blocks', () => {
        const src = `
            const mysqlSchema = z.object({
                MYSQL_HOST: z.string(),
                MYSQL_DATABASE: z.string(),
            })
            const mongoSchema = z.object({
                MONGO_HOST: z.string(),
                MONGO_DBNAME: z.string(),
            })
        `;
        const blocks = extractZodSchemaKeys(src);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].keys).toContain('MYSQL_HOST');
        expect(blocks[1].keys).toContain('MONGO_HOST');
    });

    it('ignores lowercase keys (not env vars)', () => {
        const src = `
            z.object({
                host: z.string(),
                DATABASE_HOST: z.string(),
                port: z.number(),
            })
        `;
        const blocks = extractZodSchemaKeys(src);
        expect(blocks).toHaveLength(1);
        // Only the uppercase key is captured
        expect(blocks[0].keys).toEqual(['DATABASE_HOST']);
    });

    it('returns empty for content without z.object', () => {
        const src = `const x = { DATABASE_HOST: 'localhost' };`;
        expect(extractZodSchemaKeys(src)).toEqual([]);
    });
});

// ─── classifyDatabaseKeys ────────────────────────────────────────────────────

describe('classifyDatabaseKeys', () => {
    it('classifies standard DATABASE_* keys', () => {
        const classified = classifyDatabaseKeys(
            ['DATABASE_TYPE', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER'],
            new Map([['DATABASE_TYPE', 'mysql']]),
        );
        expect(classified).not.toBeNull();
        expect(classified!.hostKey).toBe('DATABASE_HOST');
        expect(classified!.dbNameKey).toBe('DATABASE_NAME');
        expect(classified!.portKey).toBe('DATABASE_PORT');
        expect(classified!.technologyKey).toBe('DATABASE_TYPE');
        expect(classified!.technologyLiteral).toBe('mysql');
    });

    it('returns null when host is missing', () => {
        const classified = classifyDatabaseKeys(
            ['DATABASE_NAME', 'DATABASE_TYPE'],
            new Map(),
        );
        expect(classified).toBeNull();
    });

    it('returns null when dbName is missing', () => {
        const classified = classifyDatabaseKeys(
            ['DATABASE_HOST', 'DATABASE_TYPE'],
            new Map(),
        );
        expect(classified).toBeNull();
    });

    it('excludes password-like keys from dbName', () => {
        // DATABASE_PASSWORD matches the NAME regex but should be excluded
        const classified = classifyDatabaseKeys(
            ['DATABASE_HOST', 'DATABASE_PASSWORD'],
            new Map(),
        );
        expect(classified).toBeNull(); // no valid dbName found
    });

    it('handles TYPEORM_* naming convention', () => {
        const classified = classifyDatabaseKeys(
            ['TYPEORM_HOST', 'TYPEORM_DATABASE', 'TYPEORM_PORT'],
            new Map(),
        );
        expect(classified).not.toBeNull();
        expect(classified!.hostKey).toBe('TYPEORM_HOST');
        expect(classified!.dbNameKey).toBe('TYPEORM_DATABASE');
        expect(classified!.portKey).toBe('TYPEORM_PORT');
    });
});

// ─── buildHintsFromClassified ────────────────────────────────────────────────

describe('buildHintsFromClassified', () => {
    it('emits a hint with process.env templates', () => {
        const hints = buildHintsFromClassified({
            hostKey: 'DATABASE_HOST',
            dbNameKey: 'DATABASE_NAME',
            portKey: 'DATABASE_PORT',
            technologyKey: 'DATABASE_TYPE',
            technologyLiteral: 'mysql',
        }, 'src/db.config.ts');
        expect(hints).toHaveLength(1);
        expect(hints[0].technology).toBe('mysql');
        expect(hints[0].host).toBe('process.env.DATABASE_HOST');
        expect(hints[0].dbName).toBe('process.env.DATABASE_NAME');
        expect(hints[0].portTemplate).toBe('process.env.DATABASE_PORT');
        expect(hints[0].port).toBe(0);
        expect(hints[0].templateSyntax).toBe('js-template');
        expect(hints[0].confidence).toBe('medium');
    });

    it('uses template for technology when no literal', () => {
        const hints = buildHintsFromClassified({
            hostKey: 'DB_HOST',
            dbNameKey: 'DB_NAME',
            technologyKey: 'DB_TYPE',
        }, 'src/db.config.ts');
        expect(hints).toHaveLength(1);
        expect(hints[0].technology).toBe('process.env.DB_TYPE');
    });

    it('returns empty when no technology signal', () => {
        const hints = buildHintsFromClassified({
            hostKey: 'DB_HOST',
            dbNameKey: 'DB_NAME',
        }, 'src/db.config.ts');
        expect(hints).toEqual([]);
    });

    it('omits portTemplate when portKey is absent', () => {
        const hints = buildHintsFromClassified({
            hostKey: 'DATABASE_HOST',
            dbNameKey: 'DATABASE_NAME',
            technologyKey: 'DATABASE_TYPE',
            technologyLiteral: 'postgres',
        }, 'src/db.config.ts');
        expect(hints).toHaveLength(1);
        expect(hints[0].portTemplate).toBeUndefined();
    });
});

// ─── nestjsConfigExtractor (integration) ─────────────────────────────────────

describe('nestjsConfigExtractor', () => {
    it('matches *.config.ts files', () => {
        expect(nestjsConfigExtractor.matches('/r/Database.config.ts', 'Database.config.ts')).toBe(true);
        expect(nestjsConfigExtractor.matches('/r/app.config.js', 'app.config.js')).toBe(true);
        expect(nestjsConfigExtractor.matches('/r/Database.module.ts', 'Database.module.ts')).toBe(false);
        expect(nestjsConfigExtractor.matches('/r/tsconfig.ts', 'tsconfig.ts')).toBe(false);
    });

    it('extracts from a realistic NestJS registerAs + Zod config file', () => {
        const src = `
            import { type ConfigType, registerAs } from '@nestjs/config'
            import { z } from 'zod'

            const schema = z.object({
                DATABASE_TYPE: z.literal('mysql'),
                DATABASE_HOST: z.string().min(1),
                DATABASE_PORT: z.string().min(1).optional(),
                DATABASE_PASSWORD: z.string().min(1),
                DATABASE_NAME: z.string().min(1),
                DATABASE_USER: z.string().min(1),
                DATABASE_POOL_SIZE: z.string().min(1),
            })

            const register = registerAs('database', () => {
                const config = schema.parse(process.env)
                return {
                    type: config.DATABASE_TYPE,
                    host: config.DATABASE_HOST,
                    port: config.DATABASE_PORT ? parseInt(config.DATABASE_PORT, 10) : 5432,
                    password: config.DATABASE_PASSWORD,
                    database: config.DATABASE_NAME,
                    username: config.DATABASE_USER,
                    poolSize: parseInt(config.DATABASE_POOL_SIZE, 10),
                }
            })

            export type IConfigDatabase = ConfigType<typeof register>
            export default register
        `;
        const out = nestjsConfigExtractor.extract('/tmp/repo/src/db/Database.config.ts', src, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].technology).toBe('mysql');
        expect(out[0].host).toBe('process.env.DATABASE_HOST');
        expect(out[0].dbName).toBe('process.env.DATABASE_NAME');
        expect(out[0].portTemplate).toBe('process.env.DATABASE_PORT');
        expect(out[0].templateSyntax).toBe('js-template');
        expect(out[0].sourceFile).toBe('src/db/Database.config.ts');
    });

    it('returns empty for non-registerAs config files', () => {
        const src = `
            export default {
                DATABASE_HOST: 'localhost',
                DATABASE_NAME: 'mydb',
            };
        `;
        expect(nestjsConfigExtractor.extract('/r/app.config.ts', src, ctx)).toEqual([]);
    });

    it('returns empty for registerAs without z.object', () => {
        const src = `
            import { registerAs } from '@nestjs/config'
            export default registerAs('cache', () => ({
                ttl: parseInt(process.env.CACHE_TTL ?? '60', 10),
            }));
        `;
        expect(nestjsConfigExtractor.extract('/r/cache.config.ts', src, ctx)).toEqual([]);
    });

    it('returns empty when schema has no DB-relevant keys', () => {
        const src = `
            import { registerAs } from '@nestjs/config'
            import { z } from 'zod'
            const schema = z.object({
                APP_PORT: z.string(),
                JWT_SECRET: z.string(),
                LOG_LEVEL: z.string(),
            })
            export default registerAs('app', () => schema.parse(process.env));
        `;
        expect(nestjsConfigExtractor.extract('/r/app.config.ts', src, ctx)).toEqual([]);
    });
});
