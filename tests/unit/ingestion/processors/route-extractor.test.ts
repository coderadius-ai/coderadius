import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import {
    classifyRouteFile,
    extractHttpMethodsFromAST,
    isFileServerActionFromAST,
    type RouteFileInfo,
} from '../../../../src/ingestion/processors/route-extractor.js';

// ─── Tree-sitter parser helper ────────────────────────────────────────────────

let parser: Parser;

beforeAll(() => {
    parser = new Parser();
    parser.setLanguage(ts.typescript as unknown as Parser.Language);
});

function parse(src: string): Parser.SyntaxNode {
    return parser.parse(src).rootNode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyRouteFile() — file path classification
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyRouteFile()', () => {

    // ── Next.js App Router — route.ts files (should classify) ──────────────

    describe('Next.js App Router — route.ts', () => {
        it('root route.ts → basePath /', () => {
            const info = classifyRouteFile('app/route.ts');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/');
            expect(info!.framework).toBe('nextjs-app-router');
            expect(info!.isRouteFile).toBe(true);
        });

        it('nested route.ts → correct path', () => {
            expect(classifyRouteFile('app/checkout/route.ts')!.basePath).toBe('/checkout');
            expect(classifyRouteFile('app/users/settings/route.ts')!.basePath).toBe('/users/settings');
        });

        it('dynamic segment [id] → {param}', () => {
            expect(classifyRouteFile('app/users/[id]/route.ts')!.basePath).toBe('/users/{param}');
        });

        it('dynamic segment with different names → always {param}', () => {
            expect(classifyRouteFile('app/products/[slug]/route.ts')!.basePath).toBe('/products/{param}');
            expect(classifyRouteFile('app/orders/[orderId]/items/route.ts')!.basePath).toBe('/orders/{param}/items');
        });

        it('double dynamic segments → both collapsed to {param}', () => {
            expect(classifyRouteFile('app/api/webhooks/[provider]/[event]/route.ts')!.basePath)
                .toBe('/api/webhooks/{param}/{param}');
        });

        it('catch-all [...slug] → single {param}', () => {
            expect(classifyRouteFile('app/[...slug]/route.ts')!.basePath).toBe('/{param}');
        });

        it('optional catch-all [[...slug]] → single {param}', () => {
            expect(classifyRouteFile('app/[[...slug]]/route.ts')!.basePath).toBe('/{param}');
        });

        it('route group (auth) → stripped from path', () => {
            expect(classifyRouteFile('app/(auth)/login/route.ts')!.basePath).toBe('/login');
            expect(classifyRouteFile('app/(marketing)/about/route.ts')!.basePath).toBe('/about');
        });

        it('nested route groups → all stripped', () => {
            expect(classifyRouteFile('app/(auth)/(2fa)/verify/route.ts')!.basePath).toBe('/verify');
        });

        it('route group at root → /', () => {
            expect(classifyRouteFile('app/(marketing)/route.ts')!.basePath).toBe('/');
        });

        it('route.js extension also matched', () => {
            const info = classifyRouteFile('app/checkout/route.js');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/checkout');
        });

        it('deeply nested path', () => {
            expect(classifyRouteFile('app/api/webhooks/[provider]/route.ts')!.basePath)
                .toBe('/api/webhooks/{param}');
        });
    });

    // ── Next.js App Router — special segments that must be SKIPPED ──────────

    describe('Next.js App Router — parallel/intercepting routes (skip)', () => {
        it('@modal parallel route → null', () => {
            expect(classifyRouteFile('app/@modal/route.ts')).toBeNull();
        });

        it('@sidebar parallel route → null', () => {
            expect(classifyRouteFile('app/feed/@modal/route.ts')).toBeNull();
        });

        it('(.) intercepting route → null', () => {
            expect(classifyRouteFile('app/(.)photo/route.ts')).toBeNull();
        });

        it('(..) intercepting route → null', () => {
            expect(classifyRouteFile('app/(..)photo/route.ts')).toBeNull();
        });

        it('(...) intercepting route → null', () => {
            expect(classifyRouteFile('app/(...)photo/route.ts')).toBeNull();
        });
    });

    // ── Next.js App Router — UI pages and special files (MUST return null) ──

    describe('Next.js App Router — UI files (skip, zero pollution)', () => {
        it('root page.tsx → null', () => expect(classifyRouteFile('app/page.tsx')).toBeNull());
        it('nested page.tsx → null', () => expect(classifyRouteFile('app/checkout/page.tsx')).toBeNull());
        it('page.tsx in route group → null', () => expect(classifyRouteFile('app/(auth)/login/page.tsx')).toBeNull());
        it('dashboard page.tsx → null', () => expect(classifyRouteFile('app/dashboard/page.tsx')).toBeNull());
        it('page.js → null', () => expect(classifyRouteFile('app/checkout/page.js')).toBeNull());
        it('page.jsx → null', () => expect(classifyRouteFile('app/page.jsx')).toBeNull());
        it('layout.tsx → null', () => expect(classifyRouteFile('app/layout.tsx')).toBeNull());
        it('layout.tsx nested → null', () => expect(classifyRouteFile('app/checkout/layout.tsx')).toBeNull());
        it('loading.tsx → null', () => expect(classifyRouteFile('app/loading.tsx')).toBeNull());
        it('error.tsx → null', () => expect(classifyRouteFile('app/error.tsx')).toBeNull());
        it('not-found.tsx → null', () => expect(classifyRouteFile('app/not-found.tsx')).toBeNull());
        it('global-error.tsx → null', () => expect(classifyRouteFile('app/global-error.tsx')).toBeNull());
        it('middleware.ts at root → null', () => expect(classifyRouteFile('middleware.ts')).toBeNull());
        it('middleware.ts in src/ → null', () => expect(classifyRouteFile('src/middleware.ts')).toBeNull());
    });

    // ── Next.js Pages Router ──────────────────────────────────────────────────

    describe('Next.js Pages Router — pages/api/', () => {
        it('simple api route', () => {
            const info = classifyRouteFile('pages/api/webhook.ts');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/api/webhook');
            expect(info!.framework).toBe('nextjs-pages-router');
        });

        it('pages/api/.js extension', () => {
            expect(classifyRouteFile('pages/api/auth.js')!.basePath).toBe('/api/auth');
        });

        it('nested pages/api path', () => {
            expect(classifyRouteFile('pages/api/users/[id].ts')!.basePath).toBe('/api/users/{param}');
        });

        it('catch-all [...nextAuth].ts → {param}', () => {
            expect(classifyRouteFile('pages/api/[...nextAuth].ts')!.basePath).toBe('/api/{param}');
        });

        it('pages/api/index.ts → /api (index stripped)', () => {
            expect(classifyRouteFile('pages/api/index.ts')!.basePath).toBe('/api');
        });

        it('pages/api/auth/index.ts → /api/auth', () => {
            expect(classifyRouteFile('pages/api/auth/index.ts')!.basePath).toBe('/api/auth');
        });
    });

    describe('Next.js Pages Router — non-api pages (skip)', () => {
        it('pages/index.tsx → null', () => expect(classifyRouteFile('pages/index.tsx')).toBeNull());
        it('pages/dashboard.tsx → null', () => expect(classifyRouteFile('pages/dashboard.tsx')).toBeNull());
        it('pages/about.tsx → null', () => expect(classifyRouteFile('pages/about/index.tsx')).toBeNull());
        it('pages/_app.tsx → null', () => expect(classifyRouteFile('pages/_app.tsx')).toBeNull());
        it('pages/_document.tsx → null', () => expect(classifyRouteFile('pages/_document.tsx')).toBeNull());
    });

    // ── SvelteKit ─────────────────────────────────────────────────────────────

    describe('SvelteKit — +server.ts', () => {
        it('root +server.ts → /', () => {
            const info = classifyRouteFile('src/routes/+server.ts');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/');
            expect(info!.framework).toBe('sveltekit');
        });

        it('nested +server.ts', () => {
            expect(classifyRouteFile('src/routes/product/[id]/+server.ts')!.basePath).toBe('/product/{param}');
        });

        it('+server.ts with api prefix', () => {
            expect(classifyRouteFile('src/routes/api/auth/+server.ts')!.basePath).toBe('/api/auth');
        });

        it('+server.js also matched', () => {
            expect(classifyRouteFile('src/routes/data/+server.js')!.basePath).toBe('/data');
        });
    });

    describe('SvelteKit — UI files (skip)', () => {
        it('+page.svelte → null', () => expect(classifyRouteFile('src/routes/+page.svelte')).toBeNull());
        it('nested +page.svelte → null', () => expect(classifyRouteFile('src/routes/product/[id]/+page.svelte')).toBeNull());
        it('+layout.svelte → null', () => expect(classifyRouteFile('src/routes/+layout.svelte')).toBeNull());
        it('+error.svelte → null', () => expect(classifyRouteFile('src/routes/+error.svelte')).toBeNull());
    });

    // ── Nuxt 3 ───────────────────────────────────────────────────────────────

    describe('Nuxt 3 — server/routes/', () => {
        it('simple server route', () => {
            const info = classifyRouteFile('server/routes/api/users.ts');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/api/users');
            expect(info!.framework).toBe('nuxt');
        });

        it('dynamic segment', () => {
            expect(classifyRouteFile('server/routes/api/orders/[id].ts')!.basePath).toBe('/api/orders/{param}');
        });

        it('catch-all [...slug].ts → {param}', () => {
            expect(classifyRouteFile('server/routes/[...slug].ts')!.basePath).toBe('/{param}');
        });
    });

    describe('Nuxt 3 — server/api/ shorthand', () => {
        it('server/api/health.ts → /api/health', () => {
            const info = classifyRouteFile('server/api/health.ts');
            expect(info).not.toBeNull();
            expect(info!.basePath).toBe('/api/health');
            expect(info!.framework).toBe('nuxt');
        });

        it('server/api/users/[id].ts', () => {
            expect(classifyRouteFile('server/api/users/[id].ts')!.basePath).toBe('/api/users/{param}');
        });
    });

    // ── Non-route files (generic TS — should return null) ────────────────────

    describe('Non-route TypeScript files (skip)', () => {
        it('regular src/ file → null', () => expect(classifyRouteFile('src/utils/helper.ts')).toBeNull());
        it('Express router file → null (not file-based convention)', () => expect(classifyRouteFile('src/routes/user.ts')).toBeNull());
        it('config file → null', () => expect(classifyRouteFile('src/config/database.ts')).toBeNull());
        it('index.ts at root → null', () => expect(classifyRouteFile('src/index.ts')).toBeNull());
    });

    // ── Server Action detection ───────────────────────────────────────────────

    describe('Server Action detection (via sourceText)', () => {
        const withUseServer = `'use server';\n\nexport async function submitCheckout(data: FormData) {\n  // process\n}\n`;
        const withDoubleQuote = `"use server";\n\nexport async function submit() {}\n`;
        const noDirective = `export async function submit() {}\n`;
        const functionLevelOnly = `export async function submit() {\n  'use server';\n}\n`;
        const useServerNotFirst = `// comment\n'use server';\nexport async function submit() {}\n`;

        it('file-level use server (single quote) → isServerAction true', () => {
            const info = classifyRouteFile('src/actions/checkout.ts', withUseServer);
            expect(info!.isServerAction).toBe(true);
        });

        it('file-level use server (double quote) → isServerAction true', () => {
            const info = classifyRouteFile('src/actions/submit.ts', withDoubleQuote);
            expect(info!.isServerAction).toBe(true);
        });

        it('no use server directive → null (generic .ts file, not classified)', () => {
            // A .ts file with no 'use server' and no framework convention → null
            const info = classifyRouteFile('src/actions/checkout.ts', noDirective);
            expect(info).toBeNull();
        });

        it('function-level use server (NOT file-level) → null (not classified)', () => {
            // Function-level 'use server' does not make the file a server action
            const info = classifyRouteFile('src/actions/checkout.ts', functionLevelOnly);
            expect(info).toBeNull();
        });

        it('use server after a comment → null or isServerAction false (documented behavior)', () => {
            // Comment before 'use server' — our strict regex requires it to be FIRST
            // so this should NOT be classified as a server action
            const info = classifyRouteFile('src/actions/checkout.ts', useServerNotFirst);
            // Either null (not classified at all) or isServerAction=false is acceptable
            if (info !== null) {
                expect(info.isServerAction).toBe(false);
            } else {
                expect(info).toBeNull();
            }
        });

        it('isServerAction is false for route.ts files even with use server', () => {
            // route.ts with 'use server' is a route file, not a server action
            const info = classifyRouteFile('app/checkout/route.ts', withUseServer);
            expect(info!.isRouteFile).toBe(true);
            expect(info!.isServerAction).toBe(false); // route files take priority
        });
    });

});

