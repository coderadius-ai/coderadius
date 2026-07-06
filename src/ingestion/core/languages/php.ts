import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import type { CodeChunk } from '../../../graph/types.js';
import type { ClassPropertyAlias, ImportRef } from '../import-graph.js';
import type {
    DataStructureDefinition,
    DependencyMapping,
    ImportContext,
    LanguagePlugin,
    ManifestDependency,
    PackageDependency,
    StaticInfraResult,
} from './types.js';
import { extractPhpFunctions } from './php/chunk-extraction.js';
import { extractPhpDependencies, loadPhpDependencyMappings, loadPhpLocalPathDependencies, parseComposerManifestDependencies } from './php/dependencies.js';
import { extractPhpFileConstants } from './php/file-constants.js';
import {
    extractPhpClassPropertyAliases,
    extractPhpConstructorSources,
    extractPhpExports,
    extractPhpImplementsFiles,
    extractPhpImportStatements,
    extractPhpImports,
} from './php/imports.js';
import { extractPhpStaticInfraFromRoot } from './php/orm-static.js';
import { PHP_PROMPT_HINTS } from './php/prompt-hints.js';
import { extractPhpEnvVars } from './php/shared/ast-utils.js';
import { extractPhpReferencedTypes, extractPhpTypeDefinitions, extractPhpFunctionPayloadHints, extractPhpBaseTypesFromString } from './php/type-extraction.js';
import type { FunctionPayloadHints } from './types.js';
import { validatePhpInboundPath } from './php/validate-inbound-path.js';
import { phpRecognizesServiceLocatorKey } from './php/service-locator-key.js';
import { phpRecognizesFrameworkDiHandle } from './php/framework-di-handles.js';
import { phpRecognizesPlatformIoBuiltin } from './php/platform-io.js';
import { phpRecognizesOrmMetadataChunk } from './php/orm-metadata.js';
import {
    phpInferBrokerTechnology,
    phpRecognizesDocumentCollectionAccess,
    phpRecognizesDocumentCollectionContainer,
    phpRecognizesInProcessEvent,
    phpRecognizesPublishPayloadConstruction,
} from './php/sanitizer-evidence.js';
import {
    extractSymfonyMessengerSymbols,
    phpGlobalValueKeysForMessageClass,
    phpRecognizesGlobalValueKey,
} from './php/symfony-messenger-symbols.js';
import type { DeterministicConfigSymbol, FrameworkDiHandleKind } from './types.js';
import { findNodeSpanning, walkForServiceCalls } from '../ast-service-call-detector.js';
import {
    extractPhpCriticalInvocations,
    extractPhpValueFacts,
} from './php/value-resolution.js';
import { extractPhpStaticSupplements } from './php/static-supplements.js';
import { phpRecognizesInjectedToken } from './php/injection.js';
import {
    extractPhpComponentDefinitions,
    extractPhpDependencyRequirements,
} from './php/component-extraction.js';
import type { ComponentDefinition, DependencyRequirement } from './types.js';

const PHP_CALL_TYPES = new Set([
    'member_call_expression',     // $this->repo->find()
    'scoped_call_expression',     // static::query(), self::create()
    'function_call_expression',   // curl_exec(), fopen()
]);

export class PHPPlugin implements LanguagePlugin {
    readonly language = 'php';
    readonly ecosystem = 'composer';
    readonly extensions = ['.php'] as const;

    // Plan v10 §C: PHP dispatches `$obj->Method()` and `$obj->method()` to the
    // same method. The DI propagator normalizes operation names to lowercase
    // on extraction; this flag tells the core plumbing to do the same on
    // the lookup side.
    readonly isCaseInsensitiveOnOperations = true;

    extractComponentDefinitions(
        rootNode: Parser.SyntaxNode,
        _source: string,
        filepath: string,
    ): ComponentDefinition[] {
        return extractPhpComponentDefinitions(rootNode, filepath);
    }

    extractDependencyRequirements(
        rootNode: Parser.SyntaxNode,
        _source: string,
        filepath: string,
    ): DependencyRequirement[] {
        return extractPhpDependencyRequirements(rootNode, filepath);
    }

