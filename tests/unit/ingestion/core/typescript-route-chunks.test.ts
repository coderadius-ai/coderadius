import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';

// ─── TypeScript plugin integration tests ─────────────────────────────────────
//
// Phase 2 tests: verify that TypeScriptPlugin.extractFunctions() emits correct
// synthetic chunks, and extractStaticInfra() returns correct StaticInfraResult.
//
// No LLM, no filesystem, no graph writes. Pure AST + plugin logic.

let parser: Parser | null = null;
const plugin = new TypeScriptPlugin();

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(ts.typescript as unknown as Parser.Language);
    }
    return parser;
}

function parseTree(src: string): Parser.Tree {
    return getParser().parse(src);
}

function makeChunk(name: string, filepath: string, endLine = 5) {
    return {
        name,
        filepath,
        sourceCode: '',
        language: 'typescript' as const,
        startLine: 1,
        startColumn: 1,
        endLine,
        endColumn: 1,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// extractFunctions() — synthetic chunk emission
// ═══════════════════════════════════════════════════════════════════════════════

describe('TypeScriptPlugin.extractFunctions() — route handler chunks', () => {

    // ── Next.js App Router ────────────────────────────────────────────────────

    describe('Next.js App Router — app/route.ts', () => {
        const src = `
import { NextRequest } from 'next/server';
export async function GET(request: NextRequest) { return Response.json({ ok: true }); }
export async function POST(request: NextRequest) { const body = await request.json(); return Response.json(body); }
`;
        const tree = parseTree(src);

        it('emits exactly 2 __route_handler chunks for GET+POST', () => {
            const chunks = plugin.extractFunctions(tree, src, 'app/route.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route).toHaveLength(2);
        });

        it('chunk names encode method and path', () => {
            const chunks = plugin.extractFunctions(tree, src, 'app/route.ts');
            const names = chunks.filter(c => c.name.endsWith('::__route_handler')).map(c => c.name);
            expect(names).toContain('GET /::__route_handler');
            expect(names).toContain('POST /::__route_handler');
        });

        it('chunks have correct filepath and language', () => {
            const chunks = plugin.extractFunctions(tree, src, 'app/route.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            for (const chunk of route) {
                expect(chunk.filepath).toBe('app/route.ts');
                expect(chunk.language).toBe('typescript');
            }
        });
    });

    describe('Next.js App Router — nested route with dynamic segment', () => {
        const src = `export async function POST(req: Request) { return new Response('ok'); }`;
        const tree = parseTree(src);

        it('emits chunk with {param} in path', () => {
            const chunks = plugin.extractFunctions(tree, src, 'app/api/webhooks/[provider]/route.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route).toHaveLength(1);
            expect(route[0].name).toBe('POST /api/webhooks/{param}::__route_handler');
        });
    });

    describe('Next.js App Router — route group (auth)', () => {
        const src = `export function GET() {}`;
        const tree = parseTree(src);

        it('strips route group from path', () => {
            const chunks = plugin.extractFunctions(tree, src, 'app/(auth)/login/route.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route[0].name).toBe('GET /login::__route_handler');
        });
    });

    describe('Next.js Pages Router — pages/api/', () => {
        const src = `export default function handler(req: any, res: any) { res.json({ ok: true }); }`;
        const tree = parseTree(src);

        it('emits single POST chunk (default export = no method detection)', () => {
            const chunks = plugin.extractFunctions(tree, src, 'pages/api/webhook.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route).toHaveLength(1);
            expect(route[0].name).toBe('POST /api/webhook::__route_handler');
        });
    });

    describe('SvelteKit — src/routes/+server.ts', () => {
        const src = `export const GET = async () => new Response('ok');`;
        const tree = parseTree(src);

        it('emits POST chunk (SvelteKit: all methods, use POST as default)', () => {
            const chunks = plugin.extractFunctions(tree, src, 'src/routes/api/users/+server.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route).toHaveLength(1);
            expect(route[0].name).toBe('POST /api/users::__route_handler');
        });
    });

    describe('Nuxt 3 — server/api/', () => {
        const src = `export default defineEventHandler(() => ({ status: 'ok' }));`;
        const tree = parseTree(src);

        it('emits POST chunk for Nuxt server/api route', () => {
            const chunks = plugin.extractFunctions(tree, src, 'server/api/health.ts');
            const route = chunks.filter(c => c.name.endsWith('::__route_handler'));
            expect(route).toHaveLength(1);
            expect(route[0].name).toBe('POST /api/health::__route_handler');
        });
    });

});

// ─── Zero pollution tests ─────────────────────────────────────────────────────

describe('TypeScriptPlugin.extractFunctions() — ZERO pollution from UI files', () => {
    const uiFiles = [
        { path: 'app/page.tsx', label: 'page.tsx (root)' },
        { path: 'app/checkout/page.tsx', label: 'page.tsx (nested)' },
        { path: 'app/(auth)/login/page.tsx', label: 'page.tsx (route group)' },
        { path: 'app/dashboard/page.tsx', label: 'page.tsx (dashboard)' },
        { path: 'app/layout.tsx', label: 'layout.tsx' },
        { path: 'app/loading.tsx', label: 'loading.tsx' },
        { path: 'app/error.tsx', label: 'error.tsx' },
        { path: 'app/not-found.tsx', label: 'not-found.tsx' },
        { path: 'middleware.ts', label: 'middleware.ts' },
        { path: 'pages/dashboard.tsx', label: 'pages/dashboard.tsx' },
        { path: 'pages/index.tsx', label: 'pages/index.tsx' },
        { path: 'src/utils/helper.ts', label: 'generic utils file' },
    ];

    const src = `export default function Component() { return null; }`;

    for (const { path: filePath, label } of uiFiles) {
        it(`emits zero route/action chunks for ${label}`, () => {
            const tree = parseTree(src);
            const chunks = plugin.extractFunctions(tree, src, filePath);
            const routeChunks = chunks.filter(c =>
                c.name.endsWith('::__route_handler') || c.name.endsWith('::__server_action'),
            );
            expect(routeChunks).toHaveLength(0);
        });
    }
});

// ─── Server Action chunks ─────────────────────────────────────────────────────

describe('TypeScriptPlugin.extractFunctions() — server action chunks', () => {
    describe("'use server' file with multiple exports", () => {
        const src = `'use server';

export async function submitCheckout(formData: FormData) {
  return { success: true };
}

export async function cancelOrder(orderId: string) {
  return { cancelled: orderId };
}`;
        const tree = parseTree(src);

        it('emits 2 __server_action chunks (one per exported function)', () => {
            const chunks = plugin.extractFunctions(tree, src, 'src/actions/checkout.ts');
            const action = chunks.filter(c => c.name.endsWith('::__server_action'));
            expect(action).toHaveLength(2);
        });

        it('chunk names encode function names', () => {
            const chunks = plugin.extractFunctions(tree, src, 'src/actions/checkout.ts');
            const names = chunks.filter(c => c.name.endsWith('::__server_action')).map(c => c.name);
            expect(names).toContain('POST /_action/submitCheckout::__server_action');
            expect(names).toContain('POST /_action/cancelOrder::__server_action');
        });
    });

    describe("'use server' file with comment before directive", () => {
        const src = `// Copyright (c) 2024 Acme Corp.
'use server';

export async function submit() {}`;
        const tree = parseTree(src);

        it('correctly detects server action despite leading comment (AST-based)', () => {
            const chunks = plugin.extractFunctions(tree, src, 'src/actions/submit.ts');
            const action = chunks.filter(c => c.name.endsWith('::__server_action'));
            expect(action).toHaveLength(1);
            expect(action[0].name).toBe('POST /_action/submit::__server_action');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractStaticInfra() — StaticInfraResult shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('TypeScriptPlugin.extractStaticInfra() — route handler', () => {
    const dummyNode = parseTree('').rootNode; // rootNode passed but unused for route chunks

    it('null for normal function chunk', () => {
        const chunk = makeChunk('handleRequest', 'src/api.ts', 10);
        expect(plugin.extractStaticInfra(dummyNode, chunk)).toBeNull();
    });

    it('returns StaticInfraResult for __route_handler chunk', () => {
        const chunk = makeChunk('GET /checkout::__route_handler', 'app/checkout/route.ts');
        const result = plugin.extractStaticInfra(dummyNode, chunk);
        expect(result).not.toBeNull();
        expect(result!.has_io).toBe(true);
        expect(result!.emergent_api_calls).toHaveLength(1);
        expect(result!.emergent_api_calls[0].method).toBe('GET');
        expect(result!.emergent_api_calls[0].path).toBe('/checkout');
        expect(result!.emergent_api_calls[0].direction).toBe('INBOUND');
        expect(result!.emergent_api_calls[0].framework).toBe('Next.js App Router');
        expect(result!.capabilities).toContain('http-handler');
    });

    it('returns StaticInfraResult for POST route handler', () => {
        const chunk = makeChunk('POST /api/webhooks/{param}::__route_handler', 'app/api/webhooks/[provider]/route.ts');
        const result = plugin.extractStaticInfra(dummyNode, chunk);
        expect(result!.emergent_api_calls[0].method).toBe('POST');
        expect(result!.emergent_api_calls[0].path).toBe('/api/webhooks/{param}');
    });

    it('identifies SvelteKit framework from filepath', () => {
        const chunk = makeChunk('POST /product/{param}::__route_handler', 'src/routes/product/[id]/+server.ts', 3);
        const result = plugin.extractStaticInfra(dummyNode, chunk);
        expect(result!.emergent_api_calls[0].framework).toBe('SvelteKit');
    });

    it('identifies Nuxt 3 framework from filepath', () => {
        const chunk = makeChunk('POST /api/health::__route_handler', 'server/api/health.ts', 3);
        const result = plugin.extractStaticInfra(dummyNode, chunk);
        expect(result!.emergent_api_calls[0].framework).toBe('Nuxt 3');
    });
});

describe('TypeScriptPlugin.extractStaticInfra() — server action', () => {
    const dummyNode = parseTree('').rootNode;

    it('returns StaticInfraResult for __server_action chunk', () => {
        const chunk = makeChunk('POST /_action/submitCheckout::__server_action', 'src/actions/checkout.ts', 10);
        const result = plugin.extractStaticInfra(dummyNode, chunk);
        expect(result).not.toBeNull();
        expect(result!.has_io).toBe(true);
        expect(result!.emergent_api_calls[0].method).toBe('POST');
        expect(result!.emergent_api_calls[0].path).toBe('/_action/submitCheckout');
        expect(result!.emergent_api_calls[0].direction).toBe('INBOUND');
        expect(result!.emergent_api_calls[0].framework).toBe('nextjs-action');
        expect(result!.capabilities).toContain('server-action');
        expect(result!.capabilities).toContain('http-handler');
    });

    it('returns null for unrecognized chunk suffix', () => {
        const chunk = makeChunk('POST /_action/submit::__other', 'src/actions/checkout.ts');
        expect(plugin.extractStaticInfra(dummyNode, chunk)).toBeNull();
    });
});

describe('TypeScriptPlugin.extractFunctions() — callback extraction boundaries', () => {
    it('skips standalone fp-ts callbacks that are internal control-flow fragments', () => {
        const src = `
import { function as F, taskEither as TE } from 'fp-ts';

export const closeQuote = () =>
  F.pipe(
    TE.of(1),
    TE.chain(value => repository.close(value)),
    TE.map(result => result + 1),
  );
`;
        const chunks = plugin.extractFunctions(parseTree(src), src, 'src/application/CloseQuote.usecase.ts');

        expect(chunks.map(chunk => chunk.name)).toContain('closeQuote');
        expect(chunks.some(chunk => chunk.name.endsWith('_callback') || chunk.name === 'anonymous')).toBe(false);
    });

    it('names class field arrow functions instead of extracting them as anonymous chunks', () => {
        const src = `
export class ExampleService {
  private readonly emitEvent = (value: string) => value.toUpperCase();
}
`;
        const chunks = plugin.extractFunctions(parseTree(src), src, 'src/application/ExampleService.ts');
        expect(chunks.map(chunk => chunk.name)).toContain('ExampleService.emitEvent');
        expect(chunks.some(chunk => chunk.name === 'anonymous')).toBe(false);
    });

    it('keeps route handlers and other boundary callbacks exposed by the framework', () => {
        const src = `
export async function POST(request: Request) {
  return new Response('ok');
}
`;
        const chunks = plugin.extractFunctions(parseTree(src), src, 'app/api/orders/route.ts');
        expect(chunks.some(chunk => chunk.name === 'POST /api/orders::__route_handler')).toBe(true);
    });
});

describe('TypeScriptPlugin.extractDependencyBindings()', () => {
    it('extracts provide/useClass and provide/useExisting provider bindings', () => {
        const src = `
export const RepoProvider = { provide: IRenewalRepository, useClass: RenewalRepository };
export const ServiceProvider = { provide: IRegistrySearchService, useExisting: RegistrySearchService };
`;
        const bindings = plugin.extractDependencyBindings(parseTree(src).rootNode, 'src/providers.ts');

        expect(bindings).toEqual([
            {
                provide: 'IRenewalRepository',
                target: 'RenewalRepository',
                filePath: 'src/providers.ts',
                bindingType: 'useClass',
            },
            {
                provide: 'IRegistrySearchService',
                target: 'RegistrySearchService',
                filePath: 'src/providers.ts',
                bindingType: 'useExisting',
            },
        ]);
    });

    it('extracts string-literal token bindings used for alias chains', () => {
        const src = `
export const QuoteRepositoryProvider = { provide: 'IQuoteRepository', useClass: QuoteRepository };
export const QuoteStoreProvider = { provide: 'QuoteStore', useExisting: 'IQuoteRepository' };
`;
        const bindings = plugin.extractDependencyBindings(parseTree(src).rootNode, 'src/providers.ts');

        expect(bindings).toEqual([
            {
                provide: 'IQuoteRepository',
                target: 'QuoteRepository',
                filePath: 'src/providers.ts',
                bindingType: 'useClass',
            },
            {
                provide: 'QuoteStore',
                target: 'IQuoteRepository',
                filePath: 'src/providers.ts',
                bindingType: 'useExisting',
            },
        ]);
    });
});