// ═══════════════════════════════════════════════════════════════════════════════
// extractHttpMethodsFromAST() — HTTP method extraction from exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractHttpMethodsFromAST()', () => {

    // ── Form 1: function declaration exports ─────────────────────────────────

    describe('Form 1 — export function declarations', () => {
        it('single GET', () => {
            const src = `export function GET(request: Request) { return Response.json({}); }`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('async GET + POST', () => {
            const src = `export async function GET(req: Request) {} export async function POST(req: Request) {}`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
            expect(methods).toHaveLength(2);
        });

        it('all standard methods', () => {
            const src = [
                'export function GET() {}',
                'export function POST() {}',
                'export function PUT() {}',
                'export function PATCH() {}',
                'export function DELETE() {}',
            ].join('\n');
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
            expect(methods).toContain('PUT');
            expect(methods).toContain('PATCH');
            expect(methods).toContain('DELETE');
            expect(methods).toHaveLength(5);
        });

        it('non-HTTP export function → not included', () => {
            const src = `export function GET() {} export function helper() {} export function POST() {}`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
            expect(methods).not.toContain('helper');
        });
    });

    // ── Form 2: arrow function const exports ─────────────────────────────────

    describe('Form 2 — export const arrow functions', () => {
        it('export const GET = async () => {}', () => {
            const src = `export const GET = async (request: Request) => { return Response.json({}); };`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('export const POST (non-async)', () => {
            const src = `export const POST = (req: Request): Response => { return new Response('ok'); };`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']);
        });

        it('mixed GET function + DELETE const', () => {
            const src = `export function GET() {} export const DELETE = async () => {};`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('DELETE');
            expect(methods).toHaveLength(2);
        });

        it('non-HTTP const export → not included', () => {
            const src = `export const GET = () => {}; export const config = { runtime: 'edge' };`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });
    });

    // ── Form 3: local const then named export list ────────────────────────────

    describe('Form 3 — local declarations + export clause', () => {
        it('const GET + POST, then export { GET, POST }', () => {
            const src = `
const GET = async () => {};
const POST = () => {};
export { GET, POST };`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
            expect(methods).toHaveLength(2);
        });

        it('export clause with alias (GET as default) → use exported name', () => {
            // export { handler as GET } — exported name is GET
            const src = `const handler = async () => {}; export { handler as GET };`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('export clause mixing HTTP and non-HTTP names', () => {
            const src = `
async function GET() {}
async function updateUser() {}
export { GET, updateUser };`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).not.toContain('updateUser');
        });
    });

    // ── Form 4: re-export from another module ─────────────────────────────────

    describe('Form 4 — re-export from module (method detection only)', () => {
        it('export { GET } from handlers → detects GET', () => {
            const src = `export { GET } from './handlers.js';`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('export { GET, POST } from handlers', () => {
            const src = `export { GET, POST } from './handlers.js';`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
            expect(methods).toHaveLength(2);
        });

        it('re-export with alias: export { handler as PATCH } from ...', () => {
            const src = `export { handler as PATCH } from './base.js';`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['PATCH']);
        });

        it('re-export of non-HTTP names → not included', () => {
            const src = `export { config, runtime } from './config.js';`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']); // safe default
        });
    });

    // ── Fallback: no HTTP method exports ─────────────────────────────────────

    describe('Fallback — no HTTP method exports', () => {
        it('default export only → POST (safe default)', () => {
            const src = `export default function handler(req: Request) { return new Response('ok'); }`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']);
        });

        it('empty file → POST', () => {
            expect(extractHttpMethodsFromAST(parse(''), 'app/route.ts')).toEqual(['POST']);
        });

        it('only non-HTTP named exports → POST', () => {
            const src = `export const config = { runtime: 'edge' }; export function helper() {}`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']);
        });

        it('export default arrow → POST', () => {
            const src = `export default async (req: Request) => new Response('ok');`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']);
        });
    });

    // ── Case normalization ────────────────────────────────────────────────────

    describe('Case normalization', () => {
        it('lowercase export const get → GET', () => {
            const src = `export const get = async () => {};`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('mixed case → normalized', () => {
            const src = `export function Get() {} export const Post = () => {};`;
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
        });
    });

    // ── HEAD / OPTIONS normalization ──────────────────────────────────────────

    describe('HEAD / OPTIONS normalization', () => {
        it('HEAD → GET (normalizeHttpMethod compat)', () => {
            const src = `export function HEAD() {}`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['GET']);
        });

        it('OPTIONS → POST (normalizeHttpMethod compat)', () => {
            const src = `export function OPTIONS() {}`;
            expect(extractHttpMethodsFromAST(parse(src), 'app/route.ts')).toEqual(['POST']);
        });

        it('GET + HEAD → deduplicated to GET only', () => {
            const src = `export function GET() {} export function HEAD() {}`;
            // HEAD normalizes to GET, dedupe → only one GET
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            expect(methods).toEqual(['GET']);
        });
    });

    // ── Deduplication ────────────────────────────────────────────────────────

    describe('Deduplication', () => {
        it('same method declared twice → deduplicated', () => {
            const src = `export function GET() {} export const GET = () => {};`; // unlikely but valid TS edge case
            // parser may accept or error, we just verify no duplicates in output
            const methods = extractHttpMethodsFromAST(parse(src), 'app/route.ts');
            const uniqueMethods = [...new Set(methods)];
            expect(methods).toEqual(uniqueMethods);
        });
    });

    // ── Null rootNode ─────────────────────────────────────────────────────────

    describe('null rootNode', () => {
        it('null → POST (safe default)', () => {
            expect(extractHttpMethodsFromAST(null, 'app/route.ts')).toEqual(['POST']);
        });
    });

});

// ═══════════════════════════════════════════════════════════════════════════════
// isFileServerActionFromAST() — AST-based 'use server' detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('isFileServerActionFromAST()', () => {

    it('"use server" as first statement → true', () => {
        const src = `'use server';\n\nexport async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(true);
    });

    it('"use server" double quotes → true', () => {
        const src = `"use server";\n\nexport async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(true);
    });

    // THE KEY TEST — this is what the regex fails on
    it('"use server" after single-line comment → true (regex cannot handle this)', () => {
        const src = `// Copyright (c) 2024 Acme Corp. All rights reserved.\n'use server';\n\nexport async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(true);
    });

    it('"use server" after eslint-disable comment → true', () => {
        const src = `/* eslint-disable @typescript-eslint/no-explicit-any */\n'use server';\n\nexport async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(true);
    });

    it('"use server" after multiple comments → true', () => {
        const src = `// Copyright notice\n// @ts-nocheck\n'use server';\nexport async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(true);
    });

    it('no "use server" directive → false', () => {
        const src = `export async function submit() {}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(false);
    });

    it('function-level "use server" (not file-level) → false', () => {
        const src = `export async function submit() {\n  'use server';\n  return 'ok';\n}`;
        expect(isFileServerActionFromAST(parse(src))).toBe(false);
    });

    it('first non-comment statement is an import → false', () => {
        const src = `// comment\nimport { something } from './utils.js';\n'use server';\n`;
        expect(isFileServerActionFromAST(parse(src))).toBe(false);
    });

    it('empty file → false', () => {
        expect(isFileServerActionFromAST(parse(''))).toBe(false);
    });

});
