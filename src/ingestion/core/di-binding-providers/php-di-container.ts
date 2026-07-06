// ═══════════════════════════════════════════════════════════════════════════════
// PhpDiContainerProvider — PHP-DI container builder (php-di/php-di)
//
// Real-world target: `containerBuilder.php` files declaring service factories
// via `$containerBuilder->addDefinitions([Class => closure])`. Used by
// non-Symfony PHP apps (Slim, custom monoliths like acme-monolith). Distinct
// from SymfonyServicesPhpProvider which targets the Configurator API.
//
// Canonical shape:
//   $containerBuilder->addDefinitions([
//       \Foo::class => static function (ContainerInterface $c): Foo {
//           return new Foo($c->get(\Bar::class));
//       },
//       \BazInterface::class => static function ($c) {
//           return $c->get(\ConcreteBaz::class);   // alias chain
//       },
//   ]);
//
// We extract two binding shapes from each entry:
//   - direct: `return new ConcreteX(...)`               → Key → ConcreteX
//   - alias:  `return $c->get(\ConcreteX::class)`       → Key → ConcreteX
//
// Out of scope (resolver falls back to LLM):
//   - Conditional returns (`if ($cond) return new A(); else return new B();`)
//   - Returns that call methods on `$container->get(...)`-derived values
//   - DI\autowire() / DI\create() helpers (no `new` literal)
//   - Closures with side effects unrelated to the return value
// ═══════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import type {
    DiBindingProvider,
    DiBindingProviderContext,
    RawDiBinding,
} from './types.js';

const MAX_BINDINGS_PER_FILE = 500;

// PHP namespace + use parsing (mirror SymfonyServicesPhpProvider).
const NAMESPACE_DECL = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*;/m;
const USE_DECL = /^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/gm;

// File-level signals.
const ADD_DEFINITIONS_HINT = /->\s*addDefinitions\s*\(\s*\[/;
const PHP_DI_IMPORT = /(?:use\s+DI\\|new\s+\\?DI\\ContainerBuilder|DI\\ContainerBuilder)/;
const USE_AUTOWIRING_HINT = /->\s*useAutowiring\s*\(\s*true\s*\)/;

// Entry head: a definition key followed by `=> [static] function (`. The key is
// EITHER a `::class` FQCN (group 1) OR a quoted STRING service id (group 2, e.g.
// `'notpurchasable.publisher'`). Disambiguate by which group fired — a dotted
// string key is NOT a class and must NOT be FQCN-resolved.
const ENTRY_HEAD = /(?:\\?([A-Z][A-Za-z0-9_\\]*)\s*::\s*class|['"]([^'"\\]+)['"])\s*=>\s*(?:static\s+)?function\s*\(/g;

// Cap the positional-arg walk per entry to bound pathological arg lists
// (independent of MAX_BINDINGS_PER_FILE, which caps entries).
const MAX_CTOR_SCALARS = 32;

interface PhpImportScope {
    namespace: string;
    aliases: Map<string, string>; // local name -> FQCN
}

function parseImportScope(content: string): PhpImportScope {
    const nsMatch = content.match(NAMESPACE_DECL);
    const namespace = nsMatch ? nsMatch[1].trim() : '';
    const aliases = new Map<string, string>();
    USE_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USE_DECL.exec(content)) !== null) {
        const full = m[1].replace(/^\\+/, '');
        const local = m[2] ?? full.slice(full.lastIndexOf('\\') + 1);
        if (local) aliases.set(local, full);
    }
    return { namespace, aliases };
}

function resolvePhpClassName(name: string, scope: PhpImportScope): string {
    const cleaned = name.replace(/^\\+/, '');
    if (cleaned.includes('\\')) {
        const head = cleaned.split('\\')[0];
        const aliasResolved = scope.aliases.get(head);
        if (aliasResolved) return aliasResolved + cleaned.slice(head.length);
        return cleaned;
    }
    if (scope.aliases.has(cleaned)) return scope.aliases.get(cleaned)!;
    return scope.namespace ? `${scope.namespace}\\${cleaned}` : cleaned;
}

export class PhpDiContainerProvider implements DiBindingProvider {
    readonly id = 'php-di-container';

    readonly contentSignatures = [
        /->\s*addDefinitions\s*\(/,
        /DI\\ContainerBuilder/,
    ];

    matchFile(relativePath: string, basename: string): boolean {
        if (!/\.php$/i.test(basename)) return false;
        const lower = basename.toLowerCase();
        const rel = relativePath.toLowerCase();
        // Conventional PHP-DI bootstrap filenames
        if (lower === 'containerbuilder.php') return true;
        if (lower === 'container.php') return true;
        if (lower === 'dependencies.php') return true;
        // Any .php file under config/ — content gate filters non-DI ones
        if (/^(.*\/)?config\/[^/]+\.php$/.test(rel)) return true;
        return false;
    }

    extractDiBindings(content: string, ctx: DiBindingProviderContext): RawDiBinding[] {
        // Cheap content-shape check up front (the collector also gates via
        // contentSignatures but we double-guard here for parser robustness).
        if (!ADD_DEFINITIONS_HINT.test(content) && !PHP_DI_IMPORT.test(content)) {
            return [];
        }

        const out: RawDiBinding[] = [];
        const sourceHash = stableHash(content);
        const importScope = parseImportScope(content);
        const autowireEnabled = USE_AUTOWIRING_HINT.test(content);

        ENTRY_HEAD.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ENTRY_HEAD.exec(content)) !== null) {
            if (out.length >= MAX_BINDINGS_PER_FILE) break;
            const classKey = m[1];
            const stringKey = m[2];
            const headEnd = ENTRY_HEAD.lastIndex;

            // Find the closure body braces. headEnd is right after the `(`
            // of `function (`. We scan forward to the matching `)`, then
            // expect `:?(\s+ReturnType)?\s*{`. Walk to the matching `}` to
            // get the body slice.
            const closureBody = extractClosureBody(content, headEnd);
            if (!closureBody) continue;

            // Two binding shapes:
            //   (a) `return new \Acme\X(...)`     → key → Acme\X (+ ctor scalars)
            //   (b) `return $c->get(\Acme\X::class)` → key (alias) → Acme\X
            const directNew = extractDirectReturnNew(closureBody, importScope);
            const boundComponent = directNew?.component
                ?? extractAliasReturnClass(closureBody, importScope);

            const aliasTarget = !boundComponent
                ? extractAliasReturnString(closureBody)
                : undefined;

            if (!boundComponent && !aliasTarget) continue;

            // A `::class` key is an FQCN (resolve via use-aliases + namespace);
            // a quoted string id is used verbatim (it is the registry key).
            const key = classKey !== undefined
                ? resolvePhpClassName(classKey, importScope)
                : stringKey;
            out.push({
                key,
                boundComponent,
                aliasTarget,
                ctorScalars: directNew?.ctorScalars,
                autowireEnabled,
                sourceFile: ctx.relativePath,
                sourceHash,
            });
        }

        return out;
    }
}

