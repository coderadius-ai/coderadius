import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';

let parser: Parser | null = null;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(ts.typescript as unknown as Parser.Language);
    }
    return parser;
}

function parseTree(src: string): Parser.Tree {
    return getParser().parse(src);
}

const plugin = new TypeScriptPlugin();

describe('TypeScript deterministic supplements', () => {
    it('extracts datastore declarations from TypeOrmModule.forRootAsync useFactory', () => {
        const src = `
import { TypeOrmModule } from '@nestjs/typeorm';

export const DatabaseModule = TypeOrmModule.forRootAsync({
  useFactory: () => ({
    type: 'mysql',
    host: 'db.internal',
    port: 3306,
    database: 'motor',
  }),
});
`;
        const tree = parseTree(src);
        const chunk = plugin.extractFunctions(tree, src, 'src/database.module.ts')
            .find(candidate => candidate.sourceCode.includes("database: 'motor'"));

        expect(chunk).toBeDefined();
        const supplements = plugin.extractStaticSupplements!(tree.rootNode, src, 'src/database.module.ts', chunk!);
        expect(supplements?.resourceDeclarations).toHaveLength(1);
        expect(supplements?.resourceDeclarations?.[0]).toMatchObject({
            logicalId: 'motor',
            technology: 'mysql',
            host: 'db.internal',
            port: 3306,
            dbName: 'motor',
            declarationSource: 'nestjs-for-root',
        });
        expect(supplements?.resourceDeclarations?.[0].endpointKey).toBeTruthy();
    });

    it('extracts env-backed datastore declarations from ConfigService getters', () => {
        const src = `
import { TypeOrmModule } from '@nestjs/typeorm';

const DB_NAME_KEY = 'DATABASE_NAME';

class EnvKeys {
  static readonly HOST = 'DATABASE_HOST';
}

export const DatabaseModule = TypeOrmModule.forRootAsync({
  useFactory: (cfg: ConfigService) => ({
    type: 'postgres',
    host: cfg.get(EnvKeys.HOST),
    port: Number(cfg.get('DATABASE_PORT')),
    database: cfg.get(DB_NAME_KEY),
  }),
});
`;
        const tree = parseTree(src);
        const chunk = plugin.extractFunctions(tree, src, 'src/database.module.ts')
            .find(candidate => candidate.sourceCode.includes('cfg.get(DB_NAME_KEY)'));

        expect(chunk).toBeDefined();
        const supplements = plugin.extractStaticSupplements!(tree.rootNode, src, 'src/database.module.ts', chunk!);
        expect(supplements?.resourceDeclarations).toHaveLength(1);
        expect(supplements?.resourceDeclarations?.[0]).toMatchObject({
            logicalId: 'env:database_name',
            technology: 'postgres',
            declarationSource: 'nestjs-for-root',
        });
        expect(supplements?.resourceDeclarations?.[0].dbName).toBeUndefined();
        expect(supplements?.resourceDeclarations?.[0].endpointKey).toBeUndefined();
        expect(supplements?.resourceDeclarations?.[0].configuredVia).toEqual(expect.arrayContaining([
            'DATABASE_NAME',
            'DATABASE_HOST',
            'DATABASE_PORT',
        ]));
    });

    it('extracts urql client bindings from provider useFactory', () => {
        const src = `
import { Client } from 'urql';

export const AcmePlatformClientProvider = {
  provide: ACME_PLATFORM_CLIENT_TOKEN,
  useFactory: (cfg: { baseUrl: string }) => {
    const gqlApiUrl = \`\${cfg.baseUrl}/graphql\`;
    return new Client({ url: gqlApiUrl });
  },
};
`;
        const tree = parseTree(src);
        const chunk = plugin.extractFunctions(tree, src, 'src/AcmePlatformClient.provider.ts')
            .find(candidate => candidate.sourceCode.includes('new Client'));

        expect(chunk).toBeDefined();
        const supplements = plugin.extractStaticSupplements!(tree.rootNode, src, 'src/AcmePlatformClient.provider.ts', chunk!);
        expect(supplements?.clientBindings).toHaveLength(1);
        expect(supplements?.clientBindings?.[0]).toMatchObject({
            token: 'ACME_PLATFORM_CLIENT_TOKEN',
            clientKind: 'urql',
            protocol: 'graphql',
            typeName: 'Client',
        });
        expect(supplements?.clientBindings?.[0].baseUrlHint).toContain('/graphql');
    });

    it('keeps architectural callbacks instead of dropping them as generic FP wrappers', () => {
        const src = `
class SystemEventService {
  emitPreferredResultEvent() {
    return pipe(
      'x',
      TE.chainTaskK(() =>
        this.messageEmitterService.emitEvent({
          eventName: SystemEventService.EVENT_NAME,
        }),
      ),
    );
  }
}
`;
        const tree = parseTree(src);
        const chunks = plugin.extractFunctions(tree, src, 'src/SystemEventService.ts');

        expect(chunks.some(chunk => chunk.sourceCode.includes('emitEvent({'))).toBe(true);
    });
});
