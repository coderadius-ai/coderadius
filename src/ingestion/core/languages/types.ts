import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../graph/types.js';
import type { ImportRef, ClassPropertyAlias, DependencyBinding } from '../import-graph.js';
import type { CriticalInvocationFact, ValueFact } from '../value-resolution/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Language Plugin Interface
//
// Each language (TypeScript, PHP, Go, Python, ...) implements this interface
// as a self-contained module. The pipeline is fully language-agnostic — it
// dispatches through the registry and never contains language-specific code.
//
// To add a new language:
//   1. Create a new file in this directory implementing LanguagePlugin
//   2. Register it in registry.ts
//   That's it. No other files need to change.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to import extraction so the plugin can resolve
 * namespace/file dependencies against the actual repo contents.
 */
export interface ImportContext {
    /** Relative path of the file being parsed */
    filePath: string;
    /** All file paths existing in the repo (for local resolution checks) */
    allFilePaths: Set<string>;
    /** Dependency mappings loaded from config (PSR-4, tsconfig.paths, go.mod) */
    dependencyMappings: DependencyMapping[];
}

/**
 * A resolved namespace→directory mapping (e.g. PSR-4, tsconfig path alias).
 */
export interface DependencyMapping {
    /** Namespace/import prefix (e.g. 'Acme\\' or '@app/') */
    prefix: string;
    /** Directory path relative to repo root (e.g. 'src/') */
    directory: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Runtime Service Signals — declarative classification of runtime vs library
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A manifest field assertion. The autodiscovery layer reads the manifest
 * (e.g. package.json, composer.json, pyproject.toml) and evaluates the
 * predicate against the field at `jsonPath`.
 */
export interface RuntimeServiceManifestField {
    /** Source manifest filename (e.g. 'package.json', 'composer.json'). */
    manifest: string;
    /** Dotted path into the parsed manifest object (e.g. 'scripts.start', 'bin'). */
    jsonPath: string;
    /** Predicate against the resolved value. */
    condition: 'exists' | 'matches';
    /** When condition='matches', regex to test the stringified value. */
    valuePattern?: RegExp;
}

/**
 * A grep predicate against a set of entrypoint candidate files in the workspace.
 * If any file in `files` (resolved relative to the workspace dir) matches any
 * `patterns`, the signal fires.
 */
export interface RuntimeServiceEntrypoint {
    /** Relative file paths to inspect. Glob patterns NOT supported (use exact paths). */
    files: readonly string[];
    /** Regex patterns. The signal fires if ANY pattern matches ANY file's content. */
    patterns: readonly RegExp[];
}

/**
 * A declared dependency marker against an ecosystem manifest (package.json,
 * composer.json, requirements.txt, go.mod). The signal fires if the workspace's
 * manifest lists any of `packages` as a direct dependency.
 */
export interface RuntimeServiceDependencyMarker {
    /** Source manifest filename (e.g. 'package.json', 'composer.json'). */
    manifest: string;
    /** Dependency package names to look for (e.g. ['nuwave/lighthouse']). */
    packages: readonly string[];
    /** Sections of the manifest to consult. */
    sections?: readonly string[];
}

/**
 * Codifies "this workspace looks like a real application codebase" without
 * naming a specific framework. Fires when the manifest declares a non-empty
 * `requireSection` AND the workspace contains at least `minSourceFiles`
 * files with the plugin's source extensions. Guards against vendored snippet
 * directories and toy `examples/` trees.
 */
export interface RuntimeServiceManifestPresence {
    /** Source manifest filename (e.g. 'composer.json', 'package.json'). */
    manifest: string;
    /** Dotted manifest section that must list at least one entry (e.g. 'require', 'dependencies'). */
    requireSection: string;
    /** Minimum number of source files (per plugin.fileExtensions) inside the workspace. */
    minSourceFiles: number;
    /** Source extensions to count (e.g. ['.php'], ['.ts','.tsx']). Plugin-defined. */
    sourceExtensions: readonly string[];
}

/**
 * Declarative description of the signals that, when at least one fires,
 * classify a workspace as a *runtime service* rather than a *library*.
 *
 * The autodiscovery orchestrator owns the I/O (fs reads, JSON parsing, regex
 * evaluation) so plugins only declare *what to look for*, never *how to look*.
 */
export interface RuntimeServiceSignals {
    manifestFields?: readonly RuntimeServiceManifestField[];
    entrypoints?: readonly RuntimeServiceEntrypoint[];
    dependencyMarkers?: readonly RuntimeServiceDependencyMarker[];
    manifestPresence?: readonly RuntimeServiceManifestPresence[];
}

/**
 * Per-workspace framework-role signals. Each entry uses the same shape as
 * `RuntimeServiceSignals` and is evaluated independently. The any-of
 * semantics within each signal set still applies.
 *
 * Canonical role keys (extend as new fixes need them):
 *   - 'graphql-server'   : workspace hosts a GraphQL server bootstrap
 *
 * Reads naturally as "this workspace plays the role X" — the orchestrator
 * builds a per-service `Set<roleKey>` that downstream stages consume.
 */
export type FrameworkRoleSignals = Readonly<Record<string, RuntimeServiceSignals>>;

export type FrameworkSignalScope = 'module' | 'class' | 'method' | 'field';

/**
 * Resource-name kind for `recognizesFrameworkDiHandle`: some framework DI
 * conventions are channel-only (a `*_transport` table is plausible, a
 * `*_transport` channel is a Messenger handle).
 */
export type FrameworkDiHandleKind = 'channel' | 'container';

/**
 * Language-agnostic shape for plugin-extracted deterministic config-symbol
 * bindings (`extractDeterministicConfigSymbols`). Mirrors the LLM
 * config-symbol extractor's binding schema so both register through the
 * same codepath.
 */
export interface DeterministicConfigSymbol {
    /** DI service id / config key. */
    diKey: string;
    /** Physical resource name the key resolves to (queue, routing key, table). */
    physicalName: string;
    category?: string;
    technology?: string;
    /** Short class name the service binds to (DI propagator territory). */
    boundComponent?: string;
}

export type FrameworkSignalMetadataValue =
    | string
    | number
    | boolean
    | string[]
    | null
    | undefined;

/**
 * Deterministic framework/decorator signal resolved from the AST.
 *
 * These signals normalize framework-specific metadata (decorators, builder
 * calls, schema declarations) into a compact structure that downstream
 * pipeline stages can use for:
 *   - synthetic metadata chunk emission
 *   - prompt enrichment
 *   - deterministic post-LLM overlays
 */
export interface FrameworkSignal {
    framework: string;
    kind: string;
    scope: FrameworkSignalScope;
    ownerName: string;
    resolvedName?: string;
    literalArgs?: string[];
    startLine: number;
    endLine: number;
    confidence: number;
    metadata?: Record<string, FrameworkSignalMetadataValue>;
}

export interface ResourceDeclaration {
    kind: 'datastore';
    logicalId: string;
    technology: string;
    evidence?: string;
    host?: string;
    port?: number;
    dbName?: string;
    endpointKey?: string;
    configuredVia?: string[];
    declarationSource: 'nestjs-for-root' | 'provider-factory';
}

export interface ClientBinding {
    token: string;
    /**
     * Plugin-stamped client kind. Generic families ('sdk', 'http') or a
     * concrete client identifier the plugin recognizes (TS stamps
     * 'urql'/'apollo', other ecosystems stamp their own). Kept open so the
     * agnostic interface never enumerates one ecosystem's client brands;
     * the discriminating semantics live in `protocol`.
     */
    clientKind: string;
    protocol: 'graphql' | 'http';
    evidence?: string;
    typeName?: string;
    baseUrlHint?: string;
}

export interface ResolvedConstant {
    key: string;
    value: string;
    source: 'local' | 'imported';
    sourceFile?: string;
}

export interface StaticSupplementalResult {
    resourceDeclarations?: ResourceDeclaration[];
    clientBindings?: ClientBinding[];
    resolvedConstants?: ResolvedConstant[];
}

/**
 * The contract every language plugin must fulfil.
 */
export interface LanguagePlugin {
    /** Language identifier (must match tree-sitter grammar name) */
    readonly language: string;