/**
 * Walk forward from a position just inside `function (...` to extract the
 * closure body content (the chars between the opening and closing braces of
 * the closure block). Returns null on malformed input.
 *
 * Algorithm:
 *   1. Find matching `)` for the opening `(` (parameter list).
 *   2. Skip optional return type and whitespace.
 *   3. Expect `{`, walk to matching `}` with brace counting (string-aware).
 */
function extractClosureBody(content: string, headEnd: number): string | null {
    // 1. Match the parameter list `)`
    let depth = 1;
    let i = headEnd;
    while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '"' || ch === "'") i = skipString(content, i) - 1;
        i++;
    }
    if (depth !== 0) return null;

    // 2. Skip whitespace + optional return type (`: Foo` or `: \Foo\Bar`)
    while (i < content.length && /\s/.test(content[i])) i++;
    if (content[i] === ':') {
        i++;
        // Skip return type up to `{`
        while (i < content.length && content[i] !== '{') i++;
    }
    if (content[i] !== '{') return null;

    // 3. Walk to matching `}` with brace counting
    const bodyStart = i + 1;
    depth = 1;
    i++;
    while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' || ch === "'") i = skipString(content, i) - 1;
        else if (ch === '/' && content[i + 1] === '/') i = skipLineComment(content, i) - 1;
        else if (ch === '/' && content[i + 1] === '*') i = skipBlockComment(content, i) - 1;
        i++;
    }
    if (depth !== 0) return null;
    return content.slice(bodyStart, i - 1);
}

function skipString(content: string, start: number): number {
    const quote = content[start];
    let i = start + 1;
    while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === quote) return i + 1;
        i++;
    }
    return content.length;
}

function skipLineComment(content: string, start: number): number {
    let i = start;
    while (i < content.length && content[i] !== '\n') i++;
    return i + 1;
}

