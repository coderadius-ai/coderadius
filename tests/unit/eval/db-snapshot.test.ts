import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the underlying snapshot query — this is what db-snapshot.ts calls
vi.mock('../../../src/graph/queries/eval-snapshot.js', () => ({
    fetchFileTopologySnapshots: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { fetchFileTopologySnapshots } from '../../../src/graph/queries/eval-snapshot.js';
import { fetchDbSnapshot } from '../../../src/eval/db-snapshot.js';
import type { FileTopologySnapshot } from '../../../src/eval/types.js';

const mockFetchSnapshots = fetchFileTopologySnapshots as ReturnType<typeof vi.fn>;

function makeSnapshot(filePath: string, edgeCount = 0, nodeCount = 0): FileTopologySnapshot {
    const edges = Array.from({ length: edgeCount }, (_, i) => ({
        sourceId: `cr:fn:${i}`,
        sourceName: `fn${i}`,
        targetId: `cr:broker:q${i}`,
        targetName: `q${i}`,
        relType: 'PUBLISHES_TO',
        sourceFile: filePath,
        targetType: 'MessageChannel',
    }));
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({
        id: `cr:broker:q${i}`,
        type: 'MessageChannel',
        name: `q${i}`,
        sourceFile: filePath,
    }));
    return { filePath, edges, nodes };
}

// ─── fetchDbSnapshot ──────────────────────────────────────────────────────────

describe('fetchDbSnapshot', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty result for empty file list', async () => {
        mockFetchSnapshots.mockResolvedValue(new Map());

        const result = await fetchDbSnapshot([]);
        expect(result.knownFiles).toHaveLength(0);
        expect(result.unknownFiles).toHaveLength(0);
        expect(result.snapshots.size).toBe(0);
    });

    it('classifies file with edges as known', async () => {
        const snapshot = makeSnapshot('src/A.ts', 2, 1);
        mockFetchSnapshots.mockResolvedValue(new Map([['src/A.ts', snapshot]]));

        const result = await fetchDbSnapshot(['src/A.ts']);
        expect(result.knownFiles).toContain('src/A.ts');
        expect(result.unknownFiles).not.toContain('src/A.ts');
    });

    it('classifies file with no topology as unknown (new file)', async () => {
        const emptySnapshot = makeSnapshot('src/New.ts', 0, 0);
        mockFetchSnapshots.mockResolvedValue(new Map([['src/New.ts', emptySnapshot]]));

        const result = await fetchDbSnapshot(['src/New.ts']);
        expect(result.unknownFiles).toContain('src/New.ts');
        expect(result.knownFiles).not.toContain('src/New.ts');
    });

    it('classifies file with nodes but no edges as known', async () => {
        const snapshot = makeSnapshot('src/A.ts', 0, 1); // nodes but no edges
        mockFetchSnapshots.mockResolvedValue(new Map([['src/A.ts', snapshot]]));

        const result = await fetchDbSnapshot(['src/A.ts']);
        expect(result.knownFiles).toContain('src/A.ts');
    });

    it('handles mix of known and unknown files correctly', async () => {
        mockFetchSnapshots.mockResolvedValue(new Map([
            ['src/Known.ts', makeSnapshot('src/Known.ts', 1, 1)],
            ['src/New.ts',   makeSnapshot('src/New.ts', 0, 0)],
        ]));

        const result = await fetchDbSnapshot(['src/Known.ts', 'src/New.ts']);
        expect(result.knownFiles).toEqual(['src/Known.ts']);
        expect(result.unknownFiles).toEqual(['src/New.ts']);
    });

    it('returns the raw snapshots map from the underlying query', async () => {
        const snapshot = makeSnapshot('src/A.ts', 3, 2);
        mockFetchSnapshots.mockResolvedValue(new Map([['src/A.ts', snapshot]]));

        const result = await fetchDbSnapshot(['src/A.ts']);
        expect(result.snapshots.get('src/A.ts')).toBe(snapshot);
    });

    it('propagates errors from the underlying snapshot query', async () => {
        mockFetchSnapshots.mockRejectedValue(new Error('Memgraph timeout'));
        await expect(fetchDbSnapshot(['src/A.ts'])).rejects.toThrow('Memgraph timeout');
    });

    it('passes the changedFiles list directly to fetchFileTopologySnapshots', async () => {
        mockFetchSnapshots.mockResolvedValue(new Map());
        const files = ['src/A.ts', 'src/B.php'];

        await fetchDbSnapshot(files);
        expect(mockFetchSnapshots).toHaveBeenCalledWith(files);
    });
});