    /**
     * Package ecosystem identifier for cross-cutting registries (sink classifier,
     * lockfile graph, dependency analysis). e.g. 'npm', 'composer', 'pypi', 'go'.
     */
    readonly ecosystem?: string;

    /** File extensions handled by this plugin (e.g. ['.ts', '.tsx', '.js']) */
    readonly extensions: readonly string[];

    /**
     * Language-specific glob patterns to add to the scope blacklist.
     * (e.g. ['*.test.ts', '*Proxy.php'])
     */
    readonly scopeExclusions: readonly string[];

    /**
     * Manifest files that indicate a service root for this language.
     * e.g. [{ file: 'package.json', language: 'javascript' }]
     * Used by auto-discovery and file-discovery.
     */
    readonly manifestFiles?: readonly { file: string; language: string }[];

    /**
     * Glob patterns for directories to always ignore for this language.
     * e.g. `['node_modules', 'dist']` (will be wrapped as `**‌/pattern/**`)
     * Language-agnostic ignores (like `.git`) stay in the consumers.
     */
    readonly ignorePatterns?: readonly string[];

    /**
     * Ecosystem-specific I/O sink package names (npm/composer/pypi/go modules
     * that perform network/database/queue/storage I/O when imported). Used by
     * the taint propagation engine as seed: any file that imports one of these
     * packages becomes a Patient Zero. Plugin-owned to keep `import-graph.ts`
     * language-agnostic per CLAUDE.md §1, §2.
     */
    readonly sinkPackages?: readonly string[];

    /**
     * Declarative signals that mark a discovered workspace as a *runtime service*
     * (an executable component that hosts its own process — API, worker, CLI server)
     * as opposed to a *library* (code reused by other workspaces, no entrypoint).
     *
     * The autodiscovery layer evaluates these signals against the workspace
     * directory and classifies the `DiscoveredComponent.type` accordingly.
     * If none of the signals fire and the catalog does not specify a type,
     * the component is left `undefined` with grounding `speculative`.
     *
     * Declarative shape ensures the core stays language-agnostic
     * (CLAUDE.md §1, §2): plugins declare *data*, the orchestrator owns
     * the I/O and control flow.
     */
    readonly runtimeServiceSignals?: RuntimeServiceSignals;

