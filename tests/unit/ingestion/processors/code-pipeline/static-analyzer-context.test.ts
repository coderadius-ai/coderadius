import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTask } from '../../../../../src/ingestion/processors/code-pipeline/types.js';
import type { FileImportMap, FileTaintInfo } from '../../../../../src/ingestion/core/import-graph.js';
import type { ResolvedConstant } from '../../../../../src/ingestion/core/languages/types.js';

const { getLanguagePluginMock } = vi.hoisted(() => ({
    getLanguagePluginMock: vi.fn(),
}));

vi.mock('../../../../../src/ingestion/core/languages/registry.js', () => ({
    getLanguagePlugin: getLanguagePluginMock,
}));

import {
    buildClientBindingContext,
    buildGraphQLDocumentContext,
    buildTaintContextSummary,
    collectResolvedConstantsForTask,
    deriveClassName,
    extractGraphQLDocumentsFromSource,
    formatFileConstantsContext,
    formatResolvedConstantsContext,
    formatTypeDefinitions,
    isGeneratedFPCallback,
    makeFunctionIdForRepo,
    resolveImportSourceForFile,
} from '../../../../../src/ingestion/processors/code-pipeline/static-analyzer-context.js';

function makeTask(overrides: Partial<AnalysisTask> = {}): AnalysisTask {
    return {
        kind: 'analysis',
        functionId: 'urn:function:repo:src/service.ts:MyService.handle',
        functionHash: 'hash',
        chunk: {
            name: 'MyService.handle',
            filepath: 'src/service.ts',
            sourceCode: 'return EVENT_NAME + ImportedTopic + GetUsers;',
            language: 'typescript',
            startLine: 1,
            startColumn: 0,
            endLine: 5,
            endColumn: 0,
        },
        fileContext: {
            absolutePath: '/tmp/repo/src/service.ts',
            relativePath: 'src/service.ts',
            repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
            routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
            fileHash: 'file-hash',
            ownerService: null,
            isManifest: false,
        },
        ...overrides,
    };
}

