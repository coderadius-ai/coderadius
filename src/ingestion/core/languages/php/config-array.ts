/**
 * PHP `return [...]` config-array reader.
 *
 * Deterministically converts a top-level `return [ ... ];` PHP array into a
 * plain JS value (nested arrays → objects/arrays, string/int/float/bool/null
 * literals). ANY non-literal expression (`Secret::read(...)`, `getenv(...)`,
 * a constant, a method call) becomes `null`: callers treat `null` as
 * UNRESOLVED and skip it. The walk is depth-bounded so a pathological config
 * cannot blow the stack.
 *
 * Two deliberate extensions to the literal-only rule:
 *  - `Foo\Bar::class` resolves to the FQCN string — PHP's `::class` is a
 *    compile-time literal, the only class-constant resolvable without
 *    executing code. Any other class constant stays UNRESOLVED.
 *  - An optional `accessorValue` hook (see {@link PhpConfigParseOptions})
 *    lets the CALLER translate declared env-accessor wrappers
 *    (`Secret::read('KEY', 'default')`) into `${KEY:-default}` shell
 *    templates. ASYMMETRY BY DESIGN: the hook is meant for CONNECTION
 *    ENDPOINT values (host/port/dbname/vhost) where a harvested default is
 *    legitimate grounding; channel/exchange NAMES read through accessors
 *    must remain skipped by structural plugins — a channel's identity can
 *    never come from a dev default.
 *
 * This is a pure, language-specific utility — it lives under
 * `core/languages/php/` and knows nothing about messaging, brokers, or any
 * framework. Structural plugins layer their domain navigation on top of the
 * plain JS value it returns.
 */

import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../../../processors/parser/jsc-compat.js';
import { extractStringLiteralValueRaw } from './shared/ast-utils.js';

const MAX_DEPTH = 8;

export interface PhpConfigParseOptions {
    /**
     * Invoked for call-expression values (`scoped_call_expression` /
     * `function_call_expression`) that would otherwise be UNRESOLVED.
     * Receives the verbatim callee text (`\Acme\Secret::read`, `getenv`) and
     * the literal scalar arguments in order, stringified (string/int/float;
     * non-literal arguments are `null` entries). Returns a replacement value
     * — by convention a shell template `${KEY:-default}` resolvable by the
     * existing `shell` TemplateSyntax — or `null` to keep the value
     * UNRESOLVED.
     */
    accessorValue?: (calleeText: string, argTexts: Array<string | null>) => string | null;
}

let _parser: Parser | null = null;
function parser(): Parser {
    if (!_parser) {
        _parser = new Parser();
        _parser.setLanguage(patchLanguage(phpExport.php));
    }
    return _parser;
}

/**
 * Parse `content` and return the plain-JS form of its top-level `return [...]`
 * array. Returns `null` when there is no top-level return, when the returned
 * value is not an array, or when the file fails to parse. Without `opts` the
 * behavior is byte-identical to the literal-only reader (regression pin).
 */
export function parsePhpReturnConfig(content: string, opts?: PhpConfigParseOptions): unknown | null {
    let root: Parser.SyntaxNode | undefined;
    try {
        root = parser().parse(content)?.rootNode;
    } catch {
        return null;
    }
    if (!root) return null;

    const returnedArray = findTopLevelReturnArray(root);
    if (returnedArray) return convertArrayNode(returnedArray, 0, opts);

    // Laminas merge idiom: `return ArrayUtils::merge($a, $b)` /
    // `return array_merge([...], $b)` with arguments that are array literals
    // or top-level `$var = [...]` assignments. Published laminas-stdlib / PHP
    // API; unresolvable arguments are skipped, later arguments win.
    const mergeArgs = findTopLevelMergeReturnArrays(root);
    if (mergeArgs.length === 0) return null;
    return mergeArgs
        .map((node) => convertArrayNode(node, 0, opts))
        .reduce((acc, part) => deepMergeConfig(acc, part), {} as unknown);
}