    /**
     * Declarative per-workspace role signals. Each role key (e.g.
     * `'graphql-server'`) maps to a `RuntimeServiceSignals` block evaluated
     * with any-of semantics. The orchestrator collects the set of detected
     * roles per service and feeds it to downstream stages (e.g. the GraphQL
     * INBOUND gate in the graph writer).
     */
    readonly frameworkRoleSignals?: FrameworkRoleSignals;

    // ─── Parsing ─────────────────────────────────────────────────────────────

    /** Create a Tree-sitter parser configured for this language. */
    createParser(): Parser;

    /**
     * Extract function/method chunks from a parsed AST.
     * Each chunk is a single LLM analysis unit.
     *
     * `relativePath` is the repo-relative path of the file. Plugins that
     * derive web-facing identifiers from the file location (e.g. PHP legacy
     * filesystem routes) must use it instead of `filepath`, which may be
     * machine-absolute.
     */
    extractFunctions(
        tree: Parser.Tree,
        source: string,
        filepath: string,
        relativePath?: string,
    ): CodeChunk[];

    /**
     * Extract normalized framework/decorator signals from the AST.
     *
     * These signals are architecture-relevant facts resolved from the AST
     * (decorators, model/table builders, validation/schema metadata, etc.).
     * They do not introduce new graph node types by themselves; downstream
     * stages decide how to map them onto the existing graph model.
     */
    extractFrameworkSignals?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
    ): FrameworkSignal[];

