import Parser from 'tree-sitter';
import goLang from 'tree-sitter-go';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import type { CodeChunk } from '../../../graph/types.js';
import type { ImportRef, ClassPropertyAlias } from '../import-graph.js';
import type { LanguagePlugin, ImportContext, PackageDependency } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { logger } from '../../../utils/logger.js';
import { findNodeSpanning, walkForServiceCalls } from '../ast-service-call-detector.js';
import {
    extractGoCriticalInvocations,
    extractGoValueFacts,
} from '../value-resolution/extractors.js';

const GO_CALL_TYPES = new Set(['call_expression']);

export class GoPlugin implements LanguagePlugin {
    readonly language = 'go';
    readonly ecosystem = 'go';
    readonly extensions = ['.go'] as const;

    /**
     * Go uses full module paths as imports. Reduce to the canonical module
     * root (host + owner + repo or first 3 path segments) — sub-packages of
     * the same module classify identically.
     *
     * Examples:
     *   'github.com/lib/pq'                     → 'github.com/lib/pq'
     *   'github.com/aws/aws-sdk-go-v2/service/s3' → 'github.com/aws/aws-sdk-go-v2'
     *   'go.mongodb.org/mongo-driver'           → 'go.mongodb.org/mongo-driver'
     *   'cloud.google.com/go/pubsub'            → 'cloud.google.com/go'
     */
    normalizePackageName(rawImport: string): string {
        if (!rawImport) return rawImport;
        const parts = rawImport.split('/');
        if (parts.length <= 3) return rawImport;
        // Detect aws-sdk-go-v2 sub-modules (contain "aws-sdk-go" or follow vN suffix)
        if (rawImport.startsWith('github.com/aws/aws-sdk-go-v2/')) {
            return 'github.com/aws/aws-sdk-go-v2';
        }
        // Default: first 3 segments form the module root
        return parts.slice(0, 3).join('/');
    }
    readonly scopeExclusions = [
        // ── Vendored dependencies ───────────────────────────────────────────
        'vendor/**', '**/vendor/**',
        // ── Tests / mocks (file- and dir-level) ─────────────────────────────
        '*_test.go',
        'mocks/**', '**/mocks/**',
        '**/testdata/**',
        // ── Protobuf / gRPC / gateway / OpenAPI generated ───────────────────
        '*.pb.go', '*_grpc.pb.go', '*.pb.gw.go', '*.swagger.go',
        // ── Build / binary output ───────────────────────────────────────────
        'bin/**', '**/bin/**', '**/_build/**',
        // ── Coverage / profile artefacts ────────────────────────────────────
        '*.test', 'coverage.out', '*.coverprofile',
        // ── Database migration files (golang-migrate + generic) ────────────
        // Schema-only; LLM extraction yields no business signal. Anchored to
        // `migrations/` and `db/migrations/` so a `migration-service/`
        // directory keeps being analysed.
        '**/migrations/*.up.sql', '**/migrations/*.down.sql',
        '**/migrations/*.up.go', '**/migrations/*.down.go',
        '**/db/migrations/*.go', '**/db/migrations/*.sql',
    ] as const;
    readonly manifestFiles = [
        { file: 'go.mod', language: 'go' },
    ] as const;
    readonly ignorePatterns = [
        '**/vendor/**',
    ] as const;