/** Recursive object merge with later-wins semantics (ArrayUtils::merge shape). */
function deepMergeConfig(left: unknown, right: unknown): unknown {
    if (!isPlainObject(left) || !isPlainObject(right)) return right ?? left;
    const out: Record<string, unknown> = { ...left };
    for (const [k, v] of Object.entries(right)) {
        out[k] = k in out ? deepMergeConfig(out[k], v) : v;
    }
    return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const MERGE_CALLEE_RE = /(?:^|\\|::)(?:ArrayUtils::merge|array_merge|array_merge_recursive)$/;

/**
 * When the top-level return is a merge CALL, resolve each argument to an
 * array node: literal arrays directly, variables via their last top-level
 * `$name = [...]` assignment. Unresolvable arguments are skipped.
 */
function findTopLevelMergeReturnArrays(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
    for (const stmt of iterateTopLevelStatements(root)) {
        if (stmt.type !== 'return_statement') continue;
        const value = stmt.children.find(isExpressionChild);
        if (!value) return [];
        const call = unwrap(value);
        if (call.type !== 'scoped_call_expression' && call.type !== 'function_call_expression') return [];
        const callee = call.text.slice(0, call.text.indexOf('(')).trim();
        if (!MERGE_CALLEE_RE.test(callee.replace(/\s+/g, ''))) return [];

        const args = call.descendantsOfType('arguments')[0];
        if (!args) return [];
        const assignments = collectTopLevelArrayAssignments(root);
        const resolved: Parser.SyntaxNode[] = [];
        for (const arg of args.namedChildren) {
            const inner = unwrap(arg.namedChildren[0] ?? arg);
            if (inner.type === 'array_creation_expression') {
                resolved.push(inner);
            } else if (inner.type === 'variable_name') {
                const assigned = assignments.get(inner.text);
                if (assigned) resolved.push(assigned);
            }
        }
        return resolved;
    }
    return [];
}

/** Map of `$var` → array node for every top-level `$var = [...];` (last wins). */
function collectTopLevelArrayAssignments(root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> {
    const out = new Map<string, Parser.SyntaxNode>();
    for (const stmt of iterateTopLevelStatements(root, true)) {
        if (stmt.type !== 'expression_statement') continue;
        const assign = stmt.namedChildren[0];
        if (assign?.type !== 'assignment_expression') continue;
        const left = assign.childForFieldName('left');
        const right = assign.childForFieldName('right');
        if (left?.type !== 'variable_name' || !right) continue;
        const value = unwrap(right);
        if (value.type === 'array_creation_expression') out.set(left.text, value);
    }
    return out;
}

/**
 * Locate the array node of the first top-level `return [...]` statement.
 * Top-level = a direct child of the program / php block, never nested inside a
 * function or class body.
 */
function findTopLevelReturnArray(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
    for (const stmt of iterateTopLevelStatements(root)) {
        if (stmt.type !== 'return_statement') continue;
        const value = stmt.children.find(isExpressionChild);
        if (value && unwrap(value).type === 'array_creation_expression') {
            return unwrap(value);
        }
        return null;
    }
    return null;
}

function* iterateTopLevelStatements(root: Parser.SyntaxNode, all = false): Generator<Parser.SyntaxNode> {
    for (const child of root.children) {
        // `<?php ... ?>` blocks wrap statements in a `php_tag` + siblings; some
        // grammars nest them in a `text_interpolation`/`program` wrapper, so
        // descend one level into compound wrappers but never into definitions.
        if (child.type === 'return_statement' || (all && child.type === 'expression_statement')) {
            yield child;
        } else if (isStatementWrapper(child)) {
            yield* child.children.filter(c =>
                c.type === 'return_statement' || (all && c.type === 'expression_statement'));
        }
    }
}

function isStatementWrapper(node: Parser.SyntaxNode): boolean {
    return node.type === 'program'
        || node.type === 'text_interpolation'
        || node.type === 'compound_statement';
}

function isExpressionChild(node: Parser.SyntaxNode): boolean {
    return node.type !== 'return' && node.text !== 'return' && node.text !== ';';
}

/**
 * Convert an `array_creation_expression` node to a JS array (when every element
 * is keyless) or a JS object (when keyed). Empty arrays become `[]`.
 */
function convertArrayNode(arrayNode: Parser.SyntaxNode, depth: number, opts?: PhpConfigParseOptions): unknown {
    if (depth >= MAX_DEPTH) return null;
    const elements = arrayNode.children.filter(c => c.type === 'array_element_initializer');
    const allKeyless = elements.every(el => arrowIndexOf(el) < 0);
    return allKeyless
        ? elements.map(el => convertValue(elementValue(el), depth + 1, opts))
        : convertKeyedElements(elements, depth, opts);
}

function convertKeyedElements(elements: Parser.SyntaxNode[], depth: number, opts?: PhpConfigParseOptions): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const el of elements) {
        const arrowIndex = arrowIndexOf(el);
        if (arrowIndex <= 0) continue;
        const key = arrayKeyValue(el.children[arrowIndex - 1]);
        const valueNode = el.children[arrowIndex + 1];
        if (key === null || !valueNode) continue;
        out[key] = convertValue(valueNode, depth + 1, opts);
    }
    return out;
}