    /**
     * Extract deterministic supplemental facts for a specific chunk.
     *
     * Unlike extractStaticInfra(), these facts do NOT bypass the LLM by
     * themselves. They enrich the pipeline with deterministic declarations
     * (datastore configs, provider client bindings, resolved constants)
     * that are merged beside the semantic extraction result.
     */
    extractStaticSupplements?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
        chunk: CodeChunk,
    ): StaticSupplementalResult | null;

    /**
     * Decide whether a DI token (typically the FQCN of a wrapper class
     * registered via `coderadius.yaml` decorators, or a TS DI symbol/token)
     * is actually injected into the analyzed unit's enclosing class.
     *
     * The Static Analyzer pipeline calls this once per (chunk, registered
     * binding) pair when assembling the LLM prompt's "Client Bindings"
     * block. Returning `true` adds a deterministic line to the prompt:
     *
     *     <token> -> <clientKind> <protocol> baseUrl=<hint>
     *
     * Each language plugin owns its own injection convention — TypeScript
     * inspects `constructorSource` for `@Inject(<token>)`, PHP scans
     * `classProperties` for type-hinted promoted/declared properties, etc.
     * The pipeline core stays language-agnostic.
     *
     * @param token              DI token / FQCN as registered by the
     *                           deterministic static-supplements path.
     * @param constructorSource  Verbatim constructor source (may be empty
     *                           when the class declares no constructor).
     * @param classProperties    Pre-formatted `prop: Type` lines for the
     *                           enclosing class — promoted-properties and
     *                           declared properties, language-normalised.
     */
    recognizesInjectedToken?(
        token: string,
        constructorSource: string,
        classProperties: readonly string[],
    ): boolean;

    /**
     * Extract local value-resolution facts from a source file.
     *
     * These are not injected as file constants. They are consumed by the
     * language-agnostic value-resolution engine to trace expressions used in
     * critical I/O invocations through local assignments and import edges.
     */
    extractValueFacts?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
    ): ValueFact[];

    /**
     * Extract calls whose arguments may identify external infrastructure
     * resources, e.g. publish(topic), fetch(url), collection(name).
     */
    extractCriticalInvocations?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
        chunk?: CodeChunk,
    ): CriticalInvocationFact[];

    /**
     * Extract environment variable names referenced in an AST subtree.
     * (e.g. process.env.FOO → 'FOO', getenv('BAR') → 'BAR')
     */
    extractEnvVars(node: Parser.SyntaxNode): string[];

    // ─── Import Graph / Taint Engine ─────────────────────────────────────────

    /**
     * Extract import/use/require declarations from the file's AST.
     * Sets isExternal=false only when the import resolves to a file
     * actually present in the repo (enabling file→file taint edges).
     */
    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[];

    /**
     * Extract exported class/function symbol names (used by taint BFS).
     */
    extractExports(rootNode: Parser.SyntaxNode): string[];

    /**
     * Optional: extract file paths of parent classes / implemented interfaces
     * declared by this file's classes. Returns paths the language plugin can
     * resolve via its namespace mapping (PSR-4 for PHP, module resolution
     * for TS/JS). Used by the taint pass to back-propagate I/O semantics
     * through interface contracts (a Patient Zero implementor taints its
     * interface so DI consumers of the interface inherit the taint).
     */
    extractImplementsFiles?(rootNode: Parser.SyntaxNode, context: ImportContext): string[];

    /**
     * Map class constructor properties → imported type names (DI detection).
     * (e.g. `private api: ApiGateway` → { propertyAccess: 'this.api', typeName: 'ApiGateway' })
     */
    extractClassPropertyAliases(rootNode: Parser.SyntaxNode): ClassPropertyAlias[];

    /**
     * Extract dependency injection bindings (e.g. NestJS provide/useClass).
     */
    extractDependencyBindings?(rootNode: Parser.SyntaxNode, filePath: string): DependencyBinding[];

    // ─── Static Analyzer Helpers (LLM context) ───────────────────────────────

    /**
     * Extract raw import/use statement strings to inject into the LLM prompt.
     * These give the LLM the context it needs to resolve DI types.
     */
    extractImportStatements(rootNode: Parser.SyntaxNode): string[];

    /**
     * Extract constructor source code per class name.
     * Used by the static analyzer to build the LLM context for DI resolution.
     */
    extractConstructorSources(rootNode: Parser.SyntaxNode): Map<string, string>;

    /**
     * Extract string/number constants declared in the file scope and class bodies.
     * Used to build classConstantsContext for LLM prompt enrichment.
     *
     * Returns a flat list of { scope, name, value } triples where:
     *   scope = class name (e.g. "PreferredResultService") for class-level constants,
     *           or "" for module-level constants
     *   name  = constant identifier (e.g. "EVENT_NAME", "TOPIC")
     *   value = string representation of the literal value (e.g. "'my.topic'", "300")
     *
     * Scope guard: ONLY string/number literals. Skip any initializer that is a
     * reference expression, function call, template literal with interpolation, or object.
     *
     * Limitation: only intra-file constants are resolved. Constants imported from
     * another module (e.g. `import { Events } from '../constants'`) are NOT resolved;
     * cross-file constant resolution would require the ImportGraph.
     */
    extractFileConstants?(rootNode: Parser.SyntaxNode): Array<{
        /** Class name for class-level constants, empty string for module-level. */
        scope: string;
        /** Constant identifier name. */
        name: string;
        /** Literal value as a string, e.g. "'my.topic'" or "300". */
        value: string;
    }>;

    // ─── Dependency Resolution (optional) ────────────────────────────────────

    /**
     * Load project-level dependency mappings from config files.
     * (e.g. PSR-4 from composer.json, path aliases from tsconfig.json)
     *
     * Called once per repo before any file is analyzed.
     * Returns [] if the language doesn't have project-level dependency config.
     */
    loadDependencyMappings?(repoRoot: string): DependencyMapping[];

    /**
     * Relative directory paths the manifest at `manifestDir` declares as
     * LOCAL path dependencies (e.g. Composer `repositories[type=path]`,
     * npm `file:` protocol deps). May contain glob patterns, returned
     * verbatim. Returns [] when the language has no such concept.
     *
     * Autodiscovery uses this to recognise monolith roots that vendor their
     * own sub-workspaces: such a root is a real application, not workspace
     * tooling, and must survive child-wins pruning.
     */
    loadLocalPathDependencies?(manifestDir: string): string[];

    /**
     * Extract lockfile/manifest package dependencies for this language ecosystem.
     * (e.g. from package.json/yarn.lock, composer.json/lock, go.mod/sum)
     */
    extractDependencies?(repoRoot: string): Promise<PackageDependency[]>;

    /**
     * Parse a single dependency manifest owned by this language's ecosystem
     * (e.g. package.json, composer.json). Returns null when the file is not a
     * manifest this plugin recognizes; otherwise the declared dependencies,
     * with ecosystem platform/runtime constraints already excluded.
     */
    parseManifestDependencies?(fileName: string, fileContent: string): ManifestDependency[] | null;

    /**
     * Normalize a raw import string (as it appears in `ImportRef.source`) to its
     * package name in the language's ecosystem. Used by the cross-repo sink
     * classifier so that `axios/dist/foo` and `Doctrine\ORM\EntityManager` are
     * classified by their root package (`axios`, `doctrine/orm`).
     *
     * Default behavior (when not implemented) is identity. Implementations
     * should return a STABLE canonical package name; never invent values.
     */
    normalizePackageName?(rawImport: string): string;

    // ─── LLM Prompt Augmentation (optional) ──────────────────────────────────

    /**
     * Return language-specific rules to inject into the unified-analyzer prompt.
     *
     * Use this to teach the LLM about:
     *  - Language-specific idioms that look like I/O but aren't (anti-hallucination)
     *  - Native functions that ARE I/O but look like logic
     *  - Framework-specific patterns (NestJS decorators, Django ORM, etc.)
     *
     * Keep hints concise — they are injected directly into each per-function prompt.
     * Return undefined (or don't implement) if no language-specific hints needed.
     */
    promptHints?(): string;

    // ─── Deep Mode: Cross-File Type Injection (optional) ─────────────────────

    /**
     * Extract class/interface/type definitions from the file's AST.
     * Returns a map: TypeName → { name, kind, properties[] }.
     *
     * Properties are depth-1 only: if a property type is another custom type
     * (e.g. `driver: DriverDTO`), the type is recorded as the string "DriverDTO"
     * without resolving it further.
     *
     * Used by `--depth contracts` to build a global TypeDefinitionIndex.
     */
    extractTypeDefinitions?(rootNode: Parser.SyntaxNode): Map<string, DataStructureDefinition>;

    /**
     * Extract custom type references from each function/method in the file's AST.
     * Returns a map: functionName → typeBaseNames[].
     *
     * Sources: parameter type annotations, return types, `new` expressions.
     * Primitives (string, number, int, bool, array, void, etc.) are filtered out.
     *
     * Used by `--depth contracts` to resolve which types a function needs injected.
     */
    extractReferencedTypes?(rootNode: Parser.SyntaxNode): Map<string, string[]>;

    /**
     * Phase 1 (AST-first payload extraction): emit per-function payload hints.
     * Each `TypeRef` carries `{ fqcn, basename, origin }`. The plugin computes
     * `basename` natively using its language's namespace rules. Downstream
     * matchers (graph-writer mergeAstWithLlm, sanitizer opaque recovery)
     * compare `basename` to the LLM-emitted short name directly.
     */
    extractFunctionPayloadHints?(rootNode: Parser.SyntaxNode): Map<string, FunctionPayloadHints>;

    /**
     * Phase 3 (REFERENCES_TYPE welder): parse a `DataField.type` string into
     * a list of base type names that may refer to a DataStructure. Each
     * plugin owns its language's idiosyncrasies (TS utility types abort,
     * PHP unions/nullable, etc.). The core never re-interprets the string.
     */
    extractBaseTypesFromString?(typeString: string): string[];

    // ─── Static-First: Deterministic Infrastructure Extraction (optional) ────

    /**
     * Extract deterministic infrastructure from a class-level or function-level
     * AST node. Returns a complete UnifiedAnalysis if the metadata is fully
     * resolvable from the AST, or null if the chunk requires LLM analysis.
     *
     * Called by the static-analyzer for every chunk BEFORE the heuristic filter.
     * If this returns a non-null value, the chunk bypasses both the heuristic
     * filter and the LLM entirely.
     *
     * Contract:
     *   - MUST only return data extractable with 100% confidence from the AST
     *   - MUST NOT guess or infer — if a table name isn't a string literal, return null
     *   - Dynamic values (variables, config keys) → return null (let LLM handle it)
     */
    extractStaticInfra?(rootNode: Parser.SyntaxNode, chunk: CodeChunk): StaticInfraResult | null;

    // ─── INBOUND Path Validation (optional, Strategy Pattern) ────────────────

    /**
     * Language-specific validation for LLM-inferred INBOUND endpoint paths.
     *
     * When implemented, this method is called by `sanitizeAnalysis()` INSTEAD
     * of the generic polyglot `isInboundPathEvident()` fallback. Use it to
     * encode language-specific rules for what constitutes valid INBOUND path
     * evidence in the source code.
     *
     * Design rationale: a single polyglot regex trying to support PHP, Django,
     * Express, and Go simultaneously degrades to a lowest-common-denominator
     * colabrodo. Each language has unique routing syntax; the plugin is the
     * correct place to encode that domain knowledge (Strategy Pattern / OCP).
     *
     * @param path       Full INBOUND path claimed by the LLM (e.g. '/api/pay')
     * @param sourceCode Source code of the function chunk being analyzed
     *
     * @returns
     *   - `true`      Evidence found — keep the endpoint
     *   - `false`     No evidence — drop as hallucination
     *   - `undefined` Defer to generic `isInboundPathEvident()` fallback
     *
     * Dynamic route architecture note:
     *   prefix+literal (e.g. `BASE_URL + '/pay'`) → literal IS in source → handled ✅
     *   fully dynamic (e.g. `$_ENV['ROUTE']`)     → LLM is also blind → drop is correct ✅
     *   cross-file constants                       → static extractor covers these separately ✅
     */
    validateInboundPath?(path: string, sourceCode: string): boolean | undefined;

    /**
     * Evidence-based DI guard: true when `name` occurs in `sourceCode` ONLY
     * as the literal argument of a service-locator getter (PSR-11 / framework
     * container contract for this language). Such a name is a DI handle the
     * code looks up, never a physical channel/table — the sanitizer drops it
     * regardless of its shape, with zero name lists. Any other occurrence of
     * the name (publish arg, SQL text, config value) is counter-evidence.
     */
    recognizesServiceLocatorKey?(name: string, sourceCode: string): boolean;

    /**
     * Shape-based DI guard: true when `name` matches a PUBLISHED framework
     * DI/service-id convention of this language's ecosystem (e.g. PHP:
     * Symfony `doctrine.*`/`messenger.*` dotted ids, Laminas RabbitMqModule
     * `rabbitmq.producer.*` aliases, Messenger `*_transport` handles). Such
     * a name is a handle, never a physical channel/table — even when a
     * resolver stamped it as "resolved" (a name still shaped like the DI
     * namespace was not resolved to a physical name).
     *
     * `kind` scopes channel-only conventions: a `*_transport` TABLE
     * (`shipment_transport`) is plausible, a `*_transport` CHANNEL is a
     * Messenger handle.
     *
     * The grammar lives in the plugin so other ecosystems are untouched: a
     * Node.js Kafka topic named `messenger.events.dispatched` must survive.
     */
    recognizesFrameworkDiHandle?(name: string, kind: FrameworkDiHandleKind): boolean;

    /**
     * Evidence-based platform-I/O guard: true when `name` is a builtin of
     * this language that performs platform-LOCAL I/O (logging facility) and
     * `sourceCode` shows a real call to it (string/comment-masked scan).
     * Such a name is never a broker channel; the sanitizer drops it.
     */
    recognizesPlatformIoBuiltin?(name: string, sourceCode: string): boolean;

    /**
     * Evidence-based in-process event guard: true when `name` is an event
     * class dispatched through this ecosystem's IN-PROCESS dispatcher
     * (synchronous notification, not a broker message) with no transport
     * marker in `sourceCode`. PHP implements Symfony EventDispatcher vs
     * Messenger/AMQP discrimination.
     */
    recognizesInProcessEvent?(name: string, sourceCode: string): boolean;

    /**
     * Evidence-based publish-payload guard: true when `sourceCode` shows
     * `name` constructed as the message BODY of a physical publish call
     * (e.g. PHP `->publish(new \Ns\OrderPlacedEvent(...))`) — the class is
     * the serialized payload, never the channel.
     */
    recognizesPublishPayloadConstruction?(name: string, sourceCode: string): boolean;

    /**
     * True when `sourceCode` shows DataContainer `name` produced by this
     * ecosystem's standard document-DB driver collection accessor (PHP:
     * Mongo `->selectCollection(...)`). The sanitizer stamps the container
     * document/mongodb so the family binder routes it correctly.
     */
    recognizesDocumentCollectionContainer?(name: string, sourceCode: string): boolean;

    /**
     * True when `sourceCode` performs ANY document-DB collection access in
     * this ecosystem's driver syntax. Used to reclassify a mislabelled
     * MessageChannel to Database.
     */
    recognizesDocumentCollectionAccess?(sourceCode: string): boolean;

    /**
     * Infer the broker technology from this ecosystem's SDK markers in the
     * source (first match wins, plugin-ordered). Returns the canonical
     * technology id ('pubsub' | 'rabbitmq' | 'kafka' | ... |
     * 'symfony-messenger') or undefined when no marker is present. The
     * sanitizer composes this with its agnostic physical-vs-abstract
     * classification; the SDK grammar lives here.
     */
    inferBrokerTechnology?(sourceCode: string): string | undefined;

    /**
     * Deterministic config-symbol extraction: parse framework DI-config
     * shapes fully from source (no LLM) and return DI-key → physical-name
     * bindings. The symbol-extraction dispatcher calls this per file of
     * this language; a non-empty result skips the LLM config-symbol
     * extractor entirely (cache-independent resolution). PHP implements
     * Symfony ContainerBuilder messenger tags.
     */
    extractDeterministicConfigSymbols?(content: string): DeterministicConfigSymbol[];

    /**
     * True when `key` belongs to this plugin's declared GLOBAL value-fact
     * namespace (cross-file symbol keys the plugin's extractors emit, e.g.
     * PHP's Messenger routing table). The value-resolution engine indexes
     * only claimed keys in its global map; namespacing by plugin keeps the
     * core free of framework key grammars.
     */
    recognizesGlobalValueKey?(key: string): boolean;

    /**
     * Candidate global value-fact keys to look up for a message-class
     * routing expression (role 'messageClass'). The plugin owns its
     * language's name normalization (PHP: backslash-namespace → dotted,
     * plus the short class name) and its framework's key namespace.
     */
    globalValueKeysForMessageClass?(expression: string): string[];

    /**
     * True when a synthetic `::__class_metadata` chunk's source declares an
     * ORM-mapped entity in this language's ecosystem (annotations,
     * attributes, base classes, mapping properties). Used by the heuristic
     * pre-filter to schedule entity-mapping chunks past the I/O gates.
     */
    recognizesOrmMetadataChunk?(rawSource: string): boolean;

    // ─── AST Service Call Detection (optional, Gate 2.5) ─────────────────────

    /**
     * AST-based check: does the given source range contain at least one
     * call expression that targets a service/dependency (member call,
     * method invocation on an injected property, etc.)?
     *
     * Used by Gate 2.5 in the task builder to verify that a Gate 2
     * tainted-symbol match actually involves a service invocation, not
     * just a type annotation, variable declaration, or parameter list.
     *
     * Language plugins implement this using their specific tree-sitter
     * node types:
     *   - TS:     call_expression → callee is member_expression
     *   - PHP:    member_call_expression | scoped_call_expression
     *   - Go:     call_expression → callee is selector_expression
     *   - Python: call → callee is attribute
     *
     * @returns true      Service calls detected → keep for LLM
     * @returns false     No service calls → skip LLM (pure function)
     * @returns undefined Defer to default behavior (don't filter)
     */
    hasServiceCallsInRange?(
        rootNode: Parser.SyntaxNode,
        startLine: number,
        endLine: number,
    ): boolean | undefined;

    /**
     * Gate 4 taint override (stricter): does this function call a method on
     * `this` (injected dependency)? Ignores calls on local variables
     * (date.toISOString, quote.price.toFixed) which are io-adjacent, not
     * io-caller. Returns undefined to defer to hasServiceCallsInRange.
     */
    hasInjectedDependencyCallsInRange?(
        rootNode: Parser.SyntaxNode,
        startLine: number,
        endLine: number,
    ): boolean | undefined;

    // ─── DI Binding Registry Support ───────────────────────────

    /**
     * Whether operation names in this language are case-insensitive at
     * lookup time. PHP is `true` (`$obj->PUBLISH()` and `$obj->publish()`
     * dispatch to the same method). TS/Rust/Haskell etc. are `false`.
     *
     * When `true`, `ComponentDefinition.operations[i].name` and
     * `CriticalInvocationFact.chainedMethod` are normalized to lowercase
     * at extraction time so the DiIoPropagator's
     * `Set<FQCN+operation>` visited set and `resolveDi(..., op)` lookup
     * match regardless of the casing used at the call site.
     *
     * Default (when omitted): `false` (case-sensitive).
     */
    readonly isCaseInsensitiveOnOperations?: boolean;

    /**
     * Extract the components declared in the file (classes / structs+impl /
     * modules / typeclasses, depending on the language). One entry per
     * component, listing its operations (methods / fns / module exports)
     * with source ranges and the interfaces it declares (interfaces in
     * OOP, traits in Rust, typeclasses in Haskell).
     *
     * Used by `ComponentIoIndex` to drive the DiIoPropagator DFS.
     */
    extractComponentDefinitions?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
    ): ComponentDefinition[];

    /**
     * Extract dependency requirements declared by components in the file.
     * Each `DependencyRequirement` represents one parameter/argument that
     * the owning component needs supplied at construction time:
     *
     *   - OOP constructor injection: `__construct(LoggerInterface $logger)`
     *   - Setter injection (Symfony @Required): `setLogger(LoggerInterface $logger)`
     *   - Functional: `fn new(db: Database) -> Self`
     *   - Reader monad / typeclass constraint: similar shape (future)
     *
     * Consumed by `DiBindingResolver` Phase 4 (autowiring interface
     * cross-check).
     */
    extractDependencyRequirements?(
        rootNode: Parser.SyntaxNode,
        source: string,
        filepath: string,
    ): DependencyRequirement[];
}

