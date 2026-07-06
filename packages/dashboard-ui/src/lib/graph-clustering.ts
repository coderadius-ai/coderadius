/**
 * Cluster engine for the Blast Radius graph view.
 *
 * Collapses architecturally-equivalent sibling nodes (same nodeType, same
 * edge kinds, same neighbor set, same name family, same column) into a
 * single "supernode" rendered as a stacked-deck card. Cuts visual noise on
 * services that fan out to dozens of similar endpoints / tables / channels.
 *
 * Confidence aggregation is intentionally asymmetric:
 *   - Cluster confidence  = min(member.confidence)   — "weakest link"
 *   - Cluster edge conf   = max(constituent.conf)    — "best signal"
 * The first communicates "you should mistrust this group as much as its most
 * fragile member"; the second avoids artificially dimming a real connection
 * just because one of N parallel edges is weakly evidenced.
 */

import type { TopologyNode } from '@coderadius/shared-types';
import type { GraphNode, GraphEdge, NodeCluster, GraphNodeOrCluster } from '../components/blast-radius/types';

export interface ClusterSignature {
    /** Always non-zero — never cluster the pivot (tier 0, col 0). */
    col: number;
    nodeType: string;
    /** Sorted edge `rel` set joined with `|`, e.g. `"READS|WRITES"`. */
    edgeKinds: string;
    /** Sorted set of directly-connected URNs joined with `|`. */
    neighborUrns: string;
    /** Name-family bucket — see `nameFamily()`. */
    nameFamily: string;
}

interface ClusterOptions {
    enabled: boolean;
    /** Minimum members for a bucket to actually become a cluster (default 4). */
    minSize: number;
    /** Cluster signatures the user has explicitly expanded — render members instead. */
    expandedSignatures?: Set<string>;
}

export interface ClusterResult {
    nodes: GraphNodeOrCluster[];
    edges: GraphEdge[];
    /** URNs of nodes that got absorbed into a cluster (so callers can hide them in lookups). */
    collapsedUrns: Set<string>;
    /**
     * Map from member URN → cluster id, so callers can light up the supernode
     * when the user hovers / pins an individual member URN elsewhere (e.g. in
     * the sidebar list, which keeps showing individual items).
     */
    memberToClusterId: Map<string, string>;
}

/**
 * Heuristic name-family extractor. Buckets by, in order:
 *   1. URL path: `/api/v2/bike/equipments`       → `/api/v2/bike`
 *      Also handles a leading HTTP-method prefix:
 *        `GET /api/v2/bike/equipments`           → `/api/v2/bike`
 *      (REST endpoints surface as `${method} ${path}` in TopologyNode.name.)
 *   2. dot.path: `message_bus.transport.acme.*`  → `message_bus`  (the whole
 *                first dot-segment, even if it contains underscores — these
 *                are typically broker/topic names where the dot is the real
 *                hierarchy and the underscore is part of the segment label)
 *   3. snake_case: `quote_books`                 → `quote`
 *   4. Fallback to `node.type` so the bucket is never empty.
 */
const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|GRAPHQL|GRPC|WS|WSS)\s+/i;

export function nameFamily(node: TopologyNode): string {
    // DataContainer (tables) with a known parent Datastore ALWAYS cluster by
    // that datastore — name-family heuristics don't apply. The user's mental
    // model: tables in `acme_main_db` belong together regardless of whether
    // they read as `users` / `orders` / `quote_items` / etc.
    if (node.type === 'DataContainer' && node.datastore?.[0]?.name) {
        return `db:${node.datastore[0].name}`;
    }
    let n = node.name;
    // Strip HTTP/RPC method prefix so REST endpoint names cluster by path.
    const m = n.match(HTTP_METHOD_PREFIX);
    if (m) n = n.slice(m[0].length);

    if (n.startsWith('/')) {
        const segs = n.split('/').filter(Boolean);
        if (segs.length >= 3) return '/' + segs.slice(0, 3).join('/');
        return '/' + segs.join('/');
    }
    if (n.includes('.')) return n.split('.')[0];
    if (n.includes('_')) return n.split('_')[0];
    return node.type;
}

/** Logical-database fallback family for storage-shaped nodes
 *  (DataContainer / Datastore). Returns `db:<datastore-name>` when the
 *  node knows which physical store it lives in, otherwise null.
 *
 *  Used as a SECOND-PASS bucket key: any name-based bucket that comes
 *  in under threshold is re-routed here so tables in the same database
 *  cluster together even when their names don't share a family. */
