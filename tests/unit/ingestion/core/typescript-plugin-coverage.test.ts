import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../src/graph/types.js';
import type { ImportContext } from '../../../../src/ingestion/core/languages/types.js';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';

const plugin = new TypeScriptPlugin();
const parser = plugin.createParser();

function parseTree(source: string): Parser.Tree {
    return parser.parse(source);
}

function parseRoot(source: string): Parser.SyntaxNode {
    return parseTree(source).rootNode;
}

function makeContext(filePath: string): ImportContext {
    return {
        filePath,
        allFilePaths: new Set<string>(),
        dependencyMappings: [],
    };
}

function makeChunk(name: string, filepath: string, sourceCode = ''): CodeChunk {
    return {
        name,
        filepath,
        sourceCode,
        language: 'typescript',
        startLine: 1,
        startColumn: 1,
        endLine: Math.max(sourceCode.split('\n').length, 1),
        endColumn: 1,
    };
}

async function withTempRepo(run: (repoRoot: string) => Promise<void> | void): Promise<void> {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-plugin-'));
    try {
        await run(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

describe('TypeScriptPlugin facade smoke', () => {
    it('returns stable prompt hints and memoizes the parser', () => {
        const hints = plugin.promptHints();

        expect(hints).toContain('<typescript_rules>');
        expect(hints).toContain('PROCESS vs MODULE');
        expect(plugin.createParser()).toBe(parser);
    });
});

describe('TypeScriptPlugin.extractFunctions', () => {
    it('keeps named architecture-bearing closures and skips generic anonymous callbacks', () => {
        const source = `
const keepMe = async () => {
  return client.query({ query: USER_QUERY });
};

function orchestrate(items: string[]) {
  return items.map(item => item.toUpperCase());
}
`;
        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/orchestrate.ts');

        expect(chunks.some(chunk => chunk.sourceCode.includes('client.query'))).toBe(true);
        expect(chunks.map(chunk => chunk.name)).toEqual(expect.arrayContaining(['keepMe', 'orchestrate']));
        expect(chunks).toHaveLength(2);
    });

    it('prepends decorators and comments to extracted method chunks', () => {
        const source = `
class UsersController {
  // docs
  @Get('/users')
  findAll() {
    return [];
  }
}
`;
        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/users.controller.ts');
        const methodChunk = chunks.find(chunk => chunk.name === 'UsersController.findAll');

        expect(methodChunk?.sourceCode.startsWith("// docs\n@Get('/users')")).toBe(true);
    });
});

describe('TypeScriptPlugin.extractStaticInfra', () => {
    it('returns null for malformed synthetic route chunks', () => {
        expect(plugin.extractStaticInfra(parseRoot(''), makeChunk('BROKEN::__route_handler', 'src/broken.ts'))).toBeNull();
        expect(plugin.extractStaticInfra(parseRoot(''), makeChunk('BROKEN::__server_action', 'src/actions.ts'))).toBeNull();
    });

    it('falls back to inferred ORM names and unknown frameworks when needed', () => {
        const metadataChunk = makeChunk('AuditLogModel::__class_metadata', 'src/models/AuditLogModel.ts', 'class AuditLogModel {}');
        const metadata = plugin.extractStaticInfra(parseRoot(''), metadataChunk);
        const route = plugin.extractStaticInfra(parseRoot(''), makeChunk('POST /ping::__route_handler', 'src/http/handler.ts'));

        expect(metadata?.infrastructure[0].name).toBe('audit_log');
        expect(route?.emergent_api_calls[0].framework).toBe('Unknown framework');
    });
});

describe('TypeScriptPlugin.extractEnvVars', () => {
    it('extracts env vars from process.env, bracket access, and config getters', () => {
        const root = parseRoot(`
function loadConfig() {
  const host = process.env.DB_HOST;
  const port = process.env['DB_PORT'];
  const name = cfg.get(DB_NAME_KEY);
  const secure = configService.getOrThrow<boolean>('TLS_ENABLED');
  const ignored = process.env[dynamicKey];
}
const DB_NAME_KEY = 'DATABASE_NAME';
`);

        expect(plugin.extractEnvVars(root)).toEqual(expect.arrayContaining([
            'DB_HOST',
            'DB_PORT',
        ]));
    });
});

describe('TypeScriptPlugin import/export helpers', () => {
    it('extracts ESM and require imports with correct specifiers', () => {
        const root = parseRoot(`
import DefaultClient, { type QueryResult, execute as run } from './client';
import * as fs from 'node:fs';
const localConfig = require('./config');
const lodash = require('lodash');
`);

        expect(plugin.extractImports(root, makeContext('src/index.ts'))).toEqual([
            {
                source: './client',
                specifiers: ['DefaultClient', 'QueryResult', 'execute'],
                isExternal: false,
                specifierBindings: [
                    { imported: 'default', local: 'DefaultClient', kind: 'default' },
                    { imported: 'QueryResult', local: 'QueryResult', kind: 'named' },
                    { imported: 'execute', local: 'run', kind: 'named' },
                ],
            },
            {
                source: 'node:fs',
                specifiers: ['*'],
                isExternal: true,
                specifierBindings: [{ imported: '*', local: 'fs', kind: 'namespace' }],
            },
            { source: './config', specifiers: ['default'], isExternal: false },
            { source: 'lodash', specifiers: ['default'], isExternal: true },
        ]);
    });

    it('extracts direct exports, export clauses, and top-level declarations', () => {
        const root = parseRoot(`
export interface UserView { id: string; }
export type SavePayload = { id: string };
export class ExportedController {}
export function runJob() {}
export { runJob as executeJob, helper };

class InternalClass {}
function helper() {}
`);

        expect(plugin.extractExports(root)).toEqual([
            'UserView',
            'SavePayload',
            'ExportedController',
            'runJob',
            'helper',
            'InternalClass',
        ]);
    });
});

describe('TypeScriptPlugin.extractClassPropertyAliases', () => {
    it('extracts aliases from typed fields and constructor-promoted properties', () => {
        const root = parseRoot(`
class Handler {
  private api!: ApiGateway<Client>;
  private untyped;

  constructor(private readonly logger: Logger, plain: string) {}
}
`);

        expect(plugin.extractClassPropertyAliases(root)).toEqual([
            { propertyAccess: 'this.api', typeName: 'ApiGateway' },
            { propertyAccess: 'this.logger', typeName: 'Logger' },
        ]);
    });
});

describe('TypeScriptPlugin.extractDependencyBindings', () => {
    it('extracts and dedupes Nest-style provider bindings', () => {
        const root = parseRoot(`
const providers = [
  { provide: TOKEN, useClass: DefaultClient },
  { provide: TOKEN, useClass: DefaultClient },
  { provide: 'CACHE_TOKEN', useExisting: CacheService },
  { provide: Tokens.Api, useExisting: ExistingClient },
];
`);

        expect(plugin.extractDependencyBindings(root, 'src/providers.ts')).toEqual([
            { provide: 'TOKEN', target: 'DefaultClient', filePath: 'src/providers.ts', bindingType: 'useClass' },
            { provide: 'CACHE_TOKEN', target: 'CacheService', filePath: 'src/providers.ts', bindingType: 'useExisting' },
            { provide: 'Tokens.Api', target: 'ExistingClient', filePath: 'src/providers.ts', bindingType: 'useExisting' },
        ]);
    });
});

describe('TypeScriptPlugin type extraction', () => {
    it('extracts class, interface, and type-alias definitions', () => {
        const root = parseRoot(`
class UserEntity {
  id!: string;
  metadata;

  constructor(private readonly transport: Transport) {}
}

interface SaveInput {
  amount: number;
}

type SaveResult = {
  ok: boolean;
};
`);
        const defs = plugin.extractTypeDefinitions(root);

        expect(defs.get('UserEntity')).toEqual({
            name: 'UserEntity',
            kind: 'class',
            properties: [
                { name: 'id', type: 'string' },
                { name: 'metadata', type: 'any' },
                { name: 'transport', type: 'Transport' },
            ],
        });
        expect(defs.get('SaveInput')).toEqual({
            name: 'SaveInput',
            kind: 'interface',
            properties: [{ name: 'amount', type: 'number' }],
            interfaceRole: 'data',
        });
        expect(defs.get('SaveResult')).toEqual({
            name: 'SaveResult',
            kind: 'type',
            properties: [{ name: 'ok', type: 'boolean' }],
        });
    });

    it('extracts referenced types from class methods and ignores built-in constructors', () => {
        const root = parseRoot(`
class SaveHandler {
  handle(input: UserPayload, config?: ClientConfig): SaveResult {
    const client = new ApiClient();
    const now = new Date();
    return {} as SaveResult;
  }
}
`);
        const refs = plugin.extractReferencedTypes(root);

        expect(refs.get('SaveHandler.handle')).toEqual(expect.arrayContaining([
            'UserPayload',
            'ClientConfig',
            'SaveResult',
            'ApiClient',
        ]));
        expect(refs.get('SaveHandler.handle')).not.toContain('Date');
    });
});

describe('TypeScriptPlugin analyzer helpers', () => {
    it('extracts import statements and constructor source maps', () => {
        const source = `
import { ApiClient } from './client';
import type { SaveInput } from './types';

class SaveService {
  constructor(private readonly client: ApiClient) {}
}

class Stateless {}
`;
        const root = parseRoot(source);

        expect(plugin.extractImportStatements(root)).toEqual([
            "import { ApiClient } from './client';",
            "import type { SaveInput } from './types';",
        ]);
        expect(plugin.extractConstructorSources(root)).toEqual(new Map([
            ['SaveService', 'constructor(private readonly client: ApiClient) {}'],
        ]));
    });

    it('extracts only safe module and static readonly constants', () => {
        const root = parseRoot(`
const TOPIC = 'order.save';
const PORT = 3000;
const RAW = \`plain-template\`;
const DYNAMIC = \`${'${env}'}-suffix\`;
let IGNORED = 'nope';

class SaveEvents {
  static readonly CREATED = 'save.created';
  static readonly LABEL = \`save-label\`;
  static readonly MIXED = \`${'${scope}'}-value\`;
  readonly perInstance = 'skip';
}
`);

        expect(plugin.extractFileConstants(root)).toEqual([
            { scope: '', name: 'TOPIC', value: '"order.save"' },
            { scope: '', name: 'PORT', value: '3000' },
            { scope: '', name: 'RAW', value: '"plain-template"' },
            { scope: 'SaveEvents', name: 'CREATED', value: '"save.created"' },
            { scope: 'SaveEvents', name: 'LABEL', value: '"save-label"' },
            { scope: 'SaveEvents', name: 'perInstance', value: '"skip"' },
        ]);
    });
});

describe('TypeScriptPlugin.validateInboundPath', () => {
    it('validates GraphQL, literal HTTP paths, and segment fallback while rejecting noisy matches', () => {
        const graphqlSource = `
@Query(() => User, { name: 'user' })
findOne() {
  return true;
}
`;
        const httpSource = `
router.get('/api/v1/records/archive', handler);
router.get('/users/:id', userHandler);
logger.info('/pay_attention_to_this_warning');
`;

        expect(plugin.validateInboundPath('GRAPHQL QUERY user', graphqlSource)).toBe(true);
        expect(plugin.validateInboundPath('GRAPHQL QUERY account', 'const resolvers = { Query: { account() {} } };')).toBeUndefined();
        expect(plugin.validateInboundPath('/api/v1/records/archive', httpSource)).toBe(true);
        expect(plugin.validateInboundPath('/api/users/{id}', httpSource)).toBe(true);
        expect(plugin.validateInboundPath('/pay', httpSource)).toBe(false);
    });
});

describe('TypeScriptPlugin.extractDependencies', () => {
    it('resolves workspace catalog refs and root package-lock versions', async () => {
        await withTempRepo(async repoRoot => {
            fs.mkdirSync(path.join(repoRoot, 'packages', 'api'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), [
                'packages:',
                '  - packages/*',
                'catalog:',
                '  react: 19.0.0',
            ].join('\n'));
            fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
                name: 'repo',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'repo' },
                    'node_modules/react': { version: '19.1.0' },
                    'node_modules/vitest': { version: '3.2.4' },
                },
            }));
            fs.writeFileSync(path.join(repoRoot, 'packages', 'api', 'package.json'), JSON.stringify({
                name: '@acme/api',
                dependencies: { react: 'catalog:' },
                devDependencies: { vitest: '^3.0.0' },
            }));

            const deps = await plugin.extractDependencies(repoRoot);

            expect(deps).toEqual(expect.arrayContaining([
                {
                    name: 'react',
                    ecosystem: 'npm',
                    declaredRange: '19.0.0',
                    lockedVersion: '19.1.0',
                    isDev: false,
                },
                {
                    name: 'vitest',
                    ecosystem: 'npm',
                    declaredRange: '^3.0.0',
                    lockedVersion: '3.2.4',
                    isDev: true,
                },
            ]));
        });
    });
});