    /**
     * Normalize a PHP import to its composer package name.
     *
     * `extractImports` already emits composer-style names (e.g.
     * 'doctrine/orm') for external imports when the namespace is not local.
     * Vendor namespaces with backslashes are reduced to their first segment.
     *
     * Examples:
     *   'doctrine/orm'                 → 'doctrine/orm'
     *   'symfony/messenger'            → 'symfony/messenger'
     *   'GuzzleHttp\\Client'           → 'guzzlehttp/guzzle' (best-effort lowercase root)
     *   'Doctrine\\ORM\\EntityManager' → 'doctrine/orm'
     */
    normalizePackageName(rawImport: string): string {
        if (!rawImport) return rawImport;
        // Already in vendor/package shape
        if (rawImport.includes('/') && !rawImport.includes('\\')) return rawImport.toLowerCase();
        // Backslash namespace — drop trailing class names
        if (rawImport.includes('\\')) {
            const segments = rawImport.split('\\').filter(Boolean);
            if (segments.length >= 2) {
                return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
            }
            return segments[0]?.toLowerCase() ?? rawImport;
        }
        return rawImport.toLowerCase();
    }
    readonly scopeExclusions = [
        // ── Interfaces / proxies / lock ─────────────────────────────────────
        '*Proxy.php',
        '*Interface.php',
        'composer.lock',
        // ── PHPUnit / behat conventions (file-level) ────────────────────────
        '*Test.php', '*TestCase.php', '*Spec.php', '*Cest.php',
        // ── Vendored dependencies ───────────────────────────────────────────
        '**/vendor/**',
        // ── Symfony bundle public assets and translations ───────────────────
        '**/Resources/public/**',
        '**/Resources/translations/**',
        '**/Resources/views/**',
        // ── Symfony 2.x/3.x compiled bundle assets ──────────────────────────
        '**/web/bundles/**',
        '**/public/bundles/**',
        // ── Webpack Encore output ───────────────────────────────────────────
        '**/public/build/**',
        '**/public_html/build/**',
        // ── Symfony cache / log / sessions ──────────────────────────────────
        '**/var/cache/**',
        '**/var/log/**',
        '**/var/sessions/**',
        // ── Laravel runtime artefacts ───────────────────────────────────────
        '**/storage/framework/**',
        '**/storage/logs/**',
        '**/bootstrap/cache/**',
        // ── PHPUnit / coverage / phpstan caches ─────────────────────────────
        '**/.phpunit.cache/**',
        '**/.phpunit.result.cache',
        '**/.php-cs-fixer.cache',
        '**/.phpstan.cache/**',
        '**/coverage-html/**',
        '**/coverage/**',
        // ── Database migration files (Doctrine + Laravel) ──────────────────
        // Schema-only, no business signal; the LLM extraction is uniformly
        // rejected by the Sanitizer as "no valid evidence in source code".
        // Per-framework patterns avoid over-matching service folders that
        // carry `migration` in their name.
        '**/Migrations/Version*.php',
        '**/migrations/Version*.php',
        '**/database/migrations/*.php',
        '**/database/migrations/[0-9]*_*.php',
        '**/db/migrations/*.php',
    ] as const;
    readonly manifestFiles = [
        { file: 'composer.json', language: 'php' },
    ] as const;
    readonly ignorePatterns = [
        '**/vendor/**',
    ] as const;