// ─── DI Binding Registry Types ────────────────

/**
 * A component declared in a source file: class (PHP/TS/Java), struct+impl
 * (Rust/Go), module (Python/OCaml), typeclass (Haskell). Carries operations
 * (methods / fns / exports) and declared interfaces/traits/typeclasses.
 */
export interface ComponentDefinition {
    /** Fully qualified name (e.g. `Acme\\Messaging\\NotificationPublisher`). */
    fqcn: string;
    /** Source file path (repo-relative). */
    file: string;
    operations: Array<{
        /** Operation name (lowercased when plugin.isCaseInsensitiveOnOperations). */
        name: string;
        /** Inclusive 1-based line range of the operation body in `file`. */
        range: { startLine: number; endLine: number };
    }>;
    /**
     * Declared interfaces / traits / typeclasses. Used by DiBindingResolver
     * Phase 3 (autowiring interface) and Phase 4 (constructor injection
     * cross-check). Empty array when the component declares none.
     */
    declaredInterfaces: string[];
    /**
     * Ordered constructor parameter names (ALL params, including scalars like
     * `string $topic`). Lets the DI resolver map a positionally-injected ctor
     * scalar (e.g. arg index 1) to the parameter it fills (`topic`). Undefined
     * when the component has no constructor.
     */
    constructorParameterNames?: string[];
}

