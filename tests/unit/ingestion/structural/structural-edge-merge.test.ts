import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// `structural/queries.ts` has a local `run()` that calls `getMemgraphSession()`.
// Mock the session factory so the test never touches Memgraph; capture the
// Cypher and params via a spy on `tx.run`.
const mockTxRun = vi.fn().mockResolvedValue({ records: [] });
vi.mock('../../../../src/graph/neo4j.js', () => ({
    getMemgraphSession: () => ({
        executeWrite: async (fn: (tx: { run: typeof mockTxRun }) => Promise<unknown>) =>
            fn({ run: mockTxRun }),
        close: async () => undefined,
    }),
}));

const { mergeStructuralEdge } = await import('../../../../src/ingestion/structural/queries.js');

beforeEach(() => mockTxRun.mockClear());
afterAll(() => vi.resetModules());

const mockRun = mockTxRun;

describe('mergeStructuralEdge — identity-aware MERGE (Gotcha #1)', () => {
    it('embeds identity-shaped properties in the relationship MERGE pattern', async () => {
        await mergeStructuralEdge(
            'cr:channel:topic:acme.orders@brk',
            'cr:channel:queue:acme.inventory.orders@brk',
            'ROUTES_TO',
            { bindingKey: 'acme.order.#', isPattern: true, patternRegex: '^acme\\.order(\\..*)?$' },
        );
        const [query, params] = mockRun.mock.calls[0] as [string, any];
        // The MERGE pattern must include the binding-key in the relationship
        // properties, otherwise two parallel bindings collapse on the first
        // pre-existing edge (Memgraph MATCH-first semantics).
        expect(query).toMatch(/MERGE\s*\(a\)-\[r:ROUTES_TO\s*\{[^}]*bindingKey[^}]*\}\]->\(b\)/);
        // The identity-key MUST be propagated to the params so callers can
        // pass through bindingKey distinctly.
        expect(params.identityKey).toBe('acme.order.#');
    });

    it('two parallel bindings same (src, tgt, type) different bindingKey → distinct identities', async () => {
        await mergeStructuralEdge(
            'cr:channel:topic:acme.orders@brk',
            'cr:channel:queue:acme.inventory.orders@brk',
            'ROUTES_TO',
            { bindingKey: 'acme.order.created' },
        );
        await mergeStructuralEdge(
            'cr:channel:topic:acme.orders@brk',
            'cr:channel:queue:acme.inventory.orders@brk',
            'ROUTES_TO',
            { bindingKey: 'acme.order.cancelled' },
        );
        expect(mockRun.mock.calls).toHaveLength(2);
        const a = mockRun.mock.calls[0][1] as any;
        const b = mockRun.mock.calls[1][1] as any;
        expect(a.identityKey).toBe('acme.order.created');
        expect(b.identityKey).toBe('acme.order.cancelled');
        // src/tgt identical; the binding-key is the only thing that splits the edges
        expect(a.sourceUrn).toBe(b.sourceUrn);
        expect(a.targetUrn).toBe(b.targetUrn);
    });

    it('promotes routing_key into identityKey when bindingKey is absent', async () => {
        await mergeStructuralEdge(
            'cr:src', 'cr:tgt', 'ROUTES_TO',
            { routing_key: 'legacy.key' },
        );
        const params = mockRun.mock.calls[0][1] as any;
        expect(params.identityKey).toBe('legacy.key');
    });

    it('non-ROUTES_TO edges fall back to identityKey="" (still preserves existing semantics)', async () => {
        await mergeStructuralEdge('cr:src', 'cr:tgt', 'HOSTED_ON');
        const params = mockRun.mock.calls[0][1] as any;
        expect(params.identityKey).toBe('');
    });

    it('rejects edge types not in the whitelist', async () => {
        await expect(mergeStructuralEdge('cr:src', 'cr:tgt', 'EVIL_RCE')).rejects.toThrow(/Rejected edge type/);
    });
});