function arrowIndexOf(element: Parser.SyntaxNode): number {
    return element.children.findIndex(c => c.text === '=>');
}

function elementValue(element: Parser.SyntaxNode): Parser.SyntaxNode | null {
    return element.children.find(c => c.type !== ',') ?? null;
}

/**
 * Convert any value node: nested array → recurse; literal → its JS value;
 * accessor call with a hook → the hook's template; everything else (calls,
 * constants, member access) → null.
 */
function convertValue(node: Parser.SyntaxNode | null, depth: number, opts?: PhpConfigParseOptions): unknown {
    if (!node) return null;
    const value = unwrap(node);
    if (value.type === 'array_creation_expression') return convertArrayNode(value, depth, opts);
    if (opts?.accessorValue && isCallExpression(value)) {
        return accessorCallValue(value, opts.accessorValue);
    }
    return literalValue(value);
}

function isCallExpression(node: Parser.SyntaxNode): boolean {
    return node.type === 'scoped_call_expression' || node.type === 'function_call_expression';
}

/**
 * Feed a call-expression value to the caller's accessor hook: verbatim callee
 * text + literal scalar arguments stringified (non-literal arguments are
 * `null` entries). Pure tree-sitter walk of the `arguments` node — never a
 * regex.
 */
function accessorCallValue(
    call: Parser.SyntaxNode,
    hook: NonNullable<PhpConfigParseOptions['accessorValue']>,
): string | null {
    const parenIdx = call.text.indexOf('(');
    if (parenIdx <= 0) return null;
    const calleeText = call.text.slice(0, parenIdx).trim();
    const argsNode = call.childForFieldName('arguments') ?? call.descendantsOfType('arguments')[0];
    const argTexts: Array<string | null> = [];
    for (const arg of argsNode?.namedChildren ?? []) {
        argTexts.push(scalarArgText(unwrap(arg.namedChildren[0] ?? arg)));
    }
    return hook(calleeText, argTexts);
}

function scalarArgText(node: Parser.SyntaxNode): string | null {
    if (node.type === 'string' || node.type === 'encapsed_string') return stringLiteral(node);
    if (node.type === 'integer' || node.type === 'float') return node.text;
    return null;
}

function literalValue(value: Parser.SyntaxNode): unknown {
    if (value.type === 'string' || value.type === 'encapsed_string') return stringLiteral(value);
    if (value.type === 'integer') return Number.parseInt(value.text, 10);
    if (value.type === 'float') return Number.parseFloat(value.text);
    if (value.type === 'boolean') return value.text.toLowerCase() === 'true';
    if (value.type === 'null') return null;
    if (value.type === 'name') return scalarKeyword(value.text);
    if (value.type === 'class_constant_access_expression') return classConstantValue(value);
    return null;
}

/**
 * `Foo\Bar::class` → `'Foo\Bar'`: PHP's `::class` is a compile-time FQCN
 * literal, the only class-constant resolvable without executing code (needed
 * for `driverClass => Foo\Driver::class`). Any other class constant
 * (`Foo::MODE`) stays UNRESOLVED → null. Leading `\` is stripped so the FQCN
 * matches use-statement spelling.
 */
function classConstantValue(node: Parser.SyntaxNode): string | null {
    const sep = node.text.lastIndexOf('::');
    if (sep < 0) return null;
    if (node.text.slice(sep + 2).trim() !== 'class') return null;
    const fqcn = node.text.slice(0, sep).trim().replace(/^\\+/, '');
    return fqcn || null;
}

// PHP `true`/`false`/`null` sometimes surface as a bare `name` node depending
// on the grammar build. Resolve those keywords; any other bare name is a
// constant reference we cannot resolve, so it is UNRESOLVED → null.
function scalarKeyword(text: string): unknown {
    const lower = text.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return null;
}

function stringLiteral(value: Parser.SyntaxNode): string | null {
    // Interpolated strings (containing a variable) are not literal scalars.
    if (value.children.some(c => c.type === 'variable_name')) return null;
    const raw = extractStringLiteralValueRaw(value.text);
    if (raw === null || raw.includes('${')) return null;
    return raw;
}

function arrayKeyValue(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    const value = unwrap(node);
    if (value.type === 'string' || value.type === 'encapsed_string') return stringLiteral(value);
    if (value.type === 'integer' || value.type === 'name') return value.text;
    return null;
}

function unwrap(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'parenthesized_expression') {
        const inner = node.children.find(c => c.type !== '(' && c.type !== ')');
        return inner ? unwrap(inner) : node;
    }
    return node;
}