/**
 * One dependency a component declares it needs supplied. Naming agnostic
 * over constructor injection (OOP) vs function-argument injection (FP).
 */
export interface DependencyRequirement {
    /** FQCN of the component that declares this requirement. */
    ownerComponent: string;
    /** Parameter / argument name (e.g. `$logger`, `db`). */
    parameterName: string;
    /** Declared type FQCN (interface, trait, typeclass, or concrete class). */
    requiredType: string;
    /**
     * Polymorphism marker: `true` when `requiredType` is an interface
     * (OOP), trait (Rust), or typeclass (Haskell). Drives DiBindingResolver
     * Phase 4 (single-implementer interface autowiring).
     */
    isAbstractType: boolean;
}

// ─── Deep Mode Types ─────────────────────────────────────────────────────────

/**
 * Phase 1 (AST-first payload extraction): per-function payload hints.
 *
 * `consumed` lists type references the function receives (parameter types).
 * `produced` lists type references the function emits (return types, new-expressions).
 * Each `TypeRef` is `{ fqcn, basename, origin }` already namespace-stripped.
 */
export interface FunctionPayloadHints {
    consumed: TypeRef[];
    produced: TypeRef[];
}

export interface TypeRef {
    /** Fully qualified type name as it appears in the source (e.g. "Acme\\Orders\\RenewalRequest"). */
    fqcn: string;
    /** Basename: last segment after the language's namespace separator. */
    basename: string;
    /** Originating syntactic position. */
    origin: 'parameter' | 'return-type' | 'new-expression';
}

