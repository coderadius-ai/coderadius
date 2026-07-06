import { describe, it, expect } from 'vitest';
import { doctrineExtractor } from '../../../../../src/ingestion/processors/connection-extractors/plugins/doctrine.js';

const ctx = { repoPath: '/r' };

describe('doctrine extractor', () => {
    it('matches config/packages/doctrine.yaml and env-suffixed variants', () => {
        expect(doctrineExtractor.matches('/r/config/packages/doctrine.yaml', 'doctrine.yaml')).toBe(true);
        expect(doctrineExtractor.matches('/r/config/packages/prod/doctrine.yaml', 'doctrine.yaml')).toBe(true);
        expect(doctrineExtractor.matches('/r/config/doctrine.yaml', 'doctrine.yaml')).toBe(true);
        expect(doctrineExtractor.matches('/r/random/doctrine.yaml', 'doctrine.yaml')).toBe(false);
    });

    it('parses dbal.connections.<alias>.url with %env(resolve:...)% template', () => {
        const yml = `
doctrine:
    dbal:
        connections:
            default:
                url: '%env(resolve:DATABASE_URL)%'
                driver: pdo_mysql
            legacy:
                url: '%env(resolve:LEGACY_URL)%'
                driver: pdo_mysql
        `;
        const out = doctrineExtractor.extract('/r/config/packages/doctrine.yaml', yml, ctx);
        expect(out).toHaveLength(2);
        expect(out[0].connectionAlias).toBe('default');
        expect(out[0].technology).toBe('mysql');
        expect(out[0].templateSyntax).toBe('symfony-env');
    });

    it('parses literal dbname/host/port (single-connection shorthand)', () => {
        const yml = `
doctrine:
    dbal:
        driver: pdo_mysql
        host: db.acme.com
        port: 3306
        dbname: app_main
        `;
        const out = doctrineExtractor.extract('/r/config/packages/doctrine.yaml', yml, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].connectionAlias).toBe('default');
        expect(out[0].technology).toBe('mysql');
        expect(out[0].host).toBe('db.acme.com');
        expect(out[0].port).toBe(3306);
        expect(out[0].dbName).toBe('app_main');
        expect(out[0].templateSyntax).toBe('none');
    });

    it('binds entity-manager mapping prefixes to connection alias', () => {
        const yml = `
doctrine:
    dbal:
        connections:
            shared:
                url: '%env(resolve:DATABASE_URL)%'
                driver: pdo_mysql
    orm:
        entity_managers:
            default:
                connection: shared
                mappings:
                    Warranty:
                        prefix: 'App\\Warranty\\Entity'
                    Customer:
                        prefix: 'App\\Customer\\Entity'
        `;
        const out = doctrineExtractor.extract('/r/config/packages/doctrine.yaml', yml, ctx);
        expect(out).toHaveLength(1);
        expect(out[0].entityBindings).toEqual(expect.arrayContaining(['App\\Warranty\\Entity', 'App\\Customer\\Entity']));
    });

    it('returns empty when driver/url are missing', () => {
        const yml = `doctrine:\n    dbal:\n        host: x\n`;
        expect(doctrineExtractor.extract('/r/config/packages/doctrine.yaml', yml, ctx)).toEqual([]);
    });
});