describe('static-analyzer-context', () => {
    beforeEach(() => {
        getLanguagePluginMock.mockReset();
    });

    it('builds distinct function ids for ambiguous chunks', () => {
        const first = makeFunctionIdForRepo(
            { name: 'repo', org: 'acme' },
            'src/service.ts',
            {
                name: 'map_callback',
                filepath: 'src/service.ts',
                sourceCode: 'a',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 1,
                endColumn: 10,
                nameIsAmbiguous: true,
            },
        );
        const second = makeFunctionIdForRepo(
            { name: 'repo', org: 'acme' },
            'src/service.ts',
            {
                name: 'map_callback',
                filepath: 'src/service.ts',
                sourceCode: 'a',
                language: 'typescript',
                startLine: 2,
                startColumn: 0,
                endLine: 2,
                endColumn: 10,
                nameIsAmbiguous: true,
            },
        );

        expect(first).not.toBe(second);
        expect(first).toContain('function:');
    });

    it('detects generated functional callbacks', () => {
        expect(isGeneratedFPCallback('Result.map_callback')).toBe(true);
        expect(isGeneratedFPCallback('Result.tapError_callback')).toBe(true);
        expect(isGeneratedFPCallback('MyService.handle')).toBe(false);
    });

    it('derives simple class names from method names', () => {
        expect(deriveClassName('Acme\\Billing\\InvoiceService.handle')).toBe('InvoiceService');
        expect(deriveClassName('handle')).toBeNull();
    });

    it('derives class name from multi-dot chunk names (closure context)', () => {
        // TS class method → standard case
        expect(deriveClassName('SaveService.emitSaveCreatedEvent')).toBe('SaveService');
        // TS class callback (after closure-context-loss fix)
        expect(deriveClassName('SaveService.pipe_callback')).toBe('SaveService');
        // Hypothetical deeper nesting — still extracts the class
        expect(deriveClassName('SaveService.emitSaveCreatedEvent.pipe_callback')).toBe('SaveService');
        // PHP namespace with multi-dot
        expect(deriveClassName('App\\Service\\OrderService.handle.then_callback')).toBe('OrderService');
    });

    it('builds taint context summary with sinks, symbols, and aliases', () => {
        const taintInfo: FileTaintInfo = {
            taintedSymbols: new Set(['db', 'cache']),
            taintedAliases: new Map([['this.client', 'ApiClient']]),
        };
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [
                { source: 'axios', specifiers: ['axios'], isExternal: true },
                { source: './local', specifiers: ['Local'], isExternal: false },
            ],
        };

        const summary = buildTaintContextSummary(taintInfo, fileImportMap);
        expect(summary).toContain('Direct I/O imports: axios');
        expect(summary).toContain('Tainted symbols (trace back to I/O sinks): db, cache');
        expect(summary).toContain('DI aliases: this.client → ApiClient (tainted)');
        expect(buildTaintContextSummary()).toBeUndefined();
        expect(buildTaintContextSummary({ taintedSymbols: new Set(), taintedAliases: new Map() })).toBeUndefined();
    });

    it('formats file constants only when referenced and truncates oversized blocks', () => {
        const constants = [
            { scope: '', name: 'MODULE_TOPIC', value: '"mod.topic"' },
            { scope: 'MyService', name: 'EVENT_NAME', value: '"event.topic"' },
            { scope: 'OtherService', name: 'NOISE', value: '"ignore"' },
        ];

        const context = formatFileConstantsContext(
            constants,
            'MyService',
            'return MODULE_TOPIC + MyService.EVENT_NAME;',
        );

        expect(context).toContain('// Module-level');
        expect(context).toContain('MODULE_TOPIC = "mod.topic"');
        expect(context).toContain('// Class MyService');
        expect(context).toContain('MyService.EVENT_NAME = "event.topic"');
        expect(context).not.toContain('OtherService.NOISE');
        expect(formatFileConstantsContext([], 'MyService', 'return 1;')).toBeUndefined();
        const missingClassContext = formatFileConstantsContext(constants, 'MissingService', 'return MODULE_TOPIC;');
        expect(missingClassContext).toContain('MODULE_TOPIC = "mod.topic"');
        expect(missingClassContext).not.toContain('EVENT_NAME');
        expect(formatFileConstantsContext(constants, null)).toContain('OtherService.NOISE = "ignore"');
        expect(formatFileConstantsContext(constants, 'MyService', 'return nothing;')).toBeUndefined();

        const large = Array.from({ length: 40 }, (_, index) => ({
            scope: '',
            name: `VALUE_${index}`,
            value: `"${'x'.repeat(100)}"`,
        }));
        const largeSource = large.map(entry => entry.name).join(' + ');
        expect(formatFileConstantsContext(large, null, largeSource)).toContain('...(truncated)');
    });

    it('formats resolved constants context', () => {
        const constants: ResolvedConstant[] = [
            { key: 'TOPIC', value: '"events.topic"', source: 'local', sourceFile: 'src/service.ts' },
        ];

        expect(formatResolvedConstantsContext(constants)).toContain('TOPIC = "events.topic"');
        expect(formatResolvedConstantsContext([])).toBeUndefined();
    });

    it('extracts graphql documents and skips invalid or introspection docs', () => {
        const source = `
export const GetUsers = gql\`
  query GetUsers {
    list: users(limit: 1) { id }
  }
\`;

const DoThing = graphql\`
  mutation DoThing {
    createThing(input: {}) { id }
  }
\`;

const Invalid = gql\`
  fragment F on Query { field }
\`;

const Hidden = gql\`
  subscription Hidden {
    __typename
  }
\`;

const NoBody = gql\`
  query NoBody
\`;

const Scalar = gql\`
  query Scalar {
    users
  }
\`;
`;

        expect(extractGraphQLDocumentsFromSource(source, 'src/graphql.ts')).toEqual([
            {
                symbolName: 'GetUsers',
                operationType: 'QUERY',
                operationName: 'GetUsers',
                rootField: 'users',
                sourceFile: 'src/graphql.ts',
            },
            {
                symbolName: 'DoThing',
                operationType: 'MUTATION',
                operationName: 'DoThing',
                rootField: 'createThing',
                sourceFile: 'src/graphql.ts',
            },
        ]);
    });

    it('resolves local imports against known repo files', () => {
        const allFilePaths = new Set([
            'src/graphql.ts',
            'src/client/index.ts',
        ]);

        expect(resolveImportSourceForFile('../graphql', 'src/features/service.ts', allFilePaths)).toBe('src/graphql.ts');
        expect(resolveImportSourceForFile('../client', 'src/features/service.ts', allFilePaths)).toBe('src/client/index.ts');
        expect(resolveImportSourceForFile('./missing', 'src/features/service.ts', allFilePaths)).toBeNull();
        expect(resolveImportSourceForFile('axios', 'src/features/service.ts', allFilePaths)).toBeNull();
    });

    it('builds client binding context via the language plugin (TypeScript @Inject)', () => {
        // The plugin owns the token-injection convention; mock it to mimic the
        // real TS path: `@Inject(<token>)` regex over constructorSource.
        getLanguagePluginMock.mockReturnValue({
            recognizesInjectedToken: (token: string, ctor: string) =>
                new RegExp(`@Inject\\(\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`).test(ctor),
        });

        const task = makeTask({
            constructorSource: 'constructor(@Inject(CLIENT$TOKEN) private readonly client) {}',
        });
        const registry = new Map([
            ['CLIENT$TOKEN', { token: 'CLIENT$TOKEN', clientKind: 'sdk', protocol: 'graphql', baseUrlHint: 'https://api.test' }],
            ['OTHER', { token: 'OTHER', clientKind: 'http', protocol: 'http' }],
        ]);

        const context = buildClientBindingContext(task, registry as any);
        expect(context).toContain('CLIENT$TOKEN -> sdk graphql baseUrl=https://api.test');
        expect(buildClientBindingContext(makeTask({ constructorSource: 'constructor(@Inject(NONE) dep) {}' }), registry as any)).toBeUndefined();
        expect(buildClientBindingContext(makeTask(), registry as any)).toBeUndefined();
    });

    it('builds client binding context via the language plugin (PHP type-hinted property)', () => {
        // PHP convention: type-hinted constructor / promoted property.
        getLanguagePluginMock.mockReturnValue({
            recognizesInjectedToken: (token: string, _ctor: string, props: readonly string[]) => {
                const short = token.split('\\').pop()!;
                return props.some(line => new RegExp(`:\\s*\\\\?[A-Za-z0-9_\\\\]*?\\b${short}\\b\\s*$`).test(line));
            },
        });

        const task = makeTask({
            chunk: {
                name: 'InventoryAdapter.createOrder',
                filepath: 'src/Inventory/InventoryAdapter.php',
                sourceCode: '$this->client->post(...)',
                language: 'php',
                startLine: 1, startColumn: 0, endLine: 5, endColumn: 0,
            },
            classProperties: ['this->client: InventoryGqlClient', 'this->logger: LoggerInterface'],
        });
        const registry = new Map([
            ['Acme\\Inventory\\InventoryGqlClient', {
                token: 'Acme\\Inventory\\InventoryGqlClient',
                clientKind: 'sdk', protocol: 'graphql',
                baseUrlHint: 'https://inventory.acme.test',
            }],
        ]);

        const context = buildClientBindingContext(task, registry as any);
        expect(context).toContain('Acme\\Inventory\\InventoryGqlClient -> sdk graphql baseUrl=https://inventory.acme.test');
    });

    it('returns undefined when the language plugin lacks recognizesInjectedToken', () => {
        getLanguagePluginMock.mockReturnValue({}); // plugin without the optional method
        const task = makeTask({ constructorSource: 'constructor(@Inject(X) c) {}' });
        const registry = new Map([['X', { token: 'X', clientKind: 'sdk', protocol: 'graphql' }]]);
        expect(buildClientBindingContext(task, registry as any)).toBeUndefined();
    });

    it('builds graphql document context for locally imported referenced docs', () => {
        const task = makeTask({
            chunk: {
                name: 'MyService.handle',
                filepath: 'src/service.ts',
                sourceCode: 'return execute(GetUsers) + keep;',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [
                { source: './graphql', specifiers: ['GetUsers', '*', 'default'], isExternal: false },
                { source: 'graphql-request', specifiers: ['gql'], isExternal: true },
            ],
        };
        const docsByFile = new Map([
            ['src/graphql.ts', [{
                symbolName: 'GetUsers',
                operationType: 'QUERY',
                operationName: 'GetUsers',
                rootField: 'users',
                sourceFile: 'src/graphql.ts',
            }]],
        ]);

        expect(buildGraphQLDocumentContext(task, fileImportMap, new Set(['src/graphql.ts']), docsByFile)).toContain(
            'GetUsers -> GRAPHQL QUERY users (document=GetUsers)',
        );
        expect(buildGraphQLDocumentContext(task, undefined, new Set(), docsByFile)).toBeUndefined();
    });

    it('collects local and imported constants once per task', () => {
        const task = makeTask({
            chunk: {
                name: 'MyService.handle',
                filepath: 'src/service.ts',
                sourceCode: 'return EVENT_NAME + ImportedTopic + ImportedTopic;',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [
                { source: './constants', specifiers: ['ImportedTopic', '*', 'default'], isExternal: false },
            ],
        };
        const constantsByFile = new Map([
            ['src/service.ts', [{ scope: 'MyService', name: 'EVENT_NAME', value: '"local.topic"' }]],
            ['src/constants.ts', [{ scope: '', name: 'ImportedTopic', value: '"imported.topic"' }]],
        ]);

        expect(
            collectResolvedConstantsForTask(task, fileImportMap, new Set(['src/constants.ts']), constantsByFile),
        ).toEqual([
            { key: 'MyService.EVENT_NAME', value: '"local.topic"', source: 'local', sourceFile: 'src/service.ts' },
            { key: 'ImportedTopic', value: '"imported.topic"', source: 'imported', sourceFile: 'src/constants.ts' },
        ]);
        expect(
            collectResolvedConstantsForTask(task, undefined, new Set(['src/constants.ts']), constantsByFile),
        ).toEqual([
            { key: 'MyService.EVENT_NAME', value: '"local.topic"', source: 'local', sourceFile: 'src/service.ts' },
        ]);
    });

    it('collects same-file object property constants only when referenced', () => {
        const task = makeTask({
            chunk: {
                name: 'MyService.publish',
                filepath: 'src/service.ts',
                sourceCode: 'this.outbox.publish(config.topic, payload);',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
        });
        const constantsByFile = new Map([
            ['src/service.ts', [
                { scope: 'config', name: 'topic', value: '"Order-Save"' },
                { scope: 'config', name: 'unused', value: '"ignore"' },
            ]],
        ]);

        expect(
            collectResolvedConstantsForTask(task, undefined, new Set(), constantsByFile),
        ).toEqual([
            { key: 'config.topic', value: '"Order-Save"', source: 'local', sourceFile: 'src/service.ts' },
        ]);
    });

    it('collects imported object property constants, aliases, and this-access', () => {
        const task = makeTask({
            chunk: {
                name: 'ChannelsService.publish',
                filepath: 'src/service.ts',
                sourceCode: `
this.outbox.publish(cfg.appChannelSave, payload);
this.outbox.publish(this.cfg.appChannelShipmentBundleV2, payload);
`,
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 5,
                endColumn: 0,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [{
                source: './Channels.config',
                specifiers: ['cfg'],
                isExternal: false,
                specifierBindings: [{ imported: 'appConfig', local: 'cfg', kind: 'named' }],
            }],
        };
        const constantsByFile = new Map([
            ['src/Channels.config.ts', [
                { scope: 'appConfig', name: 'appChannelSave', value: '"Order-Save"' },
                { scope: 'appConfig', name: 'appChannelShipmentBundleV2', value: '"Order-ShipmentBundleV2"' },
                { scope: 'appConfig', name: 'unused', value: '"ignore"' },
            ]],
        ]);

        expect(
            collectResolvedConstantsForTask(
                task,
                fileImportMap,
                new Set(['src/Channels.config.ts']),
                constantsByFile,
            ),
        ).toEqual([
            { key: 'cfg.appChannelSave', value: '"Order-Save"', source: 'imported', sourceFile: 'src/Channels.config.ts' },
            { key: 'this.cfg.appChannelShipmentBundleV2', value: '"Order-ShipmentBundleV2"', source: 'imported', sourceFile: 'src/Channels.config.ts' },
        ]);
    });

    it('does not inject imported object properties when property is not referenced', () => {
        const task = makeTask({
            chunk: {
                name: 'ChannelsService.publish',
                filepath: 'src/service.ts',
                sourceCode: 'this.outbox.publish(payload);',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [{
                source: './Channels.config',
                specifiers: ['appConfig'],
                isExternal: false,
                specifierBindings: [{ imported: 'appConfig', local: 'appConfig', kind: 'named' }],
            }],
        };
        const constantsByFile = new Map([
            ['src/Channels.config.ts', [
                { scope: 'appConfig', name: 'appChannelSave', value: '"Order-Save"' },
            ]],
        ]);

        expect(
            collectResolvedConstantsForTask(
                task,
                fileImportMap,
                new Set(['src/Channels.config.ts']),
                constantsByFile,
            ),
        ).toEqual([]);
    });

    it('collects imported PHP class constant via ClassName::CONST syntax', () => {
        const task = makeTask({
            chunk: {
                name: 'AcmePartnerService.quotation',
                filepath: 'src/AcmePartner/AcmePartnerService.php',
                sourceCode: `$this->client->call(AcmePartnerClient::QUOTATION_SERVICE, $msg);`,
                language: 'php',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
            fileContext: {
                absolutePath: '/tmp/repo/src/AcmePartner/AcmePartnerService.php',
                relativePath: 'src/AcmePartner/AcmePartnerService.php',
                repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
                routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
                fileHash: 'file-hash',
                ownerService: null,
                isManifest: false,
            },
        });
        // PHP imports resolve via PSR-4 to the full repo-relative file path with extension.
        const fileImportMap: FileImportMap = {
            filePath: 'src/AcmePartner/AcmePartnerService.php',
            exportedSymbols: [],
            imports: [{
                source: 'src/AcmePartner/AcmePartnerClient.php',
                specifiers: ['AcmePartnerClient'],
                isExternal: false,
                specifierBindings: [{ imported: 'AcmePartnerClient', local: 'AcmePartnerClient', kind: 'named' }],
            }],
        };
        const constantsByFile = new Map([
            ['src/AcmePartner/AcmePartnerClient.php', [
                { scope: 'AcmePartnerClient', name: 'QUOTATION_SERVICE', value: "'quotes-batch'" },
                { scope: 'AcmePartnerClient', name: 'PROPOSAL_SERVICE', value: "'saved-quote'" },
            ]],
        ]);

        const result = collectResolvedConstantsForTask(
            task,
            fileImportMap,
            new Set(['src/AcmePartner/AcmePartnerClient.php']),
            constantsByFile,
        );

        expect(result).toContainEqual({
            key: 'AcmePartnerClient::QUOTATION_SERVICE',
            value: "'quotes-batch'",
            source: 'imported',
            sourceFile: 'src/AcmePartner/AcmePartnerClient.php',
        });
        expect(result.find(r => r.key.includes('PROPOSAL_SERVICE'))).toBeUndefined();
    });

    it('collects same-class PHP constant via self::CONST when current class matches scope', () => {
        const task = makeTask({
            chunk: {
                name: 'AcmePartnerClient.callQuotationMethod',
                filepath: 'src/AcmePartner/AcmePartnerClient.php',
                sourceCode: `$path = $this->uri . '/' . self::QUOTATION_SERVICE;`,
                language: 'php',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
            fileContext: {
                absolutePath: '/tmp/repo/src/AcmePartner/AcmePartnerClient.php',
                relativePath: 'src/AcmePartner/AcmePartnerClient.php',
                repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
                routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
                fileHash: 'file-hash',
                ownerService: null,
                isManifest: false,
            },
        });
        const constantsByFile = new Map([
            ['src/AcmePartner/AcmePartnerClient.php', [
                { scope: 'AcmePartnerClient', name: 'QUOTATION_SERVICE', value: "'quotes-batch'" },
            ]],
        ]);

        const result = collectResolvedConstantsForTask(
            task,
            undefined,
            new Set(['src/AcmePartner/AcmePartnerClient.php']),
            constantsByFile,
        );

        expect(result).toContainEqual(expect.objectContaining({
            value: "'quotes-batch'",
            source: 'local',
        }));
    });

    it('collects same-class PHP constant via static::CONST (late static binding)', () => {
        const task = makeTask({
            chunk: {
                name: 'BaseService.fetch',
                filepath: 'src/BaseService.php',
                sourceCode: `return $this->call(static::ENDPOINT_PATH);`,
                language: 'php',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
            fileContext: {
                absolutePath: '/tmp/repo/src/BaseService.php',
                relativePath: 'src/BaseService.php',
                repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
                routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
                fileHash: 'file-hash',
                ownerService: null,
                isManifest: false,
            },
        });
        const constantsByFile = new Map([
            ['src/BaseService.php', [
                { scope: 'BaseService', name: 'ENDPOINT_PATH', value: "'/api/v1'" },
            ]],
        ]);

        const result = collectResolvedConstantsForTask(
            task,
            undefined,
            new Set(['src/BaseService.php']),
            constantsByFile,
        );

        expect(result).toContainEqual(expect.objectContaining({
            value: "'/api/v1'",
            source: 'local',
        }));
    });

    it('does NOT inject self::CONST from a different class than the analyzed function', () => {
        // chunk currentClass = OtherClient, but the constant scope is AcmePartnerClient.
        // Source contains self::QUOTATION_SERVICE which refers to OtherClient (not AcmePartnerClient).
        // The AcmePartnerClient constant must NOT leak via self:: matching.
        const task = makeTask({
            chunk: {
                name: 'OtherClient.run',
                filepath: 'src/Other/OtherClient.php',
                sourceCode: `return self::QUOTATION_SERVICE;`,
                language: 'php',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
            fileContext: {
                absolutePath: '/tmp/repo/src/Other/OtherClient.php',
                relativePath: 'src/Other/OtherClient.php',
                repo: { name: 'repo', path: '/tmp/repo', origin: 'local' },
                routing: { type: 'repository', name: 'repo', urn: 'urn:repository:repo' },
                fileHash: 'file-hash',
                ownerService: null,
                isManifest: false,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/Other/OtherClient.php',
            exportedSymbols: [],
            imports: [{
                source: 'src/AcmePartner/AcmePartnerClient.php',
                specifiers: ['AcmePartnerClient'],
                isExternal: false,
                specifierBindings: [{ imported: 'AcmePartnerClient', local: 'AcmePartnerClient', kind: 'named' }],
            }],
        };
        const constantsByFile = new Map([
            ['src/AcmePartner/AcmePartnerClient.php', [
                { scope: 'AcmePartnerClient', name: 'QUOTATION_SERVICE', value: "'quotes-batch'" },
            ]],
        ]);

        const result = collectResolvedConstantsForTask(
            task,
            fileImportMap,
            new Set(['src/AcmePartner/AcmePartnerClient.php']),
            constantsByFile,
        );

        expect(result.find(r => r.value === "'quotes-batch'")).toBeUndefined();
    });

    it('collects imported object property constants through this.importName.property', () => {
        const task = makeTask({
            chunk: {
                name: 'ChannelsService.publish',
                filepath: 'src/service.ts',
                sourceCode: 'this.outbox.publish(this.appConfig.appChannelSave, payload);',
                language: 'typescript',
                startLine: 1,
                startColumn: 0,
                endLine: 2,
                endColumn: 0,
            },
        });
        const fileImportMap: FileImportMap = {
            filePath: 'src/service.ts',
            exportedSymbols: [],
            imports: [{
                source: './Channels.config',
                specifiers: ['appConfig'],
                isExternal: false,
                specifierBindings: [{ imported: 'appConfig', local: 'appConfig', kind: 'named' }],
            }],
        };
        const constantsByFile = new Map([
            ['src/Channels.config.ts', [
                { scope: 'appConfig', name: 'appChannelSave', value: '"Order-Save"' },
            ]],
        ]);

        expect(
            collectResolvedConstantsForTask(
                task,
                fileImportMap,
                new Set(['src/Channels.config.ts']),
                constantsByFile,
            ),
        ).toEqual([
            { key: 'this.appConfig.appChannelSave', value: '"Order-Save"', source: 'imported', sourceFile: 'src/Channels.config.ts' },
        ]);
    });

    it('formats deep type definitions with caps and truncation', () => {
        const propertyList = Array.from({ length: 22 }, (_, index) => ({ name: `field${index}`, type: 'string' }));
        const typeDefIndex = new Map([
            ['InputA', { kind: 'interface', name: 'InputA', properties: propertyList }],
            ['InputB', { kind: 'type', name: 'InputB', properties: [{ name: 'foo', type: 'number' }] }],
            ['InputC', { kind: 'interface', name: 'InputC', properties: [{ name: 'bar', type: 'boolean' }] }],
            ['InputD', { kind: 'interface', name: 'InputD', properties: [{ name: 'skip', type: 'string' }] }],
        ]);
        const refs = new Map([
            ['src/service.ts', new Map([['MyService.handle', ['InputA', 'InputB', 'Missing', 'InputC', 'InputD']]])],
        ]);

        const context = formatTypeDefinitions('MyService.handle', typeDefIndex as any, refs, 'src/service.ts');
        expect(context).toContain('interface InputA');
        expect(context).toContain('// ... 2 more properties');
        expect(context).toContain('type InputB');
        expect(context).toContain('interface InputC');
        expect(context).not.toContain('InputD');
        expect(formatTypeDefinitions('Other.handle', typeDefIndex as any, refs, 'src/service.ts')).toBeUndefined();
        expect(formatTypeDefinitions('MyService.handle', typeDefIndex as any, refs, 'src/missing.ts')).toBeUndefined();
    });
});