/**
 * A data structure definition extracted from the AST.
 * Used to inject cross-file DTO/class context into the LLM prompt in `--depth contracts`.
 */
export interface DataStructureDefinition {
    /** Class/interface/type name (base name, e.g. "QuoteRequestDTO") */
    name: string;
    /** What kind of type declaration this is */
    kind: 'class' | 'interface' | 'type';
    /** Property definitions — depth-1 only (nested types are strings, not resolved) */
    properties: Array<{ name: string; type: string }>;
    /**
     * Discriminator for interface kind (Phase 1B): `'service'` if the interface
     * contains AT LEAST ONE method signature; `'data'` if it has only property
     * declarations. Undefined for non-interface kinds (`class`, `type`) and for
     * language plugins that don't yet populate it.
     *
     * Used by the sanitizer to drop `produced_payloads` / `consumed_payloads`
     * whose name matches a service-interface (these are AST-verified contracts,
     * not data structures). Data-interfaces are PRESERVED as legitimate payload
     * candidates (TS DTOs are commonly declared as `interface User { ... }`).
     */
    interfaceRole?: 'service' | 'data';
}

/**
 * A package dependency extracted from lockfiles or package manifests without LLMs.
 */
export interface PackageDependency {
    name: string;
    ecosystem: string;
    declaredRange: string;
    lockedVersion: string | null;
    isDev: boolean;
}