    /**
     * Composer-ecosystem I/O sink packages + PHP namespace roots. Folded into
     * the taint registry by `getAllPluginSinkPackages()` — the polyglot
     * KNOWN_IO_SINKS in core stays PHP-free per CLAUDE.md §1, §2.
     */
    readonly sinkPackages = [
        // ── HTTP clients ──
        'guzzlehttp/guzzle', 'Guzzle', 'symfony/http-client',
        // PSR-18 HTTP Client + PSR-7 Messages + PSR-17 Factories (the de-facto
        // PHP HTTP standard, used by every modern PHP HTTP wrapper). Anything
        // importing `Psr\Http\Client\*` or `Psr\Http\Message\*` is an HTTP
        // I/O sink by interface contract.
        'psr/http-client', 'psr/http-message', 'psr/http-factory',
        'Psr\\Http\\Client', 'Psr\\Http\\Message',
        // Httplug (legacy PHP HTTP standard, predates PSR-18 but still widespread)
        'php-http/httplug', 'php-http/client-common', 'php-http/discovery',
        'Http\\Client', 'Http\\Message',
        // ── Databases / ORMs ──
        'PDO', 'illuminate/database', 'doctrine/orm', 'doctrine/dbal',
        // ── Time-series ──
        'influxdb/influxdb-php', 'influxdata/influxdb-client-php',
        // ── Message queues & event streams ──
        'php-amqplib/php-amqplib', 'enqueue/engine', 'symfony/messenger',
        // Google Cloud PHP SDK (google/cloud-pubsub). A PHP file importing the
        // Pub/Sub namespace is a messaging I/O source, so its functions schedule
        // past the taint gate where the topic()/subscription() accessor is then
        // recognized as a channel. Match both the composer package and the
        // namespace (mirrors the Psr\Http convention above).
        'google/cloud-pubsub', 'Google\\Cloud\\PubSub',
    ] as const;

    readonly runtimeServiceSignals = {
        manifestFields: [
            { manifest: 'composer.json', jsonPath: 'bin', condition: 'exists' as const },
        ],
        entrypoints: [
            {
                files: [
                    'public/index.php', 'web/index.php', 'public_html/index.php',
                    'bin/console', 'bin/server.php', 'app/console',
                ],
                // Presence + content sanity: PHP open tag or php shebang.
                patterns: [/<\?php\b/, /^#!.*\bphp\b/m],
            },
        ],
        dependencyMarkers: [
            { manifest: 'composer.json', packages: ['symfony/runtime', 'laravel/framework'], sections: ['require'] },
        ],
        manifestPresence: [
            {
                manifest: 'composer.json',
                requireSection: 'require',
                minSourceFiles: 10,
                sourceExtensions: ['.php'],
            },
        ],
    } as const;

    readonly frameworkRoleSignals = {
        'graphql-server': {
            dependencyMarkers: [
                {
                    manifest: 'composer.json',
                    packages: [
                        'nuwave/lighthouse',
                        'webonyx/graphql-php',
                        'overblog/graphql-bundle',
                        'rebing/graphql-laravel',
                        'thecodingmachine/graphqlite',
                    ],
                    sections: ['require'],
                },
            ],
        },
    } as const;

    private parserInstance: Parser | null = null;

    promptHints(): string {
        return PHP_PROMPT_HINTS;
    }

    createParser(): Parser {
        if (!this.parserInstance) {
            this.parserInstance = new Parser();
            this.parserInstance.setLanguage(patchLanguage(phpExport.php));
        }
        return this.parserInstance;
    }

    extractFunctions(tree: Parser.Tree, source: string, filepath: string, relativePath?: string): CodeChunk[] {
        return extractPhpFunctions(tree, source, filepath, relativePath);
    }

    extractStaticInfra(rootNode: Parser.SyntaxNode, chunk: CodeChunk): StaticInfraResult | null {
        return extractPhpStaticInfraFromRoot(rootNode, chunk);
    }

    extractValueFacts(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractPhpValueFacts(rootNode, source, filepath);
    }

    extractCriticalInvocations(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractPhpCriticalInvocations(rootNode, source, filepath);
    }

    extractStaticSupplements(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
        chunk: CodeChunk,
    ) {
        return extractPhpStaticSupplements(rootNode, source, filepath, chunk);
    }

    recognizesInjectedToken(
        token: string,
        constructorSource: string,
        classProperties: readonly string[],
    ): boolean {
        return phpRecognizesInjectedToken(token, constructorSource, classProperties);
    }

    extractEnvVars(node: Parser.SyntaxNode): string[] {
        return extractPhpEnvVars(node);
    }

    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
        return extractPhpImports(rootNode, context);
    }

    extractExports(rootNode: Parser.SyntaxNode): string[] {
        return extractPhpExports(rootNode);
    }

    extractImplementsFiles(rootNode: Parser.SyntaxNode, context: ImportContext): string[] {
        return extractPhpImplementsFiles(rootNode, context);
    }

    extractClassPropertyAliases(rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
        return extractPhpClassPropertyAliases(rootNode);
    }

