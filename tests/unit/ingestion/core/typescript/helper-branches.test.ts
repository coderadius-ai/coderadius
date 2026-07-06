import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../../src/graph/types.js';
import type { UnifiedAnalysis } from '../../../../../src/ai/agents/unified-analyzer.js';
import { TypeScriptPlugin } from '../../../../../src/ingestion/core/languages/typescript.js';
import {
    collectWorkspaceCatalogs,
    parseNpmLock,
    parsePnpmLock,
    parseYarnLock,
    resolveCatalogRef,
    resolveLockfileVersions,
} from '../../../../../src/ingestion/core/languages/typescript/dependencies.js';
import {
    buildFrameworkSignalOverlay,
    formatFrameworkSignalContext,
    matchFrameworkSignalsToChunk,
    mergeUnifiedAnalysisWithOverlay,
} from '../../../../../src/ingestion/core/framework-signal-overlay.js';
import { extractTypeScriptStaticSupplements } from '../../../../../src/ingestion/core/languages/typescript/static-supplements.js';

const plugin = new TypeScriptPlugin();
const parser = plugin.createParser();

function parseTree(source: string): Parser.Tree {
    return parser.parse(source);
}

function parseRoot(source: string): Parser.SyntaxNode {
    return parseTree(source).rootNode;
}

