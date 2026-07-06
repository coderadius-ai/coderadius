import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import type { ClassPropertyAlias, DependencyBinding, ImportRef } from '../import-graph.js';
import type { CodeChunk } from '../../../graph/types.js';
import type {
    DataStructureDefinition,
    DependencyMapping,
    FrameworkSignal,
    ImportContext,
    LanguagePlugin,
    ManifestDependency,
    PackageDependency,
    StaticInfraResult,
} from './types.js';
import { TYPESCRIPT_PROMPT_HINTS } from './typescript/prompt-hints.js';
import { extractTypeScriptFunctions } from './typescript/chunk-extraction.js';
import { extractTypeScriptStaticInfra } from './typescript/static-infra.js';
import { extractTypeScriptEnvVars } from './typescript/env-vars.js';
import {
    extractTypeScriptClassPropertyAliases,
    extractTypeScriptDependencyBindings,
    extractTypeScriptExports,
    extractTypeScriptImports,
} from './typescript/imports.js';
import {
    extractSimpleTypeName,
    extractTypeScriptReferencedTypes,
    extractTypeScriptTypeDefinitions,
    extractTsFunctionPayloadHints,
    extractTsBaseTypesFromString,
    extractTypeText,
} from './typescript/type-extraction.js';
import type { FunctionPayloadHints } from './types.js';
import {
    extractTypeScriptConstructorSources,
    extractTypeScriptFileConstants,
    extractTypeScriptImportStatements,
} from './typescript/analyzer-helpers.js';
import { extractTypeScriptDependencies, parseNpmManifestDependencies } from './typescript/dependencies.js';
import { validateTypeScriptInboundPath } from './typescript/validate-inbound-path.js';
import {
    buildTypeScriptMetadataChunks,
    extractTypeScriptFrameworkSignals,
} from './typescript-framework-signals.js';
import { extractTypeScriptStaticSupplements } from './typescript-supplements.js';
import { typescriptRecognizesInjectedToken } from './typescript/injection.js';
import { findNodeSpanning, walkForServiceCalls } from '../ast-service-call-detector.js';
import {
    extractTypeScriptCriticalInvocations,
    extractTypeScriptValueFacts,
} from '../value-resolution/extractors.js';

const TS_CALL_TYPES = new Set(['call_expression']);

/** Ordered (first match wins) npm-ecosystem broker SDK markers → technology. */
const TS_BROKER_TECH_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
    [/@google-cloud\/pubsub|PubSubClient/i, 'pubsub'],
    [/amqplib|AMQPChannel|AMQPMessage/i, 'rabbitmq'],
    [/kafkajs|@nestjs\/microservices.*kafka|rdkafka|confluent/i, 'kafka'],
    [/@aws-sdk\/client-sqs|SQSClient/i, 'sqs'],
    [/@aws-sdk\/client-sns|SNSClient/i, 'sns'],
    [/azure.*service-bus|ServiceBusClient/i, 'azure-service-bus'],
    [/bullmq|bull|@nestjs\/bull/i, 'redis'],
    [/nats|@nats-io/i, 'nats'],
];

export class TypeScriptPlugin implements LanguagePlugin {
    readonly language = 'typescript';
    readonly ecosystem = 'npm';
    readonly extensions = ['.ts', '.tsx', '.js', '.jsx'] as const;