    extractTypeDefinitions(rootNode: Parser.SyntaxNode): Map<string, DataStructureDefinition> {
        return extractPhpTypeDefinitions(rootNode);
    }

    extractReferencedTypes(rootNode: Parser.SyntaxNode): Map<string, string[]> {
        return extractPhpReferencedTypes(rootNode);
    }

    extractFunctionPayloadHints(rootNode: Parser.SyntaxNode): Map<string, FunctionPayloadHints> {
        return extractPhpFunctionPayloadHints(rootNode);
    }

    extractBaseTypesFromString(typeString: string): string[] {
        return extractPhpBaseTypesFromString(typeString);
    }

    extractImportStatements(rootNode: Parser.SyntaxNode): string[] {
        return extractPhpImportStatements(rootNode);
    }

    extractConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string> {
        return extractPhpConstructorSources(rootNode);
    }

    extractFileConstants(rootNode: Parser.SyntaxNode): Array<{ scope: string; name: string; value: string }> {
        return extractPhpFileConstants(rootNode);
    }

    loadDependencyMappings(repoRoot: string): DependencyMapping[] {
        return loadPhpDependencyMappings(repoRoot);
    }

    loadLocalPathDependencies(manifestDir: string): string[] {
        return loadPhpLocalPathDependencies(manifestDir);
    }

    async extractDependencies(repoPath: string): Promise<PackageDependency[]> {
        return extractPhpDependencies(repoPath);
    }

    parseManifestDependencies(fileName: string, fileContent: string): ManifestDependency[] | null {
        if (fileName !== 'composer.json') return null;
        return parseComposerManifestDependencies(fileContent);
    }

    validateInboundPath(path: string, sourceCode: string): boolean | undefined {
        return validatePhpInboundPath(path, sourceCode);
    }

    recognizesServiceLocatorKey(name: string, sourceCode: string): boolean {
        return phpRecognizesServiceLocatorKey(name, sourceCode);
    }

    recognizesFrameworkDiHandle(name: string, kind: FrameworkDiHandleKind): boolean {
        return phpRecognizesFrameworkDiHandle(name, kind);
    }

    recognizesPlatformIoBuiltin(name: string, sourceCode: string): boolean {
        return phpRecognizesPlatformIoBuiltin(name, sourceCode);
    }

    recognizesInProcessEvent(name: string, sourceCode: string): boolean {
        return phpRecognizesInProcessEvent(name, sourceCode);
    }

    recognizesPublishPayloadConstruction(name: string, sourceCode: string): boolean {
        return phpRecognizesPublishPayloadConstruction(name, sourceCode);
    }

    recognizesDocumentCollectionContainer(name: string, sourceCode: string): boolean {
        return phpRecognizesDocumentCollectionContainer(name, sourceCode);
    }

    recognizesDocumentCollectionAccess(sourceCode: string): boolean {
        return phpRecognizesDocumentCollectionAccess(sourceCode);
    }

    inferBrokerTechnology(sourceCode: string): string | undefined {
        return phpInferBrokerTechnology(sourceCode);
    }

    extractDeterministicConfigSymbols(content: string): DeterministicConfigSymbol[] {
        return extractSymfonyMessengerSymbols(content);
    }

    recognizesGlobalValueKey(key: string): boolean {
        return phpRecognizesGlobalValueKey(key);
    }

    globalValueKeysForMessageClass(expression: string): string[] {
        return phpGlobalValueKeysForMessageClass(expression);
    }

    recognizesOrmMetadataChunk(rawSource: string): boolean {
        return phpRecognizesOrmMetadataChunk(rawSource);
    }

    hasServiceCallsInRange(rootNode: Parser.SyntaxNode, startLine: number, endLine: number): boolean | undefined {
        const funcNode = findNodeSpanning(rootNode, startLine, endLine);
        if (!funcNode) return undefined;

        // In PHP, all three call types are inherently service/IO candidates:
        // member_call_expression = $this->repo->find() (DI service call)
        // scoped_call_expression = static::query() (static method on model)
        // function_call_expression = curl_exec(), fopen() (global IO functions)
        return walkForServiceCalls(funcNode, PHP_CALL_TYPES, () => true);
    }
}
