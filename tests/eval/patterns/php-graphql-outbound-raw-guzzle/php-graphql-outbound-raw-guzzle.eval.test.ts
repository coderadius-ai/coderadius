/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-graphql-outbound-raw-guzzle
 *
 * Real-world case: a PHP service that calls a remote GraphQL provider via a
 * thin Guzzle/PSR-18 wrapper (no Apollo, no webonyx/graphql-php client). The
 * operation document is either loaded from a `.gql` file (Phase B context)
 * or declared inline as a string (Phase C body-shape rule).
 *
 * Chunking is PER-METHOD via the real PHP plugin chunker — the same shape the
 * production pipeline produces. (A whole-class multi-operation chunk is an
 * artificial shape the pipeline never emits, and the fast model extracted a
 * varying subset of operations from it across refresh runs.)
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Phase B — when graphQLDocumentContext is injected for a `.gql` literal,
 *     the LLM emits the canonical `GRAPHQL MUTATION createOrder` rather than
 *     a plain HTTP `/api` POST.
 *   ✓ Phase C — when the source contains an inline `mutation X { ... }` and
 *     a Guzzle POST with `{query, variables}` body, the LLM (or the sanitizer
 *     defense net) emits a canonical GraphQL endpoint.
 *   ✓ Subscription operations get `method: null`.
 *   ✓ A REST GET with a `?query=<term>` URL parameter is NOT misclassified
 *     as GraphQL (false-positive guard for the body-shape regex — including
 *     the GET guard in reclassifyEmergentToGraphQL).
 *   ✓ Document operation names (CreateOrder, CancelOrder, OrderUpdates) are
 *     stored in `document_operation_name`, NOT used as the path's root field.
 *
 * Fixture: tests/eval/patterns/php-graphql-outbound-raw-guzzle/fixture/
 * Manifest: tests/eval/patterns/php-graphql-outbound-raw-guzzle/expected.graph.yaml
 *
 * Modes: replay (default, ~1s) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFunction } from '../../../../src/ai/agents/unified-analyzer.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../../helpers/llm-replay-cache.js';
import { loadFixtureManifest } from '../../helpers/pattern-eval.js';
import { formatGqlOperationContext } from '../../../../src/ingestion/extractors/graphql-operations-extractor.js';
import { reclassifyEmergentToGraphQL } from '../../../../src/ai/workflows/sanitizer.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// Wire replay cache (generic + per-language agents — see with-replay.ts)
await wireUnifiedAnalyzerReplay();

interface EmergentApiCall {
    path: string;
    method?: string | null;
    direction?: 'INBOUND' | 'OUTBOUND';
    // Canonical discriminator emitted by the analyzer schema (unified-analyzer.ts).
    // NOTE: 'protocol' exists only on ClientBinding — a different concept.
    api_kind?: 'rest' | 'graphql';
    document_operation_name?: string | null;
}

function callsOf(analysis: any): EmergentApiCall[] {
    return (analysis?.emergent_api_calls ?? []) as EmergentApiCall[];
}

function findCall(calls: EmergentApiCall[], path: string): EmergentApiCall | undefined {
    return calls.find(c => c.path === path);
}

/** Per-method chunks from the real PHP plugin chunker (production shape). */
function loadAdapterMethodChunks(): { chunks: CodeChunk[]; source: string } {
    const plugin = new PHPPlugin();
    const parser = plugin.createParser();
    const file = path.join(FIXTURE_DIR, 'src', 'OrderRawAdapter.php');
    const source = fs.readFileSync(file, 'utf-8');
    const tree = parser.parse(source);
    return { chunks: plugin.extractFunctions(tree, source, 'src/OrderRawAdapter.php'), source };
}

function methodChunk(chunks: CodeChunk[], methodName: string): CodeChunk {
    const chunk = chunks.find(c => c.name.endsWith(`.${methodName}`));
    if (!chunk) throw new Error(`chunk for ${methodName} not found in: ${chunks.map(c => c.name).join(', ')}`);
    return chunk;
}

