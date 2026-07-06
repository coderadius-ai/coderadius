import { describe, it, expect } from 'vitest';
import {
    computeSkillProjection,
    type SkillEmbeddingInput,
} from '../../../../src/graph/queries/skill-clusters.js';

function mkInput(id: string, vector: number[], clusterId: string | null = null): SkillEmbeddingInput {
    return { configId: id, vector, clusterId };
}

describe('computeSkillProjection', () => {
    it('returns [] for empty input', async () => {
        const out = await computeSkillProjection([]);
        expect(out).toEqual([]);
    });

    it('places a single point at the canvas center', async () => {
        const out = await computeSkillProjection([mkInput('A', [1, 0, 0])]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ configId: 'A', x: 0.5, y: 0.5, clusterId: null });
    });

    it('PCA fallback places two points symmetrically on the X axis', async () => {
        const out = await computeSkillProjection([
            mkInput('A', [1, 0, 0]),
            mkInput('B', [0, 1, 0]),
        ]);
        expect(out).toHaveLength(2);
        const xs = out.map(p => p.x).sort((a, b) => a - b);
        // Two points should sit at x≈0 and x≈1 (or some normalised opposite ends),
        // both at y≈0.5 in the trivial 2-point fallback.
        expect(xs[0]).toBeCloseTo(0);
        expect(xs[1]).toBeCloseTo(1);
        for (const p of out) expect(p.y).toBeCloseTo(0.5);
    });

    it('normalises all projected coordinates into [0,1]^2 for larger inputs', async () => {
        const rng = mulberry32(42);
        const inputs: SkillEmbeddingInput[] = Array.from({ length: 10 }, (_, i) => ({
            configId: `pt-${i}`,
            vector: Array.from({ length: 8 }, () => rng() * 2 - 1),
            clusterId: i < 5 ? 'cluster-1' : 'cluster-2',
        }));
        const out = await computeSkillProjection(inputs);
        expect(out).toHaveLength(10);
        for (const p of out) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(1);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(1);
        }
    });

    it('preserves clusterId on each output point', async () => {
        const out = await computeSkillProjection([
            mkInput('A', [1, 0, 0], 'cluster-x'),
            mkInput('B', [0, 1, 0], 'cluster-y'),
            mkInput('C', [0, 0, 1], null),
        ]);
        const byId = new Map(out.map(p => [p.configId, p]));
        expect(byId.get('A')?.clusterId).toBe('cluster-x');
        expect(byId.get('B')?.clusterId).toBe('cluster-y');
        expect(byId.get('C')?.clusterId).toBeNull();
    });
});

// deterministic prng for stable test inputs
function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}