function skipBlockComment(content: string, start: number): number {
    let i = start + 2;
    while (i < content.length - 1) {
        if (content[i] === '*' && content[i + 1] === '/') return i + 2;
        i++;
    }
    return content.length;
}

// Capture exactly ONE `return new \Acme\X(...)` at the top level of the body.
// We deliberately reject closures with multiple distinct `new X` returns OR
// returns nested inside `if` branches (no static analysis safe enough).
const RETURN_NEW = /(?:^|;|\{|\n)\s*return\s+new\s+\\?([A-Z][A-Za-z0-9_\\]*)\s*\(/g;

function extractDirectReturnNew(
    body: string,
    scope: PhpImportScope,
): { component: string; ctorScalars?: Array<{ position: number; value: string }> } | undefined {
    RETURN_NEW.lastIndex = 0;
    const matches: Array<{ component: string; argsStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = RETURN_NEW.exec(body)) !== null) {
        matches.push({ component: resolvePhpClassName(m[1], scope), argsStart: RETURN_NEW.lastIndex });
        if (matches.length > 1) break;
    }
    if (matches.length !== 1) return undefined; // 0 → no direct new; >1 → conditional → LLM
    const ctorScalars = extractCtorScalarArgs(body, matches[0].argsStart);
    return {
        component: matches[0].component,
        ctorScalars: ctorScalars.length > 0 ? ctorScalars : undefined,
    };
}

// Walk the `new X(` arg list (starting just after the opening `(`) and record
// each top-level STRING-LITERAL arg with its positional index. Object args
// (`new Y()`, `$c->get(...)`, arrays) are skipped, so positions are the
// literal's index in the ORIGINAL arg list. String-aware (reuses skipString)
// and bracket-depth-aware so nested calls/arrays don't confuse arg splitting.
function extractCtorScalarArgs(body: string, startAfterParen: number): Array<{ position: number; value: string }> {
    const scalars: Array<{ position: number; value: string }> = [];
    let depth = 1;
    let i = startAfterParen;
    let argStart = i;
    let position = 0;
    const flush = (end: number): void => {
        const lit = parsePhpStringLiteral(body.slice(argStart, end).trim());
        if (lit !== undefined) scalars.push({ position, value: lit });
        position++;
    };
    while (i < body.length && depth > 0) {
        const ch = body[i];
        if (ch === '"' || ch === "'") { i = skipString(body, i); continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) { flush(i); break; }
        } else if (ch === ',' && depth === 1) {
            flush(i);
            if (scalars.length >= MAX_CTOR_SCALARS) break;
            argStart = i + 1;
        }
        i++;
    }
    return scalars;
}

// A PHP single/double-quoted string literal that spans the WHOLE arg (rejects
// concatenation `'a' . 'b'` and double-quote interpolation `"$x"`). Returns the
// inner text, or undefined when the arg is not a static string literal.
function parsePhpStringLiteral(arg: string): string | undefined {
    const q = arg[0];
    if (q !== "'" && q !== '"') return undefined;
    if (skipString(arg, 0) !== arg.length) return undefined; // not a single literal
    const inner = arg.slice(1, -1);
    if (q === '"' && /[${]/.test(inner)) return undefined; // interpolation → not static
    return inner;
}

// Capture `return $c->get(\Acme\X::class)` — alias to another DI key (class form).
const RETURN_GET_CLASS = /return\s+\$[A-Za-z_]\w*\s*->\s*get\s*\(\s*\\?([A-Z][A-Za-z0-9_\\]*)\s*::\s*class\s*\)\s*;/;

function extractAliasReturnClass(body: string, scope: PhpImportScope): string | undefined {
    const m = body.match(RETURN_GET_CLASS);
    if (!m) return undefined;
    return resolvePhpClassName(m[1], scope);
}

// Capture `return $c->get('some.id')` — alias to a string key.
const RETURN_GET_STRING = /return\s+\$[A-Za-z_]\w*\s*->\s*get\s*\(\s*['"]([^'"\\]+)['"]\s*\)\s*;/;

function extractAliasReturnString(body: string): string | undefined {
    const m = body.match(RETURN_GET_STRING);
    if (!m) return undefined;
    return m[1];
}

function stableHash(input: string): string {
    if (typeof (globalThis as { Bun?: { hash: (s: string) => bigint } }).Bun?.hash === 'function') {
        return (globalThis as { Bun: { hash: (s: string) => bigint } }).Bun.hash(input).toString(16);
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

void path; // imported for future relative-path normalization if needed
