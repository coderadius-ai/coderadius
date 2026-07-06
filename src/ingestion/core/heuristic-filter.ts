import type { CodeChunk } from '../../graph/types.js';
import type { FileTaintInfo } from './import-graph.js';
import { getLanguagePlugin } from './languages/registry.js';

// ─── Polyglot AST-Based Heuristic Pre-Filter ──────────────────────────────
//
// A zero-cost, structural pre-filter designed for TS, JS, PHP, Python, Go, and Rust.
// Looks for architectural signals — taint propagation, naming conventions,
// framework decorators, synthetic entrypoint chunks — to decide whether a
// chunk is worth a semantic (LLM) pass.
//
// Gate breakdown (evaluated in this order):
//   Gate 1: UseCase entrypoint — application-layer handle/execute/run methods.
//   Gate 2: Architectural convention — class-suffix + verb whitelist
//           (Repository/DAO/Store/Writer/Reader, Runner/Spawner/Executor/Scraper,
//            Emitter/Publisher/Producer/Dispatcher).
//   Gate 3: Synthetic entrypoints — consumer rescue, server actions, ORM
//           class metadata. Emitted by language plugins for AST-detected
//           framework signals that produced 0 regular chunks.
//   Gate 4: Tainted symbol detection — function references a symbol whose
//           import chain traces back to a known I/O sink.
//   Gate 5: DI alias detection — function body uses `this.xxx` where `xxx`
//           is bound to a tainted type or DI token.
//   Gate 6: Framework / Supplemental (catch-all) — labelled downstream in
//           static-analyzer-task-builder for AST-detected decorator
//           entrypoints and static-analyzer resolved-invocation rescues.

/**
 * Result of the heuristic filter, indicating not just pass/fail
 * but WHICH gate let the function through and WHY.
 *
 * Discriminated union: when `passed` is true, `gate` and `reason`
 * are guaranteed to exist. No `!` assertions needed downstream.
 */
export type FilterVerdict =
    | { passed: false }
    | { passed: true; gate: 1 | 2 | 3 | 4 | 5; reason: string };

/**
 * Pre-LLM I/O detection with Taint Analysis support.
 *
 * Applies Gate 1 (UseCase) → Gate 2 (Convention) → Gate 3 (Synthetic) →
 * Gate 4 (Taint Symbol) → Gate 5 (DI Alias).
 * Returns a FilterVerdict with detailed gate and reason information.
 */
export function likelyHasIOWithTaint(
    chunk: CodeChunk,
    taintInfo?: FileTaintInfo,
): FilterVerdict {
    // Gate 1: UseCase entrypoints in application layer
    if (isUseCaseEntrypoint(chunk)) {
        return { passed: true, gate: 1, reason: 'usecase:entry-point' };
    }

    // Gate 2: Repository / Runner / Publisher naming conventions
    if (isArchitecturalConventionMatch(chunk)) {
        return { passed: true, gate: 2, reason: 'convention:repository-method' };
    }

    // Gate 3: Synthetic entrypoints — chunks injected by language plugins for
    // AST-detected framework signals that produced 0 regular method chunks.
    if (chunk.name.includes('::__consumer_entrypoint') || chunk.name.includes('::__server_action')) {
        return { passed: true, gate: 3, reason: 'consumer-rescue:entrypoint' };
    }
    // ORM entity-mapping recognition is ecosystem grammar: the language
    // plugin owns it (PHP: Doctrine annotations/attributes, Eloquent).
    if (chunk.name.endsWith('::__class_metadata')
        && getLanguagePlugin(chunk.language)?.recognizesOrmMetadataChunk?.(chunk.sourceCode)) {
        return { passed: true, gate: 3, reason: 'synthetic-chunk:orm-metadata' };
    }

    // ── Polyglot Constructor Exclusion ──────────────────────────────
    // DI constructors across all supported languages are pure wiring:
    // they declare dependencies but never invoke them for I/O.
    //
    //   TS:     ClassName.constructor     → this.repo = repo (assignment only)
    //   PHP:    Ns\Class.__construct      → $this->repo = $repo
    //   Python: Class.__init__            → self.repo = repo
    //   Go:     N/A (factory funcs NewXxx can do real I/O, e.g. sql.Open())
    //
    // Gate 2 would match tainted parameter names in the constructor body,
    // but this is always a false positive — the constructor doesn't call
    // those services, it just stores references.
    //
    // Empirical: v01025 trace shows 117/117 TS constructors → no_io (100% waste).
    if (isDIConstructor(chunk.name)) {
        return { passed: false };
    }

    // If no taint data, fall through (backward compatible)
    if (!taintInfo) return { passed: false };

    const rawSrc = chunk.sourceCode;

    // Gate 4: Tainted symbol detection
    // Check if the function body references any tainted symbol name.
    // We use word-boundary matching to avoid false positives.
    for (const symbol of taintInfo.taintedSymbols) {
        // Skip generic symbols like '*' or 'default'
        if (symbol === '*' || symbol === 'default') continue;

        // Skip self-name matches: if the tainted symbol IS the function's
        // own name, it matches the declaration line, not actual usage of
        // a tainted dependency. This happens because import-graph.ts
        // adds all exported symbols from a tainted file as tainted.
        if (isSelfName(chunk.name, symbol)) continue;

        // Use a word-boundary regex to match the symbol in the source
        const symbolRegex = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
        if (symbolRegex.test(rawSrc)) {
            return { passed: true, gate: 4, reason: `tainted:${symbol}` };
        }
    }

    // Gate 5: DI alias detection
    // Check if the function body uses `this.xxx` or `this->xxx`
    // where the property is an alias for a tainted type.
    //
    // IMPORTANT: Strip comments first to avoid "comment poisoning" —
    // JSDoc/block comments that mention alias names (e.g. "doesn't use this.api")
    // would otherwise trigger false positives.
    const codeOnly = stripComments(rawSrc);
    for (const [aliasAccess] of taintInfo.taintedAliases) {
        // OPT-2: Skip observability aliases — they ARE technically I/O sinks
        // (write to files/stdout/metrics backends) but NEVER carry business
        // data relevant to architectural extraction.
        if (isObservabilityAlias(aliasAccess)) continue;

        if (codeOnly.includes(aliasAccess)) {
            return { passed: true, gate: 5, reason: `alias:${aliasAccess}` };
        }
    }

    return { passed: false };
}