/**
 * A dependency declared in a single manifest file, parsed in isolation
 * (no lockfile resolution). Produced by `parseManifestDependencies`.
 */
export interface ManifestDependency {
    ecosystem: string;
    name: string;
    requiredVersion: string;
    isDev: boolean;
}

// ─── Static-First Types ──────────────────────────────────────────────────────

/**
 * Infrastructure reference extracted deterministically from AST metadata.
 * Mirrors the shape of the LLM's InfraRef but is produced without any LLM call.
 */
export interface StaticInfraRef {
    name: string;
    type: 'Database' | 'MessageChannel' | 'Cache' | 'ObjectStorage' | 'ExternalAPI' | 'Process';
    operation: 'READS' | 'WRITES' | 'MAPS_TO';
    channelKind?: 'topic' | 'subscription' | 'queue' | 'exchange';
    schemaPath?: string;
    schemaFormat?: 'avro' | 'json-schema' | 'protobuf';
    /**
     * Coarse technology family of the resource. Set by extractors that have
     * deterministic structural evidence (Doctrine `@ORM\Table` → `'rdbms'`,
     * Mongoose `Schema` → `'document'`, etc.). When set, downstream binding
     * (`resolveDatastoreBinding`) refuses to attach a connection of an
     * incompatible family — preventing e.g. a MySQL table from being linked
     * to the only available MongoDB connection in repos that lack explicit
     * `coderadius.yaml > databases[]` topology.
     */
    kindFamily?: 'rdbms' | 'document' | 'kv' | 'broker' | 'queue' | 'object';
}

/**
 * Schema (column-level) for an ORM entity mapped to a database table.
 *
 * Emitted by static extractors that parse `@ORM\Column` (Doctrine) and
 * `@Column` (TypeORM/MikroORM) annotations. Materialised by the writer and
 * ephemeral extractor as `DataStructure + DataField + HAS_FIELD` nodes
 * linked to the parent DataContainer via `linkDataContainerSchemas`.
 *
 * Enables column-level blast findings (`Column renamed: order_ref -> order_ref2`)
 * by giving the differ stable per-field URNs to diff against.
 */
export interface EntitySchemaDefinition {
    /** Table name (matches the parent DataContainer name). */
    name: string;
    fields: Array<{
        /** Column name (from the annotation `name=` / `name:`, or the property name when absent). */
        name: string;
        /** ORM type (e.g. `bigint`, `varchar`, `string`, `integer`). */
        type: string;
        /** `true` when the column is NOT NULL. Defaults to true when the annotation is absent. */
        required?: boolean;
    }>;
}

/**
 * Result of deterministic AST-based infrastructure extraction.
 * Mirrors the shape of UnifiedAnalysis so it can be used as a drop-in
 * replacement in the pipeline without any transformation.
 *
 * Defined here (not imported from unified-analyzer.ts) to avoid circular
 * dependencies between the language plugin layer and the AI agent layer.
 */
export interface StaticInfraResult {
    has_io: true;
    intent: string;
    infrastructure: StaticInfraRef[];
    capabilities: string[];
    emergent_api_calls: Array<{
        method: string;
        path: string;
        direction: 'INBOUND' | 'OUTBOUND';
        /** Framework that defines this route (e.g. 'nextjs-app-router', 'sveltekit'). */
        framework?: string;
    }>;
    /** ORM entity column schemas. Empty/omitted for non-entity chunks. */
    entity_schemas?: EntitySchemaDefinition[];
}