export function dbFamily(node: TopologyNode): string | null {
    if ((node.type === 'DataContainer' || node.type === 'Datastore') && node.datastore?.[0]?.name) {
        return `db:${node.datastore[0].name}`;
    }
    return null;
}

/** Every `db:<name>` family a DataContainer belongs to. One per STORED_IN
 *  datastore, deduped, primary (datastore[0]) first. A container bound to a
 *  single store yields one family; an ambiguous multi-candidate bind yields one
 *  per candidate so the container surfaces in each store's cluster. Empty for
 *  non-DataContainers or containers with no datastore. */
export function datastoreFamilies(node: TopologyNode): string[] {
    if (node.type !== 'DataContainer' || !node.datastore?.length) return [];
    const seen = new Set<string>();
    const families: string[] = [];
    for (const d of node.datastore) {
        const family = `db:${d.name}`;
        if (seen.has(family)) continue;
        seen.add(family);
        families.push(family);
    }
    return families;
}

/** Title-case a token: `quote` → `Quote`; paths show their last segment. */
function humanFamily(family: string): string {
    if (family.startsWith('/')) {
        const last = family.split('/').filter(Boolean).pop() ?? family;
        return last.charAt(0).toUpperCase() + last.slice(1);
    }
    if (!family) return '';
    return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Pluralise common architectural type labels: `DataContainer` → `Data Containers`. */
function pluralType(t: string): string {
    const map: Record<string, string> = {
        DataContainer: 'Data Containers',
        APIEndpoint: 'API Endpoints',
        MessageChannel: 'Message Channels',
        Datastore: 'Datastores',
        Service: 'Services',
        Package: 'Packages',
        SystemProcess: 'System Processes',
    };
    return map[t] ?? `${t}s`;
}

function signatureKey(sig: ClusterSignature): string {
    return `${sig.col}|${sig.nodeType}|${sig.edgeKinds}|${sig.neighborUrns}|${sig.nameFamily}`;
}

/**
 * Main entry. Takes the unclustered set of `GraphNode` + `GraphEdge` and
 * returns:
 *   - a new `nodes` array where eligible siblings collapsed into clusters,
 *   - a new `edges` array with member endpoints redirected to the cluster id,
 *   - bookkeeping sets/maps for downstream highlighting.
 *
 * The pivot (tier 0) is never clustered. Clusters whose `signatureKey` is in
 * `options.expandedSignatures` are returned verbatim (members + their original
 * edges) so the user can drill in cluster-by-cluster.
 */
export function clusterGraphNodes(
    inputNodes: GraphNode[],
    inputEdges: GraphEdge[],
    options: ClusterOptions,
): ClusterResult {
    if (!options.enabled) {
        return {
            nodes: inputNodes,
            edges: inputEdges,
            collapsedUrns: new Set<string>(),
            memberToClusterId: new Map<string, string>(),
        };
    }
    const minSize = Math.max(2, options.minSize);
    const expanded = options.expandedSignatures ?? new Set<string>();

    // Index neighbors per node so the signature can read them in O(1) per member.
    const neighborsByUrn = new Map<string, Set<string>>();
    const edgeKindsByUrn = new Map<string, Set<string>>();
    const edgesByUrn = new Map<string, GraphEdge[]>();
    for (const e of inputEdges) {
        if (!neighborsByUrn.has(e.source)) neighborsByUrn.set(e.source, new Set());
        if (!neighborsByUrn.has(e.target)) neighborsByUrn.set(e.target, new Set());
        neighborsByUrn.get(e.source)!.add(e.target);
        neighborsByUrn.get(e.target)!.add(e.source);
        if (!edgeKindsByUrn.has(e.source)) edgeKindsByUrn.set(e.source, new Set());
        if (!edgeKindsByUrn.has(e.target)) edgeKindsByUrn.set(e.target, new Set());
        edgeKindsByUrn.get(e.source)!.add(e.rel);
        edgeKindsByUrn.get(e.target)!.add(e.rel);
        if (!edgesByUrn.has(e.source)) edgesByUrn.set(e.source, []);
        if (!edgesByUrn.has(e.target)) edgesByUrn.set(e.target, []);
        edgesByUrn.get(e.source)!.push(e);
        edgesByUrn.get(e.target)!.push(e);
    }

    // Group eligible (non-pivot) nodes by signature. `datastoreFamilies` routes
    // a DataContainer into one `db:<name>` bucket per STORED_IN datastore; a
    // container with an ambiguous multi-candidate bind therefore joins every
    // candidate store's bucket. The first family is the PRIMARY placement (owns
    // the node's edges); the rest are co-candidate placements (display-only).
    const buckets = new Map<string, { sig: ClusterSignature; members: GraphNode[]; primaryUrns: Set<string> }>();
    const pivotsAndUngrouped: GraphNode[] = [];

    for (const n of inputNodes) {
        if (n.tier === 0) {
            pivotsAndUngrouped.push(n);
            continue;
        }
        const neighbors = neighborsByUrn.get(n.urn);
        const kinds = edgeKindsByUrn.get(n.urn);
        if (!neighbors || !kinds) {
            pivotsAndUngrouped.push(n);
            continue;
        }
        const dbFamilies = datastoreFamilies(n.node);
        const families = dbFamilies.length > 0 ? dbFamilies : [nameFamily(n.node)];
        families.forEach((family, familyIdx) => {
            // DB-bucketed DataContainers: the user's rule is "all tables of the
            // same datastore in ONE card, no other discriminator applies". So we
            // collapse the signature to just `db:<name>` — same column, sure,
            // but ignore edgeKinds/neighborUrns so a table that's only WRITTEN
            // and a table that's only READ still merge if they live in the same
            // datastore.
            const isDbBucket = family.startsWith('db:');
            const sig: ClusterSignature = {
                col: n.col,
                nodeType: n.node.type,
                edgeKinds: isDbBucket ? '' : Array.from(kinds).sort().join('|'),
                neighborUrns: isDbBucket ? '' : Array.from(neighbors).sort().join('|'),
                nameFamily: family,
            };
            const key = signatureKey(sig);
            if (!buckets.has(key)) buckets.set(key, { sig, members: [], primaryUrns: new Set<string>() });
            const bucket = buckets.get(key)!;
            bucket.members.push(n);
            if (familyIdx === 0) bucket.primaryUrns.add(n.urn);
        });
    }

    const outNodes: GraphNodeOrCluster[] = [...pivotsAndUngrouped];
    const collapsedUrns = new Set<string>();
    const memberToClusterId = new Map<string, string>();

    // Pass 1 — decide which buckets collapse BEFORE emitting anything. With
    // multi-datastore membership a node can land in a collapsing bucket AND a
    // non-collapsing one; deciding first lets pass 2 skip emitting such a node
    // standalone when it is already absorbed into a cluster. DB-bucketed
    // clusters use a lower threshold (2): "all tables of the same datastore in
    // one card", even when the datastore owns only 2 reachable tables. They
    // ALSO collapse at size 1 when every member is a co-candidate (secondary)
    // placement — a co-store of an ambiguous bind earns its own card even with
    // a single table, so the store stays visible.
    const willCollapse = new Set<string>();
    for (const [sigKey, { sig, members, primaryUrns }] of buckets.entries()) {
        if (expanded.has(sigKey)) continue;
        const isDb = sig.nameFamily.startsWith('db:');
        const bucketMin = isDb ? 2 : minSize;
        const allSecondary = isDb && members.every(m => !primaryUrns.has(m.urn));
        if (members.length >= bucketMin || (allSecondary && members.length >= 1)) {
            willCollapse.add(sigKey);
            for (const m of members) collapsedUrns.add(m.urn);
        }
    }

    // Pass 2 — build a NodeCluster from each collapsing bucket; emit the rest
    // individually, skipping any node already absorbed into a cluster (it would
    // render twice) or already emitted standalone via another of its buckets.
    const standaloneEmitted = new Set<string>();
    for (const [sigKey, { sig, members, primaryUrns }] of buckets.entries()) {
        if (!willCollapse.has(sigKey)) {
            for (const m of members) {
                if (collapsedUrns.has(m.urn) || standaloneEmitted.has(m.urn)) continue;
                standaloneEmitted.add(m.urn);
                outNodes.push(m);
            }
            continue;
        }

        const sortedMembers = [...members].sort((a, b) => a.node.name.localeCompare(b.node.name));
        const examples = sortedMembers.slice(0, 3).map(m => m.node.name);

        const relSet = new Set<string>();
        for (const m of sortedMembers) {
            const ks = edgeKindsByUrn.get(m.urn);
            if (ks) for (const k of ks) relSet.add(k);
        }

        // min(member.confidence) — see header docstring.
        let minConf: number | undefined;
        for (const m of sortedMembers) {
            const c = m.confidence ?? m.node.confidence;
            if (typeof c !== 'number') continue;
            minConf = minConf === undefined ? c : Math.min(minConf, c);
        }

        // Cluster card sizing follows the tier of the densest member. They're
        // all in the same column so they share `tier`/`direction`/`col`.
        const first = sortedMembers[0];

        // Shared technology: only when every member declares the same value.
        // A single divergent member resets to undefined — never lie about
        // homogeneity that isn't there.
        let sharedTech: string | undefined;
        let techHomogeneous = true;
        for (const m of sortedMembers) {
            const t = m.node.technology ?? undefined;
            if (sharedTech === undefined) sharedTech = t;
            else if (t !== sharedTech) { techHomogeneous = false; break; }
        }
        const technology = techHomogeneous ? sharedTech : undefined;

        // Datastore name: for a db-bucket it is the bucket's own store, read
        // straight from the `db:<name>` signature. Uniform by construction,
        // including the co-candidate card of an ambiguous bind whose members
        // each list this store among several. Non-db buckets carry no store.
        const isDbFallback = sig.nameFamily.startsWith('db:');
        const datastoreName = isDbFallback ? sig.nameFamily.slice(3) : undefined;

        // Build a clean label. The count is rendered separately as the `× N`
        // pill on the card's right edge, so it must NOT appear in the label
        // text, otherwise the user sees "6 Order Message Channels   × 6".
        // - `db:foo` family → "Data Containers" (the db name surfaces in the
        //   meta strip below).
        // - `node.type` fallback → drop the redundant family chunk to avoid
        //   "APIEndpoint API Endpoints".
        // - Otherwise → "{Family} {PluralType}" (e.g. "Order Message Channels").
        const familyText = isDbFallback || sig.nameFamily === sig.nodeType
            ? ''
            : humanFamily(sig.nameFamily);
        const labelParts = [familyText, pluralType(sig.nodeType)].filter(Boolean);
        const cluster: NodeCluster = {
            kind: 'cluster',
            id: `cluster:${sigKey}`,
            tier: first.tier,
            direction: first.direction === 'center' ? 'downstream' : first.direction,
            col: sig.col,
            cardW: first.cardW,
            cardH: first.cardH,
            x: first.x,
            y: first.y,
            members: sortedMembers,
            label: labelParts.join(' '),
            examples,
            rels: Array.from(relSet).sort(),
            nodeType: sig.nodeType,
            confidence: minConf,
            technology,
            datastoreName,
        };
        outNodes.push(cluster);
        for (const m of sortedMembers) {
            // Edges redirect to the PRIMARY cluster: a primary placement sets it
            // unconditionally; a co-candidate placement only as a fallback when
            // the node has no primary cluster (its primary bucket didn't
            // collapse), so a node's edges stay on one card.
            if (primaryUrns.has(m.urn) || !memberToClusterId.has(m.urn)) {
                memberToClusterId.set(m.urn, cluster.id);
            }
        }
    }

    // Rewrite edges: any endpoint that was collapsed becomes the cluster id.
    // Dedupe by (source, target, rel) so a cluster of N nodes all writing to
    // the same parent renders as ONE thick edge, not N parallel ones.
    const seenEdgeKey = new Set<string>();
    const outEdges: GraphEdge[] = [];
    // Track per-collapsed-edge max confidence so the surviving edge stays at
    // the best-evidence stroke.
    const edgeConfidenceMax = new Map<string, number>();
    for (const e of inputEdges) {
        const newSrc = memberToClusterId.get(e.source) ?? e.source;
        const newTgt = memberToClusterId.get(e.target) ?? e.target;
        if (newSrc === newTgt) continue; // self-edge after collapse — drop
        const key = `${newSrc}|${newTgt}|${e.rel}`;
        if (typeof e.confidence === 'number') {
            const prev = edgeConfidenceMax.get(key);
            edgeConfidenceMax.set(key, prev === undefined ? e.confidence : Math.max(prev, e.confidence));
        }
        if (seenEdgeKey.has(key)) continue;
        seenEdgeKey.add(key);
        outEdges.push({
            id: `${newSrc}->${newTgt}:${e.rel}`,
            source: newSrc,
            target: newTgt,
            rel: e.rel,
            confidence: e.confidence,
        });
    }
    // Apply the max-confidence to the surviving edge of each key.
    for (const e of outEdges) {
        const key = `${e.source}|${e.target}|${e.rel}`;
        const max = edgeConfidenceMax.get(key);
        if (max !== undefined) e.confidence = max;
    }

    return { nodes: outNodes, edges: outEdges, collapsedUrns, memberToClusterId };
}

// Re-exports for ergonomics.
export type { GraphNode, GraphEdge, NodeCluster, GraphNodeOrCluster };
export { isCluster } from '../components/blast-radius/types';
