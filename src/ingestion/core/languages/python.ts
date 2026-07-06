import Parser from 'tree-sitter';
import pythonLang from 'tree-sitter-python';
import path from 'node:path';
import { patchLanguage } from '../../processors/parser/jsc-compat.js';
import type { CodeChunk } from '../../../graph/types.js';
import type { ImportRef, ClassPropertyAlias } from '../import-graph.js';
import type { LanguagePlugin, ImportContext } from './types.js';
import { findNodeSpanning, walkForServiceCalls } from '../ast-service-call-detector.js';
import {
    extractPythonCriticalInvocations,
    extractPythonValueFacts,
} from '../value-resolution/extractors.js';

const PY_CALL_TYPES = new Set(['call']);

export class PythonPlugin implements LanguagePlugin {
    readonly language = 'python';
    readonly ecosystem = 'pypi';
    readonly extensions = ['.py'] as const;

    /**
     * Reduce a Python module path to its top-level distribution name.
     * Examples:
     *   'requests'                  → 'requests'
     *   'pymongo.collection'        → 'pymongo'
     *   'google.cloud.storage'      → 'google.cloud.storage' (namespaced distribution)
     */
    normalizePackageName(rawImport: string): string {
        if (!rawImport) return rawImport;
        if (rawImport.startsWith('.')) return rawImport;
        if (
            rawImport.startsWith('google.cloud.') ||
            rawImport.startsWith('azure.') ||
            rawImport.startsWith('opentelemetry.')
        ) {
            const parts = rawImport.split('.');
            return parts.slice(0, 3).join('.');
        }
        const dot = rawImport.indexOf('.');
        return dot === -1 ? rawImport : rawImport.slice(0, dot);
    }
    readonly scopeExclusions = [
        // ── Bytecode / compiled artefacts ───────────────────────────────────
        '*.py[cod]',
        '__pycache__/**',
        // ── Virtual environments ────────────────────────────────────────────
        '.venv/**', 'venv/**', '.env/**', 'env/**',
        '**/.venv/**', '**/venv/**', '**/site-packages/**',
        // ── Generated protobuf / grpc ───────────────────────────────────────
        '*_pb2.py', '*_pb2_grpc.py', '*_pb2.pyi',
        // ── pytest / unittest conventions (file-level) ──────────────────────
        'test_*.py', '*_test.py', 'conftest.py',
        '**/tests/**',
        // ── Type / lint / test framework caches ─────────────────────────────
        '**/.pytest_cache/**', '**/.mypy_cache/**', '**/.ruff_cache/**',
        '**/.pytype/**', '**/.tox/**', '**/.nox/**',
        // ── Coverage ────────────────────────────────────────────────────────
        '**/htmlcov/**', '.coverage', '.coverage.*',
        // ── Packaging artefacts ─────────────────────────────────────────────
        '**/*.egg-info/**', '**/*.egg/**', '**/*.dist-info/**',
        '**/build/lib/**', '**/dist/**',
        // ── Documentation builds (Sphinx / MkDocs) ──────────────────────────
        '**/docs/_build/**', '**/site/**',
        // ── Database migration files (Alembic + Django) ────────────────────
        // Schema-only; LLM extraction yields nothing the sanitizer keeps.
        // Pattern-anchored to standard layouts (Alembic `alembic/versions/`,
        // Django `<app>/migrations/NNNN_*.py`) so service folders named
        // `migration-something` are not over-matched.
        '**/alembic/versions/*.py',
        '**/migrations/[0-9][0-9][0-9][0-9]_*.py',
    ] as const;
    readonly manifestFiles = [
        { file: 'pyproject.toml', language: 'python' },
        { file: 'requirements.txt', language: 'python' },
    ] as const;
    readonly ignorePatterns = [
        '**/__pycache__/**',
        '**/.venv/**',
        '**/venv/**',
    ] as const;