/**
 * Check if a tainted symbol is the function's own name (self-reference).
 * Handles dotted names: "FulfillmentController.sync" → checks both "sync"
 * and "FulfillmentController" against the symbol.
 */
function isSelfName(chunkName: string, symbol: string): boolean {
    // Exact match
    if (chunkName === symbol) return true;
    // Dotted name: Class.method — check the method part and class part
    const dotIdx = chunkName.lastIndexOf('.');
    if (dotIdx !== -1) {
        const methodPart = chunkName.slice(dotIdx + 1);
        const classPart = chunkName.slice(0, dotIdx);
        if (methodPart === symbol || classPart === symbol) return true;
    }
    return false;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip comments from source code to prevent alias matches inside prose.
 * Handles: // line comments, /* block comments *‌/, # line comments (PHP/Python)
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' = 'code';

    while (i < src.length) {
        const ch = src[i]!;
        const next = src[i + 1];

        if (state === 'line-comment') {
            if (ch === '\n') {
                out += '\n';
                state = 'code';
            }
            i++;
            continue;
        }

        if (state === 'block-comment') {
            if (ch === '\n') out += '\n';
            if (ch === '*' && next === '/') {
                i += 2;
                state = 'code';
                continue;
            }
            i++;
            continue;
        }

        if (state === 'single' || state === 'double' || state === 'template') {
            out += ch;
            if (ch === '\\' && next) {
                out += next;
                i += 2;
                continue;
            }
            if (
                (state === 'single' && ch === '\'')
                || (state === 'double' && ch === '"')
                || (state === 'template' && ch === '`')
            ) {
                state = 'code';
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            state = 'line-comment';
            i += 2;
            continue;
        }

        if (ch === '/' && next === '*') {
            state = 'block-comment';
            i += 2;
            continue;
        }

        if (ch === '#' && next !== '[' && isHashCommentStart(src, i)) {
            state = 'line-comment';
            i++;
            continue;
        }

        if (ch === '\'') {
            state = 'single';
            out += ch;
            i++;
            continue;
        }

        if (ch === '"') {
            state = 'double';
            out += ch;
            i++;
            continue;
        }

        if (ch === '`') {
            state = 'template';
            out += ch;
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

function isHashCommentStart(src: string, index: number): boolean {
    if (index === 0) return true;

    for (let i = index - 1; i >= 0; i--) {
        const ch = src[i]!;
        if (ch === '\n' || ch === '\r') return true;
        if (!/\s/.test(ch)) return false;
    }

    return true;
}

function isUseCaseEntrypoint(chunk: CodeChunk): boolean {
    const filepath = chunk.filepath.replace(/\\/g, '/');
    const isApplicationFile = filepath.includes('/application/')
        || filepath.includes('/usecases/')
        || filepath.includes('/use-cases/')
        || /\.usecase\.[jt]sx?$/i.test(filepath);
    if (!isApplicationFile) return false;

    return /(?:^|\.)(handle|execute|run)$/.test(chunk.name);
}

function isArchitecturalConventionMatch(chunk: CodeChunk): boolean {
    const filepath = chunk.filepath.replace(/\\/g, '/');
    const basename = filepath.split('/').pop() ?? filepath;
    const stem = basename.replace(/\.[^.]+$/, '');
    const classPart = chunk.parentClassName
        ?? (chunk.name.includes('.') ? chunk.name.split('.')[0]! : chunk.name);
    const methodPart = chunk.name.includes('.') ? chunk.name.split('.').pop()! : chunk.name;
    const isRepositoryLikeFile = /(Repository|Repo|Dao|Store|Writer|Reader)$/i.test(stem)
        || /\.(repository|repo|dao|store)\.[jt]sx?$/i.test(basename)
        || filepath.includes('/repository/')
        || filepath.includes('/repositories/');
    const isRepositoryLikeClass = /(Repository|Repo|Dao|Store|Writer|Reader)$/i.test(classPart);
    // Process-runner convention: classes whose name ends in Runner/Spawner/
    // Executor/Scraper are wrappers around system process invocation
    // (exec/shell_exec/popen). They take spawn-like verbs.
    const isProcessRunnerClass = /(Runner|Spawner|Executor|Scraper)$/i.test(classPart);
    // Publisher convention: classes whose name ends in Emitter/Publisher/
    // Producer/Dispatcher push messages onto a broker. They take emit-like verbs.
    const isPublisherClass = /(Emitter|Publisher|Producer|Dispatcher)$/i.test(classPart);

    if (!(isRepositoryLikeFile || isRepositoryLikeClass || isProcessRunnerClass || isPublisherClass)) return false;

    // Anonymous arrow-functions or callbacks inside a Repository class cannot
    // match the verb whitelist (their chunk name is `with_A`, `callback@L:C`,
    // ...). Inherit the class signal: if the parent class is Repository-like,
    // the chunk is part of its data access surface.
    if (chunk.nameIsAmbiguous && chunk.parentClassName) {
        return true;
    }

    if (isProcessRunnerClass && PROCESS_RUNNER_VERB_REGEX.test(methodPart)) {
        return true;
    }

    if (isPublisherClass && PUBLISHER_VERB_REGEX.test(methodPart)) {
        return true;
    }

    return REPOSITORY_VERB_REGEX.test(methodPart);
}

/** Method verb whitelist for *Runner/*Spawner/*Executor/*Scraper classes. */
const PROCESS_RUNNER_VERB_REGEX = /^(spawn|exec|execute|run|invoke|launch|fork|start)\w*/i;

/** Method verb whitelist for *Emitter/*Publisher/*Producer/*Dispatcher classes. */
const PUBLISHER_VERB_REGEX = /^(emit|publish|produce|send|dispatch|enqueue|broadcast|notify)\w*/i;

/**
 * Architectural verb whitelist for Repository/DAO/Store classes. Grouped by
 * persistence concern. Extending this set is the canonical way to cover new
 * I/O patterns; adding regex elsewhere in Gate 1 is the wrong move.
 *
 * Categories:
 *   CRUD             find, get, create, update, delete, upsert, save, list, fetch, insert, remove, has, exists, count
 *   Lifecycle        persist, archive, flush, forget, clear, evict, put, invalidate
 *   SQL builder      join, union, aggregate, select, merge
 */
const REPOSITORY_VERB_REGEX = /^(find|get|create|update|delete|upsert|save|exists|count|list|fetch|insert|remove|has|set|put|clear|evict|flush|forget|invalidate|join|union|aggregate|select|merge|persist|archive)\w*/i;

/**
 * Polyglot check: is this chunk a DI constructor/init method?
 *
 * Matches:
 *   - TypeScript:  `SaveService.constructor`
 *   - PHP:         `App\Service\SaveService.__construct`
 *   - Python:      `SaveService.__init__`
 *
 * Does NOT match Go factory functions (e.g. `NewSaveService`) because
 * Go factories can perform real I/O (sql.Open(), redis.Dial(), etc.).
 *
 * Exported for testing.
 */
export function isDIConstructor(chunkName: string): boolean {
    return /(?:^|\.|\\)(constructor|__construct|__init__)$/.test(chunkName);
}

// ─── OPT-2: Observability Alias Blocklist ─────────────────────────────────
//
// Aliases for logging, tracing, and metrics services. These ARE technically
// I/O sinks (they write to files/stdout/metrics backends), but they NEVER
// carry business data relevant to architectural extraction.
//
// Polyglot: covers TS (this.xxx), PHP ($this->xxx), and Python (self.xxx).
//
// Empirical: on a large production monorepo, 31/34 Gate 3 rejections were
// `alias:this.logger` — saving ~282K wasted input tokens per ingestion.

const OBSERVABILITY_ALIAS_SUFFIXES = new Set([
    'logger', 'log', 'tracer', 'metrics', 'monitor',
    'sentry', 'bugsnag', 'newrelic', 'datadog',
    'statsClient', 'statsd',
]);

/**
 * Returns true if the alias access pattern refers to an observability concern
 * (logging, tracing, metrics) that should be excluded from Gate 3 taint matching.
 *
 * Handles:
 *   - TypeScript:  this.logger, this.log, this.tracer
 *   - PHP:         $this->logger, $this->log
 *   - Python:      self.logger, self.log
 */
function isObservabilityAlias(aliasAccess: string): boolean {
    // Extract the property name from the access pattern
    // this.logger → logger | $this->logger → logger | self.logger → logger
    const match = aliasAccess.match(/(?:this\.|\$this->|self\.)(\w+)$/);
    if (!match) return false;
    return OBSERVABILITY_ALIAS_SUFFIXES.has(match[1]!);
}

