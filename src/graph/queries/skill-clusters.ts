/**
 * Cross-repo skill duplication clustering.
 *
 * Pure transforms over the output of `querySemanticDuplicates`:
 *   - `buildSkillClusters`  Union-Find over pair list, returns enriched clusters.
 *   - `computeSkillProjection`  UMAP (or PCA fallback for tiny inputs) into [0,1]^2
 *     so the dashboard can render a 2D constellation without re-doing the math
 *     in the browser.
 *
 * The DB/Cypher layer stays out of this module: callers feed in plain pairs +
 * a members map, which keeps the logic trivially unit-testable.
 */

// Pulled from umap-js at call time (avoids loading native-ish init cost when the
// caller has no points to project).

export interface SkillClusterPair {
    /** Identifier of the first config in the pair (canonical AgenticConfig URN). */
    a: string;
    /** Identifier of the second config in the pair. */
    b: string;
    /** Cosine similarity in [0,1] returned by the vector index. */
    similarity: number;
}

export interface SkillMemberView {
    configId: string;
    name: string;
    description: string;
    semanticIntent?: string;
    filePath: string;
    service: string;
    topics: string[];
    technologies: string[];
    /** Per-member similarity: best match against any other member in the cluster. */
    peerSimilarity?: number;
    sourceUrl?: string;
    symlinkTarget?: string;
    installedVia?: string;
    /** Content hash; used to collapse harness-dir copies of one skill in a service. */
    contentFingerprint?: string;
}

export interface SkillDuplicateCluster {
    id: string;                                  // cluster-1, cluster-2, ...
    label: string;                               // dominant topic or first member name
    memberIds: string[];
    members: SkillMemberView[];
    size: number;
    similarity: { min: number; max: number; avg: number };
    services: string[];
    topics: string[];
    technologies: string[];
}

export interface SkillEmbeddingInput {
    configId: string;
    vector: number[];
    clusterId: string | null;
}

export interface SkillProjectionPoint {
    configId: string;
    x: number;       // [0,1]
    y: number;       // [0,1]
    clusterId: string | null;
}

// ─── Same-service collapse (logical-skill identity) ──────────────────────────

/**
 * Collapse content-identical copies of one skill within a single service to a
 * single canonical node. The cross-repo twin filter (`serviceA <> serviceB`)
 * drops the direct same-service pair, but union-find re-introduces both copies
 * through their cross-service twins, so a skill installed in two harness dirs of
 * one service (`.agents` + `.claude`, often a symlink) would appear twice in the
 * cluster. Identity key is `(service, contentFingerprint)`: copies sharing both
 * are one logical install. Canonical preference: a non-symlink over a symlink,
 * then the lexically-smallest configId for determinism. A member with no
 * fingerprint keys on its own configId, so it never collapses with another.
 */
export function buildCanonicalSkillMap(members: Map<string, SkillMemberView>): Map<string, string> {
    const byKey = new Map<string, SkillMemberView[]>();
    for (const m of members.values()) {
        const key = `${m.service}\u0000${m.contentFingerprint ?? m.configId}`;
        let group = byKey.get(key);
        if (!group) { group = []; byKey.set(key, group); }
        group.push(m);
    }
    const canonical = new Map<string, string>();
    for (const group of byKey.values()) {
        const rep = [...group].sort(compareSkillCanonical)[0];
        for (const m of group) canonical.set(m.configId, rep.configId);
    }
    return canonical;
}

function compareSkillCanonical(a: SkillMemberView, b: SkillMemberView): number {
    const aSym = a.installedVia === 'symlink' ? 1 : 0;
    const bSym = b.installedVia === 'symlink' ? 1 : 0;
    if (aSym !== bSym) return aSym - bSym; // non-symlink first
    return a.configId < b.configId ? -1 : a.configId > b.configId ? 1 : 0;
}

/**
 * Rewrite pair endpoints to their canonical node, drop self-pairs produced by
 * the collapse, and dedupe — keeping the highest similarity per canonical pair.
 */
export function canonicalizeSkillPairs(
    pairs: SkillClusterPair[],
    canonical: Map<string, string>,
): SkillClusterPair[] {
    const best = new Map<string, SkillClusterPair>();
    for (const p of pairs) {
        const a = canonical.get(p.a) ?? p.a;
        const b = canonical.get(p.b) ?? p.b;
        if (a === b) continue; // both copies of one logical skill
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const key = `${lo}\u0000${hi}`;
        const prev = best.get(key);
        if (!prev || p.similarity > prev.similarity) best.set(key, { a: lo, b: hi, similarity: p.similarity });
    }
    return [...best.values()];
}