    readonly runtimeServiceSignals = {
        entrypoints: [
            {
                files: [
                    'manage.py', 'wsgi.py', 'asgi.py', 'app.py', 'main.py',
                    'src/main.py', 'src/app.py',
                ],
                patterns: [
                    /\bDJANGO_SETTINGS_MODULE\b/,
                    /\bFastAPI\(/,
                    /\bFlask\(/,
                    /\buvicorn\.run\(/,
                    /\bdjango\.core\./,
                    /\bgunicorn\b/,
                    /\bstarlette\b/,
                ],
            },
        ],
    } as const;

    readonly frameworkRoleSignals = {
        'graphql-server': {
            entrypoints: [
                {
                    files: [
                        'main.py', 'app.py', 'asgi.py', 'wsgi.py',
                        'src/main.py', 'src/app.py',
                    ],
                    patterns: [
                        /\bstrawberry\.fastapi\.GraphQLRouter\b/,
                        /\bstrawberry\.asgi\.GraphQL\b/,
                        /\bGraphQLRouter\(/,
                        /\bariadne\.asgi\.GraphQL\b/,
                        /\bariadne\.wsgi\.GraphQL\b/,
                        /\bGraphQLApp\(/,
                    ],
                },
            ],
        },
    } as const;

    private parserInstance: Parser | null = null;

    promptHints(): string {
        return `<python_rules>
ASYNC I/O:
- \`await\` alone does not mean I/O — it may just yield to the event loop. Only flag has_io=true if the awaited call communicates with an external system.
- \`asyncio.sleep()\` is NOT I/O — it is a timing delay. Set has_io=false for functions that only sleep or yield.

DJANGO / SQLAlchemy ORM:
- \`Model.objects.filter()\`, \`.create()\`, \`.save()\`, \`.delete()\` are Database operations. Use the Django model class name (e.g. 'Order') lowercased as the table name.
- \`db.session.add()\`, \`db.session.commit()\`, \`db.session.query(Model)\` are SQLAlchemy Database operations.

CELERY / TASK QUEUES:
- \`task.delay()\`, \`task.apply_async()\`, \`send_task()\` publish to a MessageChannel. Use the task name (e.g. 'send_email') as the logical resource name.
- Functions decorated with \`@app.task\`, \`@shared_task\`, \`@celery.task\` are queue consumers.

LOGGING — NOT infrastructure:
- \`logging.info()\`, \`logging.error()\`, \`print()\`, \`sys.stdout.write()\` are NOT infrastructure. Do NOT emit any infrastructure node for them.

HTTP CLIENTS:
- \`requests.get/post\`, \`httpx.get/post\`, \`aiohttp.ClientSession\` are ExternalAPI calls.
- \`urllib.request.urlopen()\` is also an ExternalAPI call.
</python_rules>`;
    }

    createParser(): Parser {
        if (!this.parserInstance) {
            this.parserInstance = new Parser();
            this.parserInstance.setLanguage(patchLanguage(pythonLang));
        }
        return this.parserInstance;
    }

    extractFunctions(tree: Parser.Tree, _source: string, filepath: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const FUNCTION_TYPES = new Set(['function_definition']);

        const walk = (node: Parser.SyntaxNode, parentName?: string) => {
            if (FUNCTION_TYPES.has(node.type)) {
                let name = 'anonymous';
                const nameNode = node.childForFieldName('name');
                if (nameNode) name = nameNode.text;
                if (parentName) name = `${parentName}.${name}`;

                let sourceCode = node.text;
                const comments = extractPrecedingComments(node);
                if (comments) sourceCode = comments + sourceCode;

                const envVars = this.extractEnvVars(node);
                chunks.push({
                    name, filepath, sourceCode, language: 'python',
                    startLine: node.startPosition.row + 1,
                    startColumn: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                    endColumn: node.endPosition.column + 1,
                    ...(envVars.length > 0 && { envVars }),
                });
            }

            let className: string | undefined;
            if (node.type === 'class_definition') {
                const classNameNode = node.childForFieldName('name');
                if (classNameNode) className = classNameNode.text;
            }
            for (const child of node.children) walk(child, className ?? parentName);
        };

        walk(tree.rootNode);
        return chunks;
    }

    /**
     * PyPI-ecosystem broker SDK markers → technology (first match wins).
     * Consumed by the sanitizer's technology inference.
     */
    inferBrokerTechnology(sourceCode: string): string | undefined {
        if (/confluent|kafka-python/i.test(sourceCode)) return 'kafka';
        if (/boto3.*sqs/i.test(sourceCode)) return 'sqs';
        if (/boto3.*sns/i.test(sourceCode)) return 'sns';
        if (/nats/i.test(sourceCode)) return 'nats';
        return undefined;
    }

    extractEnvVars(node: Parser.SyntaxNode): string[] {
        const names = new Set<string>();
        const walk = (n: Parser.SyntaxNode): void => {
            if (n.type === 'subscript' || n.type === 'call') {
                const src = n.text;
                const environMatch = src.match(/os\.environ\[['"]([A-Z0-9_]+)['"]\]/);
                if (environMatch) names.add(environMatch[1]);
                const getenvMatch = src.match(/os\.(?:environ\.get|getenv)\(['"]([A-Z0-9_]+)['"]/);
                if (getenvMatch) names.add(getenvMatch[1]);
            }
            for (const child of n.children) walk(child);
        };
        walk(node);
        return [...names];
    }

    extractValueFacts(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractPythonValueFacts(rootNode, source, filepath);
    }

    extractCriticalInvocations(rootNode: Parser.SyntaxNode, source: string, filepath: string) {
        return extractPythonCriticalInvocations(rootNode, source, filepath);
    }

    extractImports(rootNode: Parser.SyntaxNode, context: ImportContext): ImportRef[] {
        const imports: ImportRef[] = [];
        for (const line of rootNode.text.split('\n')) {
            const fromMatch = line.match(/^\s*from\s+([A-Za-z0-9_.$]+)\s+import\s+(.+)$/);
            if (fromMatch) {
                const resolved = resolvePythonModule(fromMatch[1], context);
                const specifierBindings: ImportRef['specifierBindings'] = [];
                const specifiers: string[] = [];
                for (const raw of fromMatch[2].split(',')) {
                    const spec = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*|\*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/);
                    if (!spec) continue;
                    const imported = spec[1];
                    const local = spec[2] ?? imported;
                    specifiers.push(imported);
                    specifierBindings.push({ imported, local, kind: imported === '*' ? 'namespace' : 'named' });
                }
                imports.push({
                    source: resolved.source,
                    specifiers: specifiers.length > 0 ? specifiers : ['*'],
                    isExternal: !resolved.local,
                    ...(specifierBindings.length > 0 ? { specifierBindings } : {}),
                });
                continue;
            }

            const importMatch = line.match(/^\s*import\s+(.+)$/);
            if (importMatch) {
                for (const raw of importMatch[1].split(',')) {
                    const spec = raw.trim().match(/^([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/);
                    if (!spec) continue;
                    const resolved = resolvePythonModule(spec[1], context);
                    const local = spec[2] ?? spec[1].split('.').pop()!;
                    imports.push({
                        source: resolved.source,
                        specifiers: ['*'],
                        isExternal: !resolved.local,
                        specifierBindings: [{ imported: '*', local, kind: 'namespace' }],
                    });
                }
            }
        }
        return imports;
    }

    extractExports(rootNode: Parser.SyntaxNode): string[] {
        const exports = new Set<string>();
        for (const line of rootNode.text.split('\n')) {
            const match = line.match(/^(?:class|def)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
                ?? line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            if (match) exports.add(match[1]);
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

    // ─── INBOUND Path Validation ──────────────────────────────────────────────

    /**
     * Python-specific INBOUND path evidence check.
     *
     * Python is the only supported language where routes may NOT have a leading
     * slash. Django's standard is path('calculate/', view) — no leading slash.
     * Flask/FastAPI use '@app.route("/calculate")' — WITH leading slash.
     *
     * Both patterns are valid. The leading slash is optional in Pass 2.
     * Safety comes from:
     *   - Django: trailing slash ('calculate/') makes segment+slash distinctive
     *   - Flask/FastAPI: leading slash is present as in other frameworks
     *   - promptHints(): blocks hallucination of paths upstream at LLM level
     *
     * `length > 0` removes the arbitrary >= 4 cut-off that would drop short
     * but real routes like /faq, /buy, /pay.
     */
    validateInboundPath(path: string, sourceCode: string): boolean | undefined {
        const Q = "['\"]";
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Pass 1: full path literal — '/api/calculate' or 'api/calculate/'
        if (new RegExp(Q + escaped + Q).test(sourceCode)) return true;

        // Pass 2: last non-param segment.
        // Leading slash is OPTIONAL — Django uses 'calculate/' (no leading slash),
        // Flask/FastAPI use '/calculate' (with leading slash). Match both.
        const segments = path.split('/').filter(s => s.length > 0 && !s.startsWith('{') && !s.startsWith('<'));
        if (segments.length > 0) {
            const last = segments[segments.length - 1];
            const segEscaped = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Lookahead: segment terminated by quote, slash, or param opener ({ : <)
            // Leading slash is OPTIONAL (Django has none), but boundary must be clean.
            if (new RegExp(Q + '/?' + segEscaped + "(?=[/\"':{<])").test(sourceCode)) return true;
        }

        return false;
    }

    hasServiceCallsInRange(rootNode: Parser.SyntaxNode, startLine: number, endLine: number): boolean | undefined {
        const funcNode = findNodeSpanning(rootNode, startLine, endLine);
        if (!funcNode) return undefined;

        // Python tree-sitter uses 'call' (not 'call_expression') and
        // 'attribute' (not 'member_expression') for method access:
        //   self.repo.find() → call { function: attribute { object: attribute } }
        return walkForServiceCalls(funcNode, PY_CALL_TYPES, (callNode) => {
            const callee = callNode.childForFieldName('function');
            return callee?.type === 'attribute';
        });
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

function resolvePythonModule(moduleName: string, context: ImportContext): { source: string; local: boolean } {
    const currentDir = path.posix.dirname(context.filePath);
    const trimmed = moduleName.replace(/^\.+/, '');
    const relativePrefix = moduleName.startsWith('.') ? currentDir : '';
    const modulePath = trimmed.replace(/\./g, '/');
    const base = path.posix.normalize(path.posix.join(relativePrefix, modulePath));
    const candidates = [
        `${base}.py`,
        `${base}/__init__.py`,
        base,
    ];

    for (const candidate of candidates) {
        if (context.allFilePaths.has(candidate)) return { source: candidate, local: true };
    }

    for (const file of context.allFilePaths) {
        if (file.endsWith(`/${modulePath}.py`) || file.endsWith(`/${modulePath}/__init__.py`)) {
            return { source: file, local: true };
        }
    }

    return { source: moduleName, local: false };
}
