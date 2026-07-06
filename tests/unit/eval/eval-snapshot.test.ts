import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/graph/neo4j.js', () => ({
    getMemgraphSession: vi.fn(),
}));

import { getMemgraphSession } from '../../../src/graph/neo4j.js';
import { TRACKED_RELS, fetchFileTopologySnapshots } from '../../../src/graph/queries/eval-snapshot.js';

const mockSession = { run: vi.fn(), close: vi.fn() };
const mockGetSession = getMemgraphSession as ReturnType<typeof vi.fn>;

function makeRecord(data: Record<string, unknown>) {
    return { get: (key: string) => data[key] ?? null };
}

// ─── fetchFileTopologySnapshots ───────────────────────────────────────────────

describe('fetchFileTopologySnapshots', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSession.mockReturnValue(mockSession);
        mockSession.close.mockResolvedValue(undefined);
    });

    it('tracks MAPS_TO relationships for ORM table mappings', () => {
        expect(TRACKED_RELS).toContain('MAPS_TO');
    });

    it('tracks IMPLEMENTS_ENDPOINT relationships for exposed API routes', () => {
        expect(TRACKED_RELS).toContain('IMPLEMENTS_ENDPOINT');
    });

    it('returns empty map for empty input', async () => {
        const result = await fetchFileTopologySnapshots([]);
        expect(result.size).toBe(0);
        expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('initializes empty snapshot for each requested file', async () => {
        mockSession.run.mockResolvedValue({ records: [] });

        const result = await fetchFileTopologySnapshots(['src/A.ts', 'src/B.ts']);
        expect(result.has('src/A.ts')).toBe(true);
        expect(result.has('src/B.ts')).toBe(true);
        expect(result.get('src/A.ts')!.edges).toHaveLength(0);
    });

    it('populates edges and nodes from query records', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'src/A.ts',
                    functionId: 'cr:fn:A::pub',
                    functionName: 'pub',
                    relType: 'PUBLISHES_TO',
                    resourceId: 'cr:channel:orders',
                    resourceName: 'orders',
                    resourceLabels: ['MessageChannel'],
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const snapshot = result.get('src/A.ts')!;

        expect(snapshot.edges).toHaveLength(1);
        expect(snapshot.edges[0]).toMatchObject({ relType: 'PUBLISHES_TO', targetId: 'cr:channel:orders' });
        expect(snapshot.nodes).toHaveLength(1);
        expect(snapshot.nodes[0].type).toBe('MessageChannel');
    });

    it('skips records with null functionId, relType, or resourceId', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                // Missing relType — should be skipped
                makeRecord({ filePath: 'src/A.ts', functionId: 'cr:fn:A', functionName: 'fn', relType: null, resourceId: 'cr:x', resourceName: 'x', resourceLabels: [] }),
                // Missing resourceId — should be skipped
                makeRecord({ filePath: 'src/A.ts', functionId: 'cr:fn:B', functionName: 'fn', relType: 'WRITES', resourceId: null, resourceName: null, resourceLabels: [] }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const snapshot = result.get('src/A.ts')!;
        expect(snapshot.edges).toHaveLength(0);
        expect(snapshot.nodes).toHaveLength(0);
    });

    it('deduplicates resource nodes across multiple edges', async () => {
        const shared = { resourceId: 'cr:broker:orders', resourceName: 'orders', resourceLabels: ['MessageChannel'] };
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({ filePath: 'src/A.ts', functionId: 'cr:fn:A::fn1', functionName: 'fn1', relType: 'PUBLISHES_TO', ...shared }),
                makeRecord({ filePath: 'src/A.ts', functionId: 'cr:fn:A::fn2', functionName: 'fn2', relType: 'PUBLISHES_TO', ...shared }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const snapshot = result.get('src/A.ts')!;

        expect(snapshot.edges).toHaveLength(2);
        expect(snapshot.nodes).toHaveLength(1); // deduplicated
    });

    it('resolves node type with priority order (MessageChannel > DataContainer > ...)', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'src/A.ts',
                    functionId: 'cr:fn:A',
                    functionName: 'fn',
                    relType: 'WRITES',
                    resourceId: 'cr:datacontainer:t1',
                    resourceName: 't1',
                    resourceLabels: ['LogicalResource', 'DataContainer', 'SomeOtherLabel'],
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const snapshot = result.get('src/A.ts')!;
        expect(snapshot.nodes[0].type).toBe('DataContainer');
        expect(snapshot.edges[0].targetType).toBe('DataContainer');
    });

    it('uses fallback label when no known type matches', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'src/A.ts',
                    functionId: 'cr:fn:A',
                    functionName: 'fn',
                    relType: 'CONNECTS_TO',
                    resourceId: 'cr:x:y',
                    resourceName: 'y',
                    resourceLabels: ['CustomLabel'],
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const snapshot = result.get('src/A.ts')!;
        expect(snapshot.nodes[0].type).toBe('CustomLabel');
    });

    it('uses Unknown type when labels array is null', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'src/A.ts',
                    functionId: 'cr:fn:A',
                    functionName: 'fn',
                    relType: 'WRITES',
                    resourceId: 'cr:x',
                    resourceName: 'x',
                    resourceLabels: null,
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        expect(result.get('src/A.ts')!.nodes[0].type).toBe('Unknown');
    });

    it('groups records correctly when multiple files are queried together', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({ filePath: 'src/A.ts', functionId: 'cr:fn:A', functionName: 'fnA', relType: 'WRITES', resourceId: 'cr:dt:t1', resourceName: 't1', resourceLabels: ['DataContainer'] }),
                makeRecord({ filePath: 'src/B.ts', functionId: 'cr:fn:B', functionName: 'fnB', relType: 'READS', resourceId: 'cr:dt:t2', resourceName: 't2', resourceLabels: ['DataContainer'] }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts', 'src/B.ts']);

        expect(result.get('src/A.ts')!.edges[0].relType).toBe('WRITES');
        expect(result.get('src/B.ts')!.edges[0].relType).toBe('READS');
    });

    it('drops duplicate non-route IMPLEMENTS_ENDPOINT edges when a route handler owns the same endpoint', async () => {
        const endpoint = {
            resourceId: 'cr:endpoint:unknown/app:openapi.yml:POST:/quote',
            resourceName: '/quote',
            resourceLabels: ['APIEndpoint'],
        };
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'www/index.php',
                    functionId: 'cr:fn:index-main',
                    functionName: 'index::main',
                    relType: 'IMPLEMENTS_ENDPOINT',
                    ...endpoint,
                }),
                makeRecord({
                    filePath: 'www/index.php',
                    functionId: 'cr:fn:route-quote',
                    functionName: 'POST /quote::__route_handler',
                    relType: 'IMPLEMENTS_ENDPOINT',
                    ...endpoint,
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['www/index.php']);
        const edges = result.get('www/index.php')!.edges;

        expect(edges).toHaveLength(1);
        expect(edges[0].sourceName).toBe('POST /quote::__route_handler');
    });

    it('closes the session on success', async () => {
        mockSession.run.mockResolvedValue({ records: [] });
        await fetchFileTopologySnapshots(['src/A.ts']);
        expect(mockSession.close).toHaveBeenCalledOnce();
    });

    it('closes the session on error', async () => {
        mockSession.run.mockRejectedValue(new Error('Bolt connection lost'));
        await expect(fetchFileTopologySnapshots(['src/A.ts'])).rejects.toThrow('Bolt connection lost');
        expect(mockSession.close).toHaveBeenCalledOnce();
    });

    it('uses functionId as fallback when functionName is null', async () => {
        mockSession.run.mockResolvedValue({
            records: [
                makeRecord({
                    filePath: 'src/A.ts',
                    functionId: 'cr:fn:A::pub',
                    functionName: null,
                    relType: 'PUBLISHES_TO',
                    resourceId: 'cr:broker:q1',
                    resourceName: 'q1',
                    resourceLabels: ['MessageChannel'],
                }),
            ],
        });

        const result = await fetchFileTopologySnapshots(['src/A.ts']);
        const edge = result.get('src/A.ts')!.edges[0];
        expect(edge.sourceName).toBe('cr:fn:A::pub');
    });
});