function makeChunk(sourceCode: string): CodeChunk {
    return {
        name: 'testChunk',
        filepath: 'src/test.ts',
        sourceCode,
        language: 'typescript',
        startLine: 1,
        startColumn: 1,
        endLine: Math.max(sourceCode.split('\n').length, 1),
        endColumn: 1,
    };
}

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-helper-'));
    try {
        await run(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('TypeScript helper branch coverage', () => {
    it('covers npm, yarn, and pnpm lockfile parser variants', async () => {
        await withTempDir(async dir => {
            const npmLegacy = path.join(dir, 'package-lock.json');
            fs.writeFileSync(npmLegacy, JSON.stringify({
                dependencies: {
                    react: { version: '18.3.0' },
                    vitest: { version: '3.2.4' },
                },
            }));

            const yarnClassic = path.join(dir, 'yarn.lock');
            fs.writeFileSync(yarnClassic, [
                '"react@^18.0.0":',
                '  version "18.3.0"',
                '',
                '"vitest@^3.0.0":',
                '  version "3.2.4"',
            ].join('\n'));

            const pnpmLegacy = path.join(dir, 'pnpm-lock.yaml');
            fs.writeFileSync(pnpmLegacy, [
                'lockfileVersion: 6.0',
                'packages:',
                '  /react/18.3.0:',
                '  /@vitest/coverage-v8/3.2.4:',
            ].join('\n'));

            const npmMap = new Map<string, string>();
            parseNpmLock(npmLegacy, npmMap);
            expect(npmMap.get('react')).toBe('18.3.0');
            expect(npmMap.get('vitest')).toBe('3.2.4');

            const yarnMap = new Map<string, string>();
            parseYarnLock(yarnClassic, yarnMap);
            expect(yarnMap.get('react')).toBe('18.3.0');
            expect(yarnMap.get('vitest')).toBe('3.2.4');

            const pnpmMap = new Map<string, string>();
            parsePnpmLock(pnpmLegacy, pnpmMap);
            expect(pnpmMap.get('react')).toBe('18.3.0');
            expect(pnpmMap.get('@vitest/coverage-v8')).toBe('3.2.4');
        });
    });

    it('covers yarn berry, pnpm v9, catalog merging, and parent lockfile lookup', async () => {
        await withTempDir(async dir => {
            fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });

            fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), [
                'catalog:',
                '  react: 19.0.0',
                'catalogs:',
                '  tools:',
                '    vitest: 3.2.4',
            ].join('\n'));
            fs.writeFileSync(path.join(dir, '.yarnrc.yml'), [
                'catalog:',
                '  react: 19.1.0',
                'catalogs:',
                '  tools:',
                '    eslint: 9.0.0',
            ].join('\n'));

            const yarnBerry = path.join(dir, 'yarn.lock');
            fs.writeFileSync(yarnBerry, [
                '__metadata:',
                '  version: 6',
                '"react@npm:^19.0.0":',
                '  version: "19.1.0"',
            ].join('\n'));

            const pnpmV9 = path.join(dir, 'pnpm-lock.yaml');
            fs.writeFileSync(pnpmV9, [
                "lockfileVersion: '9.0'",
                'packages:',
                "  'react@19.1.0':",
                "  '@vitest/coverage-v8@3.2.4':",
            ].join('\n'));

            const catalogs = collectWorkspaceCatalogs(dir);
            expect(resolveCatalogRef('catalog:', 'react', catalogs)).toBe('19.1.0');
            expect(resolveCatalogRef('catalog:tools', 'vitest', catalogs)).toBe('3.2.4');
            expect(resolveCatalogRef('catalog:tools', 'eslint', catalogs)).toBe('9.0.0');
            expect(resolveCatalogRef('^1.0.0', 'left-pad', catalogs)).toBe('^1.0.0');

            const yarnBerryMap = new Map<string, string>();
            parseYarnLock(yarnBerry, yarnBerryMap);
            expect(yarnBerryMap.get('react')).toBe('19.1.0');

            const pnpmV9Map = new Map<string, string>();
            parsePnpmLock(pnpmV9, pnpmV9Map);
            expect(pnpmV9Map.get('react')).toBe('19.1.0');
            expect(pnpmV9Map.get('@vitest/coverage-v8')).toBe('3.2.4');

            const childDir = path.join(dir, 'packages', 'api');
            expect(resolveLockfileVersions(childDir, dir).get('react')).toBe('19.1.0');
        });
    });

    it('covers supplemental Mongo, Apollo, provider factory, and null branches', () => {
        const mongoSource = `
import { MongooseModule } from '@nestjs/mongoose';

export const DatabaseModule = MongooseModule.forRootAsync({
  useFactory: () => ({
    uri: 'mongodb://mongo.internal:27018/orders',
  }),
});
`;
        const mongoTree = parseTree(mongoSource);
        const mongoChunk = plugin.extractFunctions(mongoTree, mongoSource, 'src/database.module.ts')
            .find(candidate => candidate.sourceCode.includes('orders'));
        const mongoSupplements = extractTypeScriptStaticSupplements(
            mongoTree.rootNode,
            mongoSource,
            'src/database.module.ts',
            mongoChunk!,
        );

        expect(mongoSupplements?.resourceDeclarations?.[0]).toMatchObject({
            logicalId: 'orders',
            technology: 'mongodb',
            host: 'mongo.internal',
            port: 27018,
            dbName: 'orders',
        });

        const apolloSource = `
import { ApolloClient } from '@apollo/client';

export const GqlProvider = {
  provide: 'GRAPHQL_CLIENT',
  useFactory: () => {
    const graphqlUrl = 'https://api.acme.dev/graphql';
    return new ApolloClient({ uri: graphqlUrl });
  },
};
`;
        const apolloTree = parseTree(apolloSource);
        const apolloChunk = plugin.extractFunctions(apolloTree, apolloSource, 'src/graphql.provider.ts')
            .find(candidate => candidate.sourceCode.includes('ApolloClient'));
        const apolloSupplements = extractTypeScriptStaticSupplements(
            apolloTree.rootNode,
            apolloSource,
            'src/graphql.provider.ts',
            apolloChunk!,
        );

        expect(apolloSupplements?.clientBindings?.[0]).toMatchObject({
            token: 'GRAPHQL_CLIENT',
            clientKind: 'apollo',
            typeName: 'ApolloClient',
            baseUrlHint: "'https://api.acme.dev/graphql'",
        });

        const providerChunk = makeChunk(`
function buildRepos() {
  return [new MemcachedRepository(), new InfluxDbMonitoringRepository()];
}
`);
        const providerSupplements = extractTypeScriptStaticSupplements(parseRoot(''), '', 'src/providers.ts', providerChunk);
        expect(providerSupplements?.resourceDeclarations).toEqual(expect.arrayContaining([
            expect.objectContaining({ logicalId: 'memcached', technology: 'memcached' }),
            expect.objectContaining({ logicalId: 'influxdb', technology: 'influxdb' }),
        ]));

        expect(extractTypeScriptStaticSupplements(parseRoot(''), '', 'src/empty.ts', makeChunk('const noop = true;'))).toBeNull();
    });

    it('covers framework signal formatting, matching, and overlay merges', () => {
        const source = `
import { Controller, Get, UseGuards } from '@nestjs/common';

@Controller('/users')
export class UsersController {
  @UseGuards(AuthGuard)
  @Get('/:id')
  findOne() {
    return true;
  }
}
`;
        const signals = plugin.extractFrameworkSignals!(parseRoot(source), source, 'src/users.controller.ts');
        const matched = matchFrameworkSignalsToChunk('UsersController.findOne', signals);
        const overlay = buildFrameworkSignalOverlay('UsersController.findOne', matched);

        expect(formatFrameworkSignalContext([])).toBeUndefined();
        expect(formatFrameworkSignalContext(matched)).toContain('Framework Signals');
        expect(matched.some(signal => signal.scope === 'class' && signal.ownerName === 'UsersController')).toBe(true);
        expect(overlay?.allowedInboundPaths.has('/users/:id')).toBe(true);

        const merged = mergeUnifiedAnalysisWithOverlay({
            has_io: false,
            intent: '',
            capabilities: ['http-handler'],
            infrastructure: overlay?.infrastructure ?? [],
            emergent_api_calls: overlay?.emergentApiCalls ?? [],
        } satisfies UnifiedAnalysis, overlay);

        expect(merged.has_io).toBe(true);
        expect(merged.capabilities?.filter(capability => capability === 'http-handler')).toHaveLength(1);
        expect(merged.emergent_api_calls).toHaveLength(1);
    });
});