    /**
     * Reduce an npm specifier to its package name.
     * Examples:
     *   'axios'                       → 'axios'
     *   'axios/dist/lib/foo'          → 'axios'
     *   '@aws-sdk/client-s3'          → '@aws-sdk/client-s3'
     *   '@scope/pkg/sub/path.js'      → '@scope/pkg'
     *   './local'                     → './local' (caller uses isExternal flag to filter)
     */
    normalizePackageName(rawImport: string): string {
        if (!rawImport || rawImport.startsWith('.') || rawImport.startsWith('/')) {
            return rawImport;
        }
        if (rawImport.startsWith('@')) {
            const parts = rawImport.split('/');
            if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
            return rawImport;
        }
        const slash = rawImport.indexOf('/');
        return slash === -1 ? rawImport : rawImport.slice(0, slash);
    }
    readonly scopeExclusions = [
        // ── Test / spec / story files ───────────────────────────────────────
        '*.test.ts', '*.test.tsx', '*.test.js', '*.test.jsx', '*.test.mjs', '*.test.cjs',
        '*.spec.ts', '*.spec.tsx', '*.spec.js', '*.spec.jsx', '*.spec.mjs', '*.spec.cjs',
        '*.stories.ts', '*.stories.tsx',
        '**/__tests__/**', '**/__mocks__/**',
        // ── Type declarations and generated outputs ─────────────────────────
        '*.d.ts',
        '*.generated.ts', '*.generated.js',
        '*.g.ts', '*.g.js',
        // ── Build output (covers Webpack/Rollup/Vite/tsc/Next/Nuxt/etc.) ───
        '**/dist/**', '**/build/**', '**/out/**', '**/lib-cov/**',
        // ── Framework / bundler caches ──────────────────────────────────────
        '**/.next/**', '**/.nuxt/**', '**/.vite/**', '**/.turbo/**',
        '**/.angular/**', '**/.svelte-kit/**', '**/.parcel-cache/**',
        '**/.astro/**', '**/.docusaurus/**', '**/.cache/**',
        // ── Storybook / coverage / typegen ──────────────────────────────────
        '**/storybook-static/**', '**/coverage/**', '**/.nyc_output/**',
        // ── Vendored module trees ───────────────────────────────────────────
        '**/node_modules/**', '**/bower_components/**', '**/jspm_packages/**',
        // ── Minified / source map artefacts (catch generic *.min.*) ─────────
        '*.min.js', '*.min.mjs', '*.min.cjs', '*.min.jsx', '*.min.tsx', '*.min.css',
        '*.js.map', '*.mjs.map', '*.cjs.map', '*.jsx.map', '*.tsx.map', '*.css.map',
        // ── Database migration files (Prisma / TypeORM / Knex / Sequelize) ─
        // Schema-only, no business signal: the LLM extraction returns nothing
        // a sanitizer would accept. Per-framework patterns instead of a
        // universal `**/migrations/**` to avoid hitting real service names.
        '**/prisma/migrations/**',
        '**/migrations/[0-9]*_*.ts', '**/migrations/[0-9]*_*.tsx',
        '**/migrations/[0-9]*_*.js', '**/migrations/[0-9]*_*.mjs', '**/migrations/[0-9]*_*.cjs',
        '**/migrations/[0-9]*-*.ts', '**/migrations/[0-9]*-*.js',
        '**/db/migrations/*.ts', '**/db/migrations/*.js',
        '**/typeorm-migrations/**',
    ] as const;
    readonly manifestFiles = [
        { file: 'package.json', language: 'javascript' },
    ] as const;
    readonly ignorePatterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/bower_components/**',
        '**/e2e/**',
        '**/cypress/**',
    ] as const;

    readonly sinkPackages = [
        // HTTP client wrappers that aren't yet in the polyglot KNOWN_IO_SINKS.
        // Zodios is a typed Axios wrapper widely used in TS API repositories
        // (e.g. pricing-service eval pattern). Extending here keeps the core
        // import-graph language-agnostic per CLAUDE.md §1, §2.
        '@zodios/core',
        '@zodios/react',
    ] as const;

    readonly runtimeServiceSignals = {
        manifestFields: [
            { manifest: 'package.json', jsonPath: 'scripts.start', condition: 'exists' as const },
            { manifest: 'package.json', jsonPath: 'bin', condition: 'exists' as const },
            // Many NestJS / monorepo apps don't expose a bare `start`; instead they
            // ship `start:prod`, `start:dev`, `start:debug`. Detect any `start*`
            // script key via the stringified `scripts` block.
            {
                manifest: 'package.json',
                jsonPath: 'scripts',
                condition: 'matches' as const,
                valuePattern: /"start[a-z:]*"\s*:\s*"[^"]+"/i,
            },
        ],
        entrypoints: [
            {
                files: [
                    // NOTE: enumerated case variants explicitly — the orchestrator's
                    // fileExists() uses fs.statSync which is case-sensitive on Linux/CI.
                    'src/Main.bootstrap.ts', 'src/main.bootstrap.ts',
                    'src/Main.ts', 'src/main.ts',
                    'src/Index.ts', 'src/index.ts',
                    'Main.bootstrap.ts', 'main.bootstrap.ts',
                    'Main.ts', 'main.ts',
                    'Index.ts', 'index.ts',
                ],
                patterns: [
                    /NestFactory\.create\b/,
                    /\bapp\.listen\(/,
                    /\bhttp\.createServer\(/,
                    /new\s+ApolloServer\b/,
                    /\bcreateYoga\(/,
                    /\bmercurius\(/,
                    /\bexpress\(\)/,
                    /\bfastify\(/,
                    // CLI runtime frameworks (nest-commander, oclif, commander
                    // when wired as the process entrypoint).
                    /\bCommandFactory\.(?:run|create|createWithoutRunning)\b/,
                    /from\s+['"]@oclif\/core['"]/,
                    /\bcommander\(\)\.parse\(/,
                ],
            },
        ],
        manifestPresence: [
            {
                manifest: 'package.json',
                requireSection: 'dependencies',
                minSourceFiles: 10,
                sourceExtensions: ['.ts', '.tsx'],
            },
        ],
    } as const;

    readonly frameworkRoleSignals = {
        'graphql-server': {
            entrypoints: [
                {
                    files: [
                        'src/Main.bootstrap.ts', 'src/main.bootstrap.ts',
                        'src/main.ts', 'src/index.ts',
                        'Main.bootstrap.ts', 'main.ts', 'index.ts',
                        'src/App.module.ts', 'src/app.module.ts',
                        'App.module.ts', 'app.module.ts',
                    ],
                    patterns: [
                        /GraphQLModule\.forRoot(?:Async)?(?:<[^>]+>)?\s*\(/,
                        /new\s+ApolloServer\b/,
                        /\bcreateYoga\(/,
                        /\bmercurius\(/,
                    ],
                },
            ],
            // Server-only packages. NEVER list @nestjs/graphql here: it is the
            // decorator surface (`@Resolver`, `@Query`, `@Mutation`) and is
            // routinely imported by workers/CLIs for typings without hosting
            // a server. The entrypoint detection above is the right gate for
            // NestJS GraphQL.
            dependencyMarkers: [
                {
                    manifest: 'package.json',
                    packages: [
                        '@apollo/server', 'apollo-server', 'apollo-server-express',
                        'mercurius', 'graphql-yoga',
                    ],
                    sections: ['dependencies', 'devDependencies', 'peerDependencies'],
                },
            ],
        },
    } as const;

    private parser: Parser | null = null;

    promptHints(): string {
        return TYPESCRIPT_PROMPT_HINTS;
    }

    createParser(): Parser {
        if (!this.parser) {
            this.parser = new Parser();
            this.parser.setLanguage(patchLanguage(ts.typescript));
        }
        return this.parser;
    }

    extractFunctions(tree: Parser.Tree, source: string, filepath: string): CodeChunk[] {
        return extractTypeScriptFunctions(tree, source, filepath);
    }

    extractFrameworkSignals(rootNode: Parser.SyntaxNode, source: string, filepath: string): FrameworkSignal[] {
        return extractTypeScriptFrameworkSignals(rootNode, source, filepath);
    }

    extractStaticSupplements(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
        chunk: CodeChunk,
    ) {
        return extractTypeScriptStaticSupplements(rootNode, source, filepath, chunk);
    }

    recognizesInjectedToken(
        token: string,
        constructorSource: string,
        classProperties: readonly string[],
    ): boolean {
        return typescriptRecognizesInjectedToken(token, constructorSource, classProperties);
    }

    extractValueFacts(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractTypeScriptValueFacts(rootNode, source, filepath);
    }

    extractCriticalInvocations(rootNode: Parser.SyntaxNode, source: string, filepath: string, chunk?: CodeChunk) {
        return extractTypeScriptCriticalInvocations(rootNode, source, filepath, chunk);
    }

    extractStaticInfra(_rootNode: Parser.SyntaxNode, chunk: CodeChunk): StaticInfraResult | null {
        return extractTypeScriptStaticInfra(chunk);
    }

    extractEnvVars(node: Parser.SyntaxNode): string[] {
        return extractTypeScriptEnvVars(node);
    }

    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
        return extractTypeScriptImports(rootNode, context);
    }

    extractExports(rootNode: Parser.SyntaxNode): string[] {
        return extractTypeScriptExports(rootNode);
    }

    extractClassPropertyAliases(rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
        return extractTypeScriptClassPropertyAliases(rootNode);
    }

    extractDependencyBindings(rootNode: Parser.SyntaxNode, filePath: string): DependencyBinding[] {
        return extractTypeScriptDependencyBindings(rootNode, filePath);
    }

    extractTypeDefinitions(rootNode: Parser.SyntaxNode): Map<string, DataStructureDefinition> {
        return extractTypeScriptTypeDefinitions(rootNode);
    }

    extractReferencedTypes(rootNode: Parser.SyntaxNode): Map<string, string[]> {
        return extractTypeScriptReferencedTypes(rootNode);
    }

    extractFunctionPayloadHints(rootNode: Parser.SyntaxNode): Map<string, FunctionPayloadHints> {
        return extractTsFunctionPayloadHints(rootNode);
    }

    extractBaseTypesFromString(typeString: string): string[] {
        return extractTsBaseTypesFromString(typeString);
    }

    extractImportStatements(rootNode: Parser.SyntaxNode): string[] {
        return extractTypeScriptImportStatements(rootNode);
    }

    extractConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string> {
        return extractTypeScriptConstructorSources(rootNode);
    }

    extractFileConstants(rootNode: Parser.SyntaxNode): Array<{ scope: string; name: string; value: string }> {
        return extractTypeScriptFileConstants(rootNode);
    }

    async extractDependencies(repoPath: string): Promise<PackageDependency[]> {
        return extractTypeScriptDependencies(repoPath);
    }

    parseManifestDependencies(fileName: string, fileContent: string): ManifestDependency[] | null {
        if (fileName !== 'package.json') return null;
        return parseNpmManifestDependencies(fileContent);
    }

    validateInboundPath(path: string, sourceCode: string): boolean | undefined {
        return validateTypeScriptInboundPath(path, sourceCode);
    }

    /**
     * npm-ecosystem broker SDK markers → technology (first match wins).
     * Consumed by the sanitizer's technology inference; the SDK grammar
     * lives here, never in the global sanitizer.
     */
    inferBrokerTechnology(sourceCode: string): string | undefined {
        for (const [pattern, tech] of TS_BROKER_TECH_SIGNALS) {
            if (pattern.test(sourceCode)) return tech;
        }
        return undefined;
    }

