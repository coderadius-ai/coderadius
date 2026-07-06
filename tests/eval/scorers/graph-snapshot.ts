// ═══════════════════════════════════════════════════════════════════════════════
// GraphSnapshot builder — shared between the fixture eval suite and the
// live-graph assessment CLI (scripts/assess-graph.ts).
//
// Reads node names per label from a (Mem)graph session and canonicalizes them
// so they can be matched EXACTLY against an EvalManifest. Two modes:
//
//   'fixture' — byte-identical to the legacy eval-graph.test.ts behavior:
//               `n.name` verbatim, plus the synthetic 'GRAPHQL <op> <name>'
//               label for GraphQL endpoints. Existing expected.graph.yaml
//               manifests are case-sensitive and depend on this.
//
//   'field'   — live-graph assessment of a real ingestion: REST endpoints
//               become 'METHOD /path' with path params normalized to '{}',
//               names are lowercased/stripped so a hand-generated manifest
//               and the graph meet on one canonical form. Matching stays
//               exact-after-canonicalization, never fuzzy.
//
// Both modes read live nodes only (valid_to_commit IS NULL): a tombstoned
// node is not an asserted fact and must satisfy neither expected_nodes nor
// negative_nodes.
// ═══════════════════════════════════════════════════════════════════════════════

import { getNeo4jSession } from '../../../src/graph/neo4j.js';
import type { GraphSnapshot } from './eval-scorer.js';
import type { NodeLabel } from '../../../src/graph/domain.js';

export type SnapshotMode = 'fixture' | 'field';

/** Raw node properties needed to compute a canonical name. */
export interface SnapshotNodeProps {
    name: string | null;
    method?: string | null;
    path?: string | null;
    apiKind?: string | null;
    operation?: string | null;
    operationName?: string | null;
    provider?: string | null;
    vhost?: string | null;
}

export interface BuildSnapshotOptions {
    mode: SnapshotMode;
    /**
     * Restrict labels that carry an unambiguous repo discriminator to one repo:
     * DataContainer via `n.scope`, Service via the URN prefix. Labels without a
     * repo discriminator (MessageChannel, APIEndpoint, …) are returned unscoped;
     * on single-repo graphs this is a no-op.
     */
    repoScope?: string;
}