    readonly runtimeServiceSignals = {
        entrypoints: [
            {
                files: [
                    'main.go',
                    'cmd/*/main.go',
                    'cmd/main.go',
                ],
                patterns: [
                    /\bhttp\.ListenAndServe\(/,
                    /\bhttp\.Server\{/,
                    /\bgin\.Default\(/,
                    /\bgin\.New\(/,
                    /\bfiber\.New\(/,
                    /\bhandler\.NewDefaultServer\(/,
                    /\bgrpc\.NewServer\(/,
                ],
            },
        ],
    } as const;

    readonly frameworkRoleSignals = {
        'graphql-server': {
            entrypoints: [
                {
                    files: [
                        'main.go',
                        'cmd/*/main.go',
                        'cmd/main.go',
                        'server.go',
                        'internal/server/server.go',
                    ],
                    patterns: [
                        /\bhandler\.NewDefaultServer\(/,        // gqlgen
                        /\bgraphql-go\/handler\b/,              // graphql-go
                        /\bgraphql\.NewSchema\(/,
                    ],
                },
            ],
        },
    } as const;

    private parserInstance: Parser | null = null;

    promptHints(): string {
        return `<go_rules>
GOROUTINES AND CHANNELS:
- \`go func()\` launches a goroutine — it is NOT process spawn infrastructure. It is concurrent execution within the same process.
- Channel operations (\`ch <- value\`, \`<-ch\`) are in-process communication. Only flag as I/O if the channel bridges to an external system (e.g. via a goroutine that writes to Kafka).

CONTEXT:
- \`context.Context\` propagation (\`ctx.Done()\`, \`ctx.Err()\`, \`context.WithTimeout\`) is concurrency control, NOT I/O.
- Only flag has_io=true if the function uses the context to call an external system (e.g. \`db.QueryContext(ctx, ...)\`, \`client.Do(req.WithContext(ctx))\`).

I/O PACKAGES:
- \`database/sql\`: \`db.Query()\`, \`db.Exec()\`, \`db.QueryRow()\` → Database. Extract table name from the SQL string.
- \`net/http\`: \`http.Get()\`, \`client.Do()\`, handler funcs (\`func(w http.ResponseWriter, r *http.Request)\`) → ExternalAPI or HTTP handler.
- \`os.Open()\`, \`ioutil.ReadFile()\`, \`os.WriteFile()\` → Process (file system).
- \`log.Printf()\`, \`log.Fatal()\`, \`fmt.Println()\` → NOT infrastructure. Do NOT emit any node.

GRPC:
- Methods on a generated gRPC client (e.g. \`client.CreateOrder(ctx, req)\`) → ExternalAPI. Use the RPC method name as the logical name.
- Methods on a gRPC server implementation struct → these are API endpoint handlers. Extract them as emergent_api_calls.

GORM / SQLX:
- \`db.Where().Find(&result)\`, \`db.Create(&model)\`, \`sqlx.Select(&dest, query)\` → Database. Use the Go struct name as the table identifier.
</go_rules>`;
    }

    createParser(): Parser {
        if (!this.parserInstance) {
            this.parserInstance = new Parser();
            this.parserInstance.setLanguage(patchLanguage(goLang));
        }
        return this.parserInstance;
    }

    extractFunctions(tree: Parser.Tree, _source: string, filepath: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const FUNCTION_TYPES = new Set(['function_declaration', 'method_declaration']);

        const walk = (node: Parser.SyntaxNode) => {
            if (FUNCTION_TYPES.has(node.type)) {
                let name = 'anonymous';
                const nameNode = node.childForFieldName('name');
                if (nameNode) name = nameNode.text;

                // Prefix with receiver type for methods: func (s *Server) Handle() → Server.Handle
                if (node.type === 'method_declaration') {
                    const receiver = node.childForFieldName('receiver');
                    if (receiver) {
                        const typeNode = receiver.descendantsOfType('type_identifier')[0];
                        if (typeNode) name = `${typeNode.text}.${name}`;
                    }
                }

                let sourceCode = node.text;
                const comments = extractPrecedingComments(node);
                if (comments) sourceCode = comments + sourceCode;

                const envVars = this.extractEnvVars(node);
                chunks.push({
                    name, filepath, sourceCode, language: 'go',
                    startLine: node.startPosition.row + 1,
                    startColumn: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                    endColumn: node.endPosition.column + 1,
                    ...(envVars.length > 0 && { envVars }),
                });
            }
            for (const child of node.children) walk(child);
        };

        walk(tree.rootNode);
        return chunks;
    }

    /**
     * Go-ecosystem broker SDK markers → technology (first match wins).
     * Consumed by the sanitizer's technology inference.
     */
    inferBrokerTechnology(sourceCode: string): string | undefined {
        if (/confluent|segmentio\/kafka-go/i.test(sourceCode)) return 'kafka';
        if (/nats/i.test(sourceCode)) return 'nats';
        return undefined;
    }

    extractEnvVars(node: Parser.SyntaxNode): string[] {
        const names = new Set<string>();
        const walk = (n: Parser.SyntaxNode): void => {
            if (n.type === 'call_expression') {
                const match = n.text.match(/os\.(?:Getenv|LookupEnv)\("([A-Z0-9_]+)"\)/);
                if (match) names.add(match[1]);
            }
            for (const child of n.children) walk(child);
        };
        walk(node);
        return [...names];
    }

    extractValueFacts(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractGoValueFacts(rootNode, source, filepath);
    }

    extractCriticalInvocations(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractGoCriticalInvocations(rootNode, source, filepath);
    }

    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
        const imports: ImportRef[] = [];
        const source = rootNode.text;
        const importRegex = /import\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"|import\s*\(([\s\S]*?)\)/g;
        for (const match of source.matchAll(importRegex)) {
            if (match[3]) {
                for (const line of match[3].split('\n')) {
                    const item = line.trim().match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
                    if (!item) continue;
                    imports.push(goImportRef(item[2], item[1], context));
                }
                continue;
            }
            if (match[2]) imports.push(goImportRef(match[2], match[1], context));
        }
        return imports;
    }

    extractExports(rootNode: Parser.SyntaxNode): string[] {
        const exports = new Set<string>();
        for (const match of rootNode.text.matchAll(/\b(?:func|type|const|var)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
            exports.add(match[1]);
        }
        return [...exports];
    }

    extractClassPropertyAliases(_rootNode: Parser.SyntaxNode): ClassPropertyAlias[] {
        return [];
    }

    extractImportStatements(_rootNode: Parser.SyntaxNode): string[] {
        return [];
    }

    extractConstructorSources(_rootNode: Parser.SyntaxNode): Map<string, string> {
        return new Map();
    }

    // ─── Dependency Extraction ───────────────────────────────────────────────

    async extractDependencies(repoPath: string): Promise<PackageDependency[]> {
        const results: PackageDependency[] = [];

        const goMods = await glob('**/go.mod', {
            cwd: repoPath, absolute: true, ignore: ['**/vendor/**'],
        });

        for (const goModPath of goMods) {
            try {
                const dir = path.dirname(goModPath);
                const content = fs.readFileSync(goModPath, 'utf8');

                const dependencies = new Map<string, string>();

                const goModRegex = /require\s*\(\s*([\s\S]*?)\s*\)/g;
                let match;
                while ((match = goModRegex.exec(content)) !== null) {
                    const lines = match[1].split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2 && !parts[0].startsWith('//')) {
                            dependencies.set(parts[0], parts[1]);
                        }
                    }
                }

                const singleReqRegex = /^require\s+([^\s]+)\s+([^\s]+)/gm;
                while ((match = singleReqRegex.exec(content)) !== null) {
                    dependencies.set(match[1], match[2]);
                }

                const lockfileMap = new Map<string, string>();
                const goSumPath = path.join(dir, 'go.sum');
                if (fs.existsSync(goSumPath)) {
                    parseGoSum(goSumPath, lockfileMap);
                }

                for (const [name, declaredRange] of dependencies.entries()) {
                    results.push({
                        name, ecosystem: 'go', declaredRange,
                        lockedVersion: lockfileMap.get(name) || null,
                        isDev: false,
                    });
                }
            } catch (e) {
                logger.debug(`(lockfile) Failed to parse go.mod at ${goModPath}: ${(e as Error).message}`);
            }
        }

        return results;
    }

    // ─── INBOUND Path Validation ──────────────────────────────────────────────

    /**
     * Go-specific INBOUND path evidence check.
     *
     * Go HTTP routers (Gin, Echo, gorilla/mux, chi, http.HandleFunc) ALWAYS
     * register routes with a leading slash: `r.GET("/pay", handler)`.
     * Same logic as PHP — leading slash required in Pass 2, length > 0 is safe.
     */
    validateInboundPath(path: string, sourceCode: string): boolean | undefined {
        const Q = "['\"]";
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Pass 1: full path literal present — "/api/v1/records/archive"
        if (new RegExp(Q + escaped + Q).test(sourceCode)) return true;

        // Pass 2: last non-param segment with required leading slash.
        // Go routers always have the slash: r.GET("/pay", ...) → "/pay"
        const segments = path.split('/').filter(s => s.length > 0 && !s.startsWith('{') && !s.startsWith(':'));
        if (segments.length > 0) {
            const last = segments[segments.length - 1];
            const segEscaped = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Lookahead: segment must be terminated by end-of-string quote, slash, or param
            // opener (: for /users/:id, { for /users/{id}). Prevents /pay_attention matching /pay.
            if (new RegExp(Q + '/' + segEscaped + "(?=[/\"':{<])").test(sourceCode)) return true;
        }

        return false;
    }

    hasServiceCallsInRange(rootNode: Parser.SyntaxNode, startLine: number, endLine: number): boolean | undefined {
        const funcNode = findNodeSpanning(rootNode, startLine, endLine);
        if (!funcNode) return undefined;

        return walkForServiceCalls(funcNode, GO_CALL_TYPES, (callNode) => {
            const callee = callNode.childForFieldName('function');
            // Go method calls use selector_expression: s.repo.Find(), http.Get()
            return callee?.type === 'selector_expression';
        });
    }
}

// ─── Lockfile Parsers ──────────────────────────────────────────────────────────

function goImportRef(importPath: string, alias: string | undefined, context: ImportContext): ImportRef {
    const resolved = resolveGoImport(importPath, context);
    const local = alias ?? importPath.split('/').pop() ?? importPath;
    return {
        source: resolved.source,
        specifiers: ['*'],
        isExternal: !resolved.local,
        specifierBindings: [{ imported: '*', local, kind: 'namespace' }],
    };
}

function resolveGoImport(importPath: string, context: ImportContext): { source: string; local: boolean } {
    const suffix = importPath.split('/').pop();
    if (!suffix) return { source: importPath, local: false };

    for (const file of context.allFilePaths) {
        const dir = path.posix.basename(path.posix.dirname(file));
        const base = path.posix.basename(file, '.go');
        if (file.endsWith('.go') && (dir === suffix || base === suffix)) {
            return { source: file, local: true };
        }
    }

    return { source: importPath, local: false };
}

function parseGoSum(sumPath: string, map: Map<string, string>): void {
    try {
        const content = fs.readFileSync(sumPath, 'utf8');
        for (const line of content.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const version = parts[1].replace(/\/go\.mod$/, '');
                map.set(parts[0], version);
            }
        }
    } catch (e) {
        logger.debug(`(lockfile) Failed to parse go.sum at ${sumPath}: ${(e as Error).message}`);
    }
}

function extractPrecedingComments(node: Parser.SyntaxNode): string {
    let comments = '';
    let curr = node.previousSibling;
    while (curr && (curr.type === 'comment' || curr.type === 'line_comment' || curr.type === 'block_comment')) {
        comments = curr.text + '\n' + comments;
        curr = curr.previousSibling;
    }
    return comments;
}