    /** Node Mongo-style collection access (`db.getCollection(`). */
    recognizesDocumentCollectionAccess(sourceCode: string): boolean {
        return /\.getCollection\s*\(/.test(sourceCode);
    }

    hasServiceCallsInRange(rootNode: Parser.SyntaxNode, startLine: number, endLine: number): boolean | undefined {
        const funcNode = findNodeSpanning(rootNode, startLine, endLine);
        if (!funcNode) return undefined;

        return walkForServiceCalls(funcNode, TS_CALL_TYPES, (callNode) => {
            const callee = callNode.childForFieldName('function');
            return callee?.type === 'member_expression';
        });
    }

    hasInjectedDependencyCallsInRange(rootNode: Parser.SyntaxNode, startLine: number, endLine: number): boolean | undefined {
        const funcNode = findNodeSpanning(rootNode, startLine, endLine);
        if (!funcNode) return undefined;

        return walkForServiceCalls(funcNode, TS_CALL_TYPES, (callNode) => {
            const callee = callNode.childForFieldName('function');
            if (callee?.type !== 'member_expression') return false;
            let obj: Parser.SyntaxNode | null = callee.childForFieldName('object');
            while (obj?.type === 'member_expression') {
                obj = obj.childForFieldName('object');
            }
            return obj?.type === 'this';
        });
    }

}

export {
    buildTypeScriptMetadataChunks,
    extractSimpleTypeName,
    extractTypeText,
};