// ─── Cluster builder (Union-Find) ────────────────────────────────────────────

class DSU {
    private parent = new Map<string, string>();
    private rank = new Map<string, number>();

    add(id: string): void {
        if (this.parent.has(id)) return;
        this.parent.set(id, id);
        this.rank.set(id, 0);
    }

    find(id: string): string {
        let cur = this.parent.get(id);
        if (cur === undefined) {
            this.add(id);
            return id;
        }
        // path compression
        while (cur !== this.parent.get(cur)) {
            const next = this.parent.get(cur)!;
            this.parent.set(cur, this.parent.get(next)!);
            cur = this.parent.get(cur)!;
        }
        return cur;
    }

    union(a: string, b: string): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return;
        const rankA = this.rank.get(ra)!;
        const rankB = this.rank.get(rb)!;
        if (rankA < rankB) this.parent.set(ra, rb);
        else if (rankA > rankB) this.parent.set(rb, ra);
        else {
            this.parent.set(rb, ra);
            this.rank.set(ra, rankA + 1);
        }
    }
}

export function buildSkillClusters(
    pairs: SkillClusterPair[],
    members: Map<string, SkillMemberView>,
): SkillDuplicateCluster[] {
    if (pairs.length === 0) return [];

    // Filter out pairs whose members are not in the supplied map. This is the
    // defensive path for stale URNs (skill deleted between query and enrichment).
    const validPairs = pairs.filter(p => members.has(p.a) && members.has(p.b));
    if (validPairs.length === 0) return [];

    const dsu = new DSU();
    for (const p of validPairs) {
        dsu.add(p.a);
        dsu.add(p.b);
        dsu.union(p.a, p.b);
    }

    // Group members by root, and collect intra-cluster similarity values.
    const groups = new Map<string, { ids: Set<string>; sims: number[] }>();
    for (const p of validPairs) {
        const root = dsu.find(p.a);
        let g = groups.get(root);
        if (!g) {
            g = { ids: new Set<string>(), sims: [] };
            groups.set(root, g);
        }
        g.ids.add(p.a);
        g.ids.add(p.b);
        g.sims.push(p.similarity);
    }

    const peerSimMap = new Map<string, number>();
    for (const p of validPairs) {
        peerSimMap.set(p.a, Math.max(peerSimMap.get(p.a) ?? 0, p.similarity));
        peerSimMap.set(p.b, Math.max(peerSimMap.get(p.b) ?? 0, p.similarity));
    }

    const clusters: SkillDuplicateCluster[] = [];
    let n = 0;
    for (const [, group] of groups) {
        const memberList = [...group.ids]
            .map(id => {
                const m = members.get(id)!;
                return { ...m, peerSimilarity: peerSimMap.get(id) };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        const services = uniqSorted(memberList.map(m => m.service));
        const topics = uniqSorted(memberList.flatMap(m => m.topics));
        const technologies = uniqSorted(memberList.flatMap(m => m.technologies));
        const min = Math.min(...group.sims);
        const max = Math.max(...group.sims);
        const avg = group.sims.reduce((s, x) => s + x, 0) / group.sims.length;

        clusters.push({
            id: `cluster-${++n}`,
            label: deriveClusterLabel(memberList, topics),
            memberIds: memberList.map(m => m.configId),
            members: memberList,
            size: memberList.length,
            similarity: { min, max, avg },
            services,
            topics,
            technologies,
        });
    }

    // Sort: size desc, then avg similarity desc (for ties).
    clusters.sort((a, b) => {
        if (b.size !== a.size) return b.size - a.size;
        return b.similarity.avg - a.similarity.avg;
    });

    return clusters;
}

function deriveClusterLabel(members: SkillMemberView[], topics: string[]): string {
    // 1. Most-common skill name (mode) is the strongest distinctive signal:
    //    near-duplicate skills almost always share the same name across repos
    //    (`jira-branch-changeset`, `create-jira-ticket`, ...). Tie-break by
    //    alphabetical order for determinism.
    const nameCounts = new Map<string, number>();
    for (const m of members) {
        if (!m.name) continue;
        nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
    }
    if (nameCounts.size > 0) {
        let bestName: string | null = null;
        let bestCount = -1;
        for (const [n, c] of nameCounts) {
            if (c > bestCount || (c === bestCount && (bestName === null || n < bestName))) {
                bestName = n;
                bestCount = c;
            }
        }
        if (bestName) return bestName;
    }

    // 2. Majority topic across members — used when names disagree completely.
    if (topics.length > 0) {
        const topicCounts = new Map<string, number>();
        for (const m of members) {
            for (const t of m.topics) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
        }
        let bestTopic: string | null = null;
        let bestTopicCount = -1;
        for (const [t, c] of topicCounts) {
            if (c > bestTopicCount || (c === bestTopicCount && (bestTopic === null || t < bestTopic))) {
                bestTopic = t;
                bestTopicCount = c;
            }
        }
        if (bestTopic) return bestTopic;
    }

    return 'Untitled cluster';
}

function uniqSorted(xs: string[]): string[] {
    return [...new Set(xs.filter(Boolean))].sort();
}

// ─── 2D Projection (UMAP + PCA fallback) ─────────────────────────────────────

const UMAP_MIN_POINTS = 5;

export async function computeSkillProjection(
    points: SkillEmbeddingInput[],
): Promise<SkillProjectionPoint[]> {
    if (points.length === 0) return [];
    if (points.length === 1) {
        return [{ configId: points[0].configId, x: 0.5, y: 0.5, clusterId: points[0].clusterId }];
    }
    if (points.length === 2) {
        return [
            { configId: points[0].configId, x: 0, y: 0.5, clusterId: points[0].clusterId },
            { configId: points[1].configId, x: 1, y: 0.5, clusterId: points[1].clusterId },
        ];
    }

    let coords: number[][];
    if (points.length < UMAP_MIN_POINTS) {
        coords = pcaProject(points.map(p => p.vector));
    } else {
        coords = await umapProject(points.map(p => p.vector));
    }

    const normalised = normaliseTo01(coords);
    return points.map((p, i) => ({
        configId: p.configId,
        x: normalised[i][0],
        y: normalised[i][1],
        clusterId: p.clusterId,
    }));
}

async function umapProject(vectors: number[][]): Promise<number[][]> {
    const { UMAP } = await import('umap-js');
    // Seedable RNG for stable layouts across re-runs of the same ingestion.
    const rng = mulberry32(0xC0DE);
    const u = new UMAP({
        nComponents: 2,
        nNeighbors: Math.min(15, Math.max(2, vectors.length - 1)),
        minDist: 0.1,
        random: rng,
    });
    return u.fit(vectors);
}

function pcaProject(vectors: number[][]): number[][] {
    // Lightweight PCA via power iteration on the covariance matrix. Used only for
    // <5 points where UMAP doesn't have enough neighbours to be meaningful.
    const n = vectors.length;
    const d = vectors[0].length;
    const mean = new Array(d).fill(0);
    for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
    const centred = vectors.map(v => v.map((x, i) => x - mean[i]));

    // Top-1 principal direction by power iteration on X^T X (implicit, via centred).
    const seedRng = mulberry32(0xBEEF);
    let dir = seedDirection(d, seedRng);
    for (let iter = 0; iter < 32; iter++) {
        const next = new Array(d).fill(0);
        for (const v of centred) {
            const dot = v.reduce((s, x, i) => s + x * dir[i], 0);
            for (let i = 0; i < d; i++) next[i] += v[i] * dot;
        }
        const norm = Math.hypot(...next);
        if (norm < 1e-12) break;
        dir = next.map(x => x / norm);
    }

    // Top-2: deflate first component, repeat.
    const dir2 = seedDirection(d, mulberry32(0xFADE));
    let dir2Cur = dir2;
    for (let iter = 0; iter < 32; iter++) {
        // Orthogonalise vs dir.
        const proj = dir2Cur.reduce((s, x, i) => s + x * dir[i], 0);
        dir2Cur = dir2Cur.map((x, i) => x - proj * dir[i]);
        const norm0 = Math.hypot(...dir2Cur);
        if (norm0 < 1e-12) { dir2Cur = seedDirection(d, mulberry32(iter + 0xDEAD)); continue; }
        dir2Cur = dir2Cur.map(x => x / norm0);

        const next = new Array(d).fill(0);
        for (const v of centred) {
            const dot = v.reduce((s, x, i) => s + x * dir2Cur[i], 0);
            for (let i = 0; i < d; i++) next[i] += v[i] * dot;
        }
        const norm = Math.hypot(...next);
        if (norm < 1e-12) break;
        dir2Cur = next.map(x => x / norm);
    }

    return centred.map(v => [
        v.reduce((s, x, i) => s + x * dir[i], 0),
        v.reduce((s, x, i) => s + x * dir2Cur[i], 0),
    ]);
}

function seedDirection(d: number, rng: () => number): number[] {
    const v = Array.from({ length: d }, () => rng() - 0.5);
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
}

function normaliseTo01(coords: number[][]): number[][] {
    if (coords.length === 0) return [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    return coords.map(([x, y]) => [(x - minX) / spanX, (y - minY) / spanY]);
}

// deterministic prng — seedable, stable across runs.
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