// Cypher label interpolation guard. Labels come from manifest keys (user
// input): allow only identifier-shaped labels, never quote-breaking text.
const SAFE_LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const GENERIC_STRIP_RE = /[`'"]/g;

function normalizeFieldPath(rawPath: string): string {
    let p = rawPath.toLowerCase().replace(/\{[^}]*\}/g, '{}').replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
}

/**
 * Compute the canonical, manifest-comparable name for one node.
 * Pure function — unit-tested in tests/unit/eval/graph-snapshot-canonical.test.ts.
 */
export function canonicalNodeName(
    label: string,
    props: SnapshotNodeProps,
    mode: SnapshotMode,
): string {
    if (label === 'APIEndpoint') {
        // GraphQL endpoints keep the synthetic label in BOTH modes: the
        // operation tuple is their identity, the path is just '/graphql'.
        if (props.apiKind === 'graphql' && props.operation && props.operationName) {
            return `GRAPHQL ${props.operation} ${props.operationName}`;
        }
        if (mode === 'fixture') return props.name ?? '';
        const method = (props.method ?? 'ANY').toUpperCase();
        const rawPath = props.path ?? props.name ?? '';
        return `${method} ${normalizeFieldPath(rawPath)}`;
    }

    if (label === 'MessageBroker') {
        // Brokers carry no `name` property: identity is provider + vhost.
        // The host is excluded on purpose — it is env-dependent (helm/compose
        // values pick it per environment), while provider and vhost are
        // config-literal grounded and predictable for a manifest author.
        const id = [props.provider ?? '', props.vhost ?? ''].filter(Boolean).join(' ');
        if (mode === 'fixture') return id;
        return id.replace(GENERIC_STRIP_RE, '').trim().toLowerCase();
    }

    if (mode === 'fixture') return props.name ?? '';
    return (props.name ?? '').replace(GENERIC_STRIP_RE, '').trim().toLowerCase();
}

/** Per-label snapshot query returning the props canonicalNodeName needs. */
export function snapshotQueryForLabel(
    label: string,
    opts: BuildSnapshotOptions,
): { query: string; params: Record<string, unknown> } {
    if (!SAFE_LABEL_RE.test(label)) {
        throw new Error(`Refusing to interpolate unsafe label into Cypher: ${JSON.stringify(label)}`);
    }

    const params: Record<string, unknown> = {};
    const where: string[] = ['n.valid_to_commit IS NULL'];

    if (opts.repoScope) {
        if (label === 'DataContainer') {
            where.push('(n.scope IS NULL OR n.scope = $repoScope)');
            params.repoScope = opts.repoScope;
        } else if (label === 'Service') {
            // NOTE: precompute the prefix — Memgraph parses
            // `x STARTS WITH 'a' + $p` as `(x STARTS WITH 'a') + $p`.
            where.push('n.id STARTS WITH $servicePrefix');
            params.servicePrefix = `cr:service:${opts.repoScope}:`;
        } else if (label === 'MessageChannel') {
            // Channels are global nodes: scope by traversal. A channel belongs
            // to the repo when (a) one of the repo's services touches it via a
            // function, or (b) one of the repo's config files DECLARES it
            // (StructuralFile DEFINES — Laminas/messenger/definitions parsers).
            // Truly orphan channels are excluded when scoped.
            params.servicePrefix = `cr:service:${opts.repoScope}:`;
            params.repoUrn = `cr:repository:${opts.repoScope}`;
            return {
                query: `MATCH (sv:Service)-[:CONTAINS]->(:Function)-[:PUBLISHES_TO|LISTENS_TO]->(n:MessageChannel)
                        WHERE sv.id STARTS WITH $servicePrefix
                          AND n.valid_to_commit IS NULL
                        RETURN DISTINCT n.name AS name
                        UNION
                        MATCH (o)-[:HAS_CONFIG]->(:StructuralFile)-[:DEFINES]->(n:MessageChannel)
                        WHERE (o.id = $repoUrn OR o.id STARTS WITH $servicePrefix)
                          AND n.valid_to_commit IS NULL
                        RETURN DISTINCT n.name AS name`,
                params,
            };
        }
        // Other labels carry no repo discriminator: returned unscoped by design.
    }

    const extraProps = label === 'APIEndpoint'
        ? ', n.method AS method, n.path AS path, n.apiKind AS apiKind, n.operation AS operation, n.operationName AS operationName'
        : label === 'MessageBroker'
            ? ', n.provider AS provider, n.vhost AS vhost'
            : '';

    return {
        query: `MATCH (n:${label}) WHERE ${where.join(' AND ')} RETURN n.name AS name${extraProps}`,
        params,
    };
}

/**
 * Build a GraphSnapshot (label → canonical names) for the given labels.
 * Opens and closes its own session; set MEMGRAPH_URI before calling to
 * target a specific instance.
 */
export async function buildGraphSnapshot(
    labels: string[],
    opts: BuildSnapshotOptions,
): Promise<GraphSnapshot> {
    const snapshot: GraphSnapshot = new Map();
    const session = getNeo4jSession();
    try {
        for (const label of labels) {
            const { query, params } = snapshotQueryForLabel(label, opts);
            const result = await session.run(query, params);
            // Dedupe canonical names: two graph nodes sharing one canonical
            // identity are ONE asserted fact for matching purposes (the
            // duplication itself is a weld gap, not two false positives).
            const names = [...new Set(result.records.map((r) =>
                canonicalNodeName(label, r.toObject() as SnapshotNodeProps, opts.mode),
            ))];
            snapshot.set(label as NodeLabel, names);
        }
    } finally {
        await session.close();
    }
    return snapshot;
}