/** Analyze a method chunk and apply the Phase C sanitizer body-shape pass. */
async function analyzeMethod(chunk: CodeChunk, gqlCtx?: string): Promise<EmergentApiCall[]> {
    const result = await analyzeFunction(
        chunk, 'fast',
        undefined,    // context
        undefined,    // taintContextSummary
        undefined,    // customKnowledge
        undefined,    // resolvedTypeDefinitions
        undefined,    // entityTableContext
        undefined,    // frameworkSignalContext
        undefined,    // functionId
        undefined,    // classConstantsContext
        undefined,    // clientBindingContext
        gqlCtx,       // graphQLDocumentContext (Phase B injection)
    );
    expect(result, `analyzeFunction must return a result for ${chunk.name}`).toBeDefined();
    const calls = callsOf(result!.analysis);
    for (const c of calls) reclassifyEmergentToGraphQL(c as any, chunk.sourceCode);
    return calls;
}

describe('Pattern Eval — php-graphql-outbound-raw-guzzle', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-graphql-outbound-raw-guzzle | Mode: ${EVAL_LLM_MODE}`);
        ({ chunks } = loadAdapterMethodChunks());
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-graphql-outbound-raw-guzzle');
    });

    // ─── Phase B — createOrder loads its document from a `.gql` file ────────
    it('OrderRawAdapter — Phase B context resolves CreateOrder.gql to canonical mutation', async () => {
        // Simulate the static-analyzer-pass injection for the .gql file.
        // Without this, the LLM has no way to know the operation name behind
        // file_get_contents(__DIR__ . '/Mutation/CreateOrder.gql').
        const gqlCtx = formatGqlOperationContext([
            { operationType: 'MUTATION', operationName: 'CreateOrder', rootField: 'createOrder' },
        ]);

        const calls = await analyzeMethod(methodChunk(chunks, 'createOrder'), gqlCtx);

        const createOrder = findCall(calls, 'GRAPHQL MUTATION createOrder');
        expect(createOrder, 'createOrder must emerge as a canonical GQL mutation').toBeDefined();
        expect(createOrder?.api_kind).toBe('graphql');
        expect(createOrder?.direction ?? 'OUTBOUND').toBe('OUTBOUND');
        // document_operation_name preserves the document's named operation
        if (createOrder?.document_operation_name != null) {
            expect(createOrder.document_operation_name).toBe('CreateOrder');
        }

        // Negative: the document operation name must NOT be the path root field
        expect(
            findCall(calls, 'GRAPHQL MUTATION CreateOrder'),
            'CreateOrder is a document operation name, not a root field — must not appear as path',
        ).toBeUndefined();
    });

    // ─── Phase C — inline operations, NO graphQLDocumentContext ─────────────
    it('OrderRawAdapter — Phase C inline mutation classifies without .gql context', async () => {
        const calls = await analyzeMethod(methodChunk(chunks, 'cancelOrder'));

        const cancelOrder = findCall(calls, 'GRAPHQL MUTATION cancelOrder');
        expect(cancelOrder, 'inline cancelOrder must classify even without .gql context').toBeDefined();
        expect(cancelOrder?.api_kind).toBe('graphql');

        expect(
            findCall(calls, 'GRAPHQL MUTATION CancelOrder'),
            'CancelOrder is a document operation name, not a root field — must not appear as path',
        ).toBeUndefined();
    });

    it('OrderRawAdapter — Phase C subscription gets method=null', async () => {
        const calls = await analyzeMethod(methodChunk(chunks, 'subscribeOrderUpdates'));

        const sub = findCall(calls, 'GRAPHQL SUBSCRIPTION orderUpdated');
        expect(sub, 'orderUpdated subscription must emerge with rootField=orderUpdated').toBeDefined();
        expect(sub?.method == null, 'subscription method must be null').toBe(true);
        expect(sub?.api_kind).toBe('graphql');

        expect(
            findCall(calls, 'GRAPHQL SUBSCRIPTION OrderUpdates'),
            'OrderUpdates is a document operation name, not a root field — must not appear as path',
        ).toBeUndefined();
    });

    it('OrderRawAdapter — REST ?query= URL must NOT be misclassified as GraphQL', async () => {
        const calls = await analyzeMethod(methodChunk(chunks, 'fetchSearch'));

        const fakeGqlSearch = calls.find(c => c.api_kind === 'graphql');
        expect(fakeGqlSearch, 'REST URL with ?query= must NOT be classified as GraphQL').toBeUndefined();

        const search = calls.find(c => /search/i.test(c.path));
        expect(search, 'the REST search endpoint must survive').toBeDefined();
        expect(search?.api_kind ?? 'rest').toBe('rest');
    });
});
