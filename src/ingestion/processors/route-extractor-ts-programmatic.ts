import type Parser from 'tree-sitter';

// ─── TypeScript Programmatic Route Extractor ───────────────────────────────────
//
// Pure, framework-agnostic detection of programmatic HTTP route registrations
// that the file-convention route-extractor.ts explicitly defers (Express /
// Fastify / Koa / Hono — "programmatic routing, not file-based"):
//
//   app.get('/path', handler)              — Express / Fastify / Koa-router / Hono
//   router.post('/path', mw, handler)
//   app.route({ method: 'DELETE', url: '/path', handler })   — Fastify object form
//
// NO side effects. NO I/O. NO LLM. Input → Output only. One route → one
// `${METHOD} ${path}::__route_handler` synthetic chunk, consumed by
// static-infra.ts → INBOUND APIEndpoint. Mirrors route-extractor-php.ts.
// ───────────────────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TsRoute {
    method: HttpMethod;
    path: string;
}

const DIRECT_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const VALID_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Receivers that are HTTP *clients* (outbound), never route registrars. Excludes
// the most common false positives: axios.get('/u', cfg), got.post(...), etc.
// ponytail: denylist of outbound clients, not a router allowlist — keeps recall
// (named/imported app vars still match). Upgrade to a typed-handler check if a
// held-out fixture surfaces outbound-call FPs.
const HTTP_CLIENT_RECEIVERS = new Set([
    'axios', 'fetch', 'http', 'https', 'got', 'request', 'ky', 'superagent',
    'client', 'httpclient', 'apiclient',
]);

/**
 * Extract programmatic routes (Express/Fastify/Koa/Hono shorthand + Fastify
 * object form) from a parsed TS/JS file. Deduplicated by (method, path).
 */
export function extractTsProgrammaticRoutes(rootNode: Parser.SyntaxNode): TsRoute[] {
    const routes: TsRoute[] = [];
    walk(rootNode, routes);

    const seen = new Set<string>();
    return routes.filter(r => {
        const key = `${r.method}:${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function walk(node: Parser.SyntaxNode, routes: TsRoute[]): void {
    if (node.type === 'call_expression') {
        const extracted = handleCall(node);
        if (extracted) routes.push(extracted);
    }
    for (const child of node.children) walk(child, routes);
}

function handleCall(node: Parser.SyntaxNode): TsRoute | null {
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'member_expression') return null;

    const object = callee.childForFieldName('object');
    const objectText = object?.text ?? '';
    // Skip this.client.get(...) — service/domain calls on `this`, never routes.
    if (objectText.startsWith('this')) return null;

    const property = callee.childForFieldName('property');
    const methodName = property?.text?.toLowerCase();
    if (!methodName) return null;

    const args = callArguments(node);

    // Shorthand: app.get('/path', handler). Require ≥2 args (path + handler) and
    // a leading-slash string path to reject map.get('k') / cache.get(...).
    if (DIRECT_HTTP_METHODS.has(methodName)) {
        const receiver = objectText.split('.').pop()?.toLowerCase() ?? '';
        if (HTTP_CLIENT_RECEIVERS.has(receiver)) return null;
        if (args.length < 2) return null;
        const path = stringLiteralValue(args[0]);
        if (path === null || !path.startsWith('/')) return null;
        return { method: methodName.toUpperCase() as HttpMethod, path };
    }

    // Fastify object form: app.route({ method: 'GET', url: '/path', handler }).
    if (methodName === 'route') {
        const obj = args[0];
        if (!obj || obj.type !== 'object') return null;
        const method = objectStringProp(obj, 'method')?.toUpperCase();
        const url = objectStringProp(obj, 'url');
        if (!method || !VALID_METHODS.has(method as HttpMethod)) return null;
        if (!url || !url.startsWith('/')) return null;
        return { method: method as HttpMethod, path: url };
    }

    return null;
}

/** Argument nodes of a call_expression, minus punctuation/comments. */
function callArguments(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const argsNode = callNode.childForFieldName('arguments');
    if (!argsNode) return [];
    return argsNode.children.filter(c =>
        c.type !== ',' && c.type !== '(' && c.type !== ')' && c.type !== 'comment',
    );
}

/** Static string value of a string / non-interpolated template literal, else null. */
function stringLiteralValue(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    if (node.type === 'string') return node.text.replace(/^['"`]|['"`]$/g, '');
    if (node.type === 'template_string') {
        if (node.text.includes('${')) return null; // interpolated → dynamic, skip
        return node.text.replace(/^`|`$/g, '');
    }
    return null;
}

/** Value of a string-valued property `key: '...'` in an object literal, else null. */
function objectStringProp(objNode: Parser.SyntaxNode, key: string): string | null {
    for (const pair of objNode.children) {
        if (pair.type !== 'pair') continue;
        const keyNode = pair.childForFieldName('key');
        const keyText = keyNode?.text?.replace(/^['"`]|['"`]$/g, '');
        if (keyText !== key) continue;
        return stringLiteralValue(pair.childForFieldName('value') ?? undefined);
    }
    return null;
}
