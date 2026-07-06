import { run } from '../../../graph/mutations/_run.js';
import { normalizeApiPathLossless } from '../api-path-utils.js';
import { buildUrn, urnPrefix } from '../../../graph/urn.js';
import { logger } from '../../../utils/logger.js';
import { traceCollector } from '../../../telemetry/index.js';
import { resolveContainerScope, resolveDatastoreBinding } from '../db-scope-resolver.js';
import type { DatastoreIdentity, KindFamily } from '../db-scope-resolver.js';
import { resolveMessageChannelAlias, type RepoHints } from '../../../config/repo-hints.js';
import { resolveMessageChannelName } from './interpret/message-channel.js';
import { inferDatastoreFromEnvVars } from '../db-scope-resolver.js';
import type { EnvVarBinding } from '../infra-manifest-resolver.js';
import type { UnifiedAnalysis } from '../../../ai/agents/unified-analyzer.js';
import type { ResourceDeclaration } from '../../core/languages/types.js';

interface EdgeDef {
    relType: string;
    targetId: string;
}

type MessageChannelKind = 'topic' | 'subscription' | 'queue' | 'exchange';

function messageChannelTargetId(
    name: string,
    channelKind?: MessageChannelKind,
): string {
    if (channelKind === 'topic') return buildUrn('channel', 'topic', name);
    if (channelKind === 'subscription') return buildUrn('channel', 'sub', name);
    if (channelKind) return buildUrn('channel', channelKind, name);
    return buildUrn('channel', name);
}

// ─── Protected edge prefixes ─────────────────────────────────────────────────
//
// Canonical OpenAPI endpoints (cr:endpoint:cr:api:*) and code-exposed endpoints
// (cr:endpoint:code:*) are wired by the *matchmaking* step, NOT by the LLM.
// If a function is re-analyzed and the LLM doesn't reproduce IMPLEMENTS_ENDPOINT,
// that edge should NOT be tombstoned — it was correct from matchmaking.
// Only emergent (LLM-inferred outbound call) endpoints can be cleaned up by reconciler.
//
// Similarly, LISTENS_TO edges derived from the DI registry (resolved_via: di_registry)
// are ground-truth consumer links. They should survive LLM re-analysis.

const EMERGENT_ENDPOINT_PREFIX = urnPrefix('endpoint', 'emergent');
const EMERGENT_GQL_PREFIX = urnPrefix('endpoint', 'emergent-graphql');


/**
 * Reconciles the outbound edges of a modified function.
 * By diffing the newly extracted dependencies against the active edges in the graph,
 * this function soft-deletes any stale edges (e.g. removed DB queries or API calls).
 *
 * @param functionVName      The Kythe ID of the modified function
 * @param analysis           The fresh LLM extraction result
 * @param qualifiedRepoName  The qualified repo name (org/repo) — used to build scoped URNs
 * @param commitHash         The current commit hash
 * @param repoHints          Parsed coderadius.yaml (for resolveContainerScope)
 */
export async function reconcileEdges(
    functionVName: string,
    analysis: UnifiedAnalysis,
    qualifiedRepoName: string,
    commitHash: string,
    repoHints: RepoHints,
    resourceDeclarations: ResourceDeclaration[] = [],
    envVarDict: Map<string, EnvVarBinding> = new Map(),
    identities: readonly DatastoreIdentity[] = [],
    chunkEnvVars: readonly string[] = [],
): Promise<void> {
    // 1. Compute expected edge signatures from the fresh LLM analysis
    const expectedEdges = new Set<string>();

    for (const infra of analysis.infrastructure) {
        let targetId = '';
        // FIX: DataContainer URNs are now scoped via resolveContainerScope (Phase 1c parity).
        // MessageChannel stays global (cross-repo pub/sub).
        // Cache → Datastore URNs are hint-dependent; skip in reconciler
        // (those edges are created by the writer using selectDatastoreHint, not by the LLM).
        if (infra.type === 'Database' || infra.type === 'ObjectStorage') {
            // Dynamic/opaque names → skip (Datastore URN is hint-dependent, not reconstructable)
            const isDynamic = infra.name === '<DYNAMIC>' || /unknown|placeholder/i.test(infra.name);
            if (!isDynamic) {
                const { scope } = resolveContainerScope(infra.name, qualifiedRepoName, repoHints);
                targetId = buildUrn('datacontainer', scope, infra.name);
            }
        }
        else if (infra.type === 'MessageChannel') {
            const alias = resolveMessageChannelAlias(repoHints, infra.name);
            // Resolve DI/Helm-templated names (e.g. appChannelSave → Order-Save)
            // to match the graph-writer's resolved channel name and prevent false stale deletions.
            const envResolved = resolveMessageChannelName(infra.name, envVarDict);
            const channelName = alias?.name ?? (envResolved !== infra.name ? envResolved : infra.name);
            const rawKind = (alias?.channelKind ?? (infra as any).channelKind) as MessageChannelKind | undefined;
            const effectiveKind = rawKind ?? 'topic';
            targetId = messageChannelTargetId(channelName, effectiveKind);
        }
        // Cache → skip (Datastore URN is hint-dependent, not reconstructable)
        else if (infra.type === 'ExternalAPI') targetId = buildUrn('service', qualifiedRepoName, infra.name);
        else if (infra.type === 'Process') targetId = buildUrn('systemprocess', infra.name);

        if (targetId) {
            // FIX: MessageChannel operations map to PUBLISHES_TO/LISTENS_TO
            // FIX: Process always maps to SPAWNS (not infra.operation='WRITES')
            const relType = infra.type === 'MessageChannel'
                ? (infra.operation === 'READS' ? 'LISTENS_TO' : 'PUBLISHES_TO')
                : infra.type === 'Process'
                    ? 'SPAWNS'
                    : infra.operation;
            expectedEdges.add(`${relType}|${targetId}`);
        }
    }

    for (const declaration of resourceDeclarations) {
        const targetId = buildUrn('datastore', qualifiedRepoName, declaration.logicalId);
        expectedEdges.add(`CONNECTS_TO|${targetId}`);
    }

    // ── Auto-discovered Datastore CONNECTS_TO ───────────────────────────────
    //
    // For every Database/Cache/ObjectStorage infra, the graph-writer creates
    // CONNECTS_TO edges to ALL candidate Datastore identities (one per
    // canonical identity returned by `resolveDatastoreBinding`). The
    // reconciler MUST mirror that derivation here — without it, the CONNECTS_TO
    // edges the writer just created would appear "stale" (not in
    // expectedEdges) and get tombstoned in the same persistence pass.
    if (identities.length > 0) {
        const envVarHint = inferDatastoreFromEnvVars(chunkEnvVars.map(v => v.toUpperCase()));
        for (const infra of analysis.infrastructure) {
            if (infra.type !== 'Database' && infra.type !== 'Cache' && infra.type !== 'ObjectStorage') continue;
            const isDynamic = infra.name === '<DYNAMIC>' || /unknown|placeholder/i.test(infra.name);
            const tableName = isDynamic ? null : infra.name;
            const kf = (infra as { kindFamily?: KindFamily }).kindFamily;
            const bindings = resolveDatastoreBinding(
                tableName, infra.type, repoHints, envVarHint, identities, kf,
            );
            for (const b of bindings) {
                const ns = b.shared ? 'shared' : qualifiedRepoName;
                const dsUrn = buildUrn('datastore', ns, b.datastoreId);
                expectedEdges.add(`CONNECTS_TO|${dsUrn}`);
            }
        }
    }

    for (const api of analysis.emergent_api_calls) {
        const normalizedPath = normalizeApiPathLossless(api.path);
        if (!normalizedPath) continue;

        if (api.direction === 'OUTBOUND') {
            // OUTBOUND: function calls an emergent endpoint
            // Use null-safe method (GQL Subscriptions have method=null, stored as WS)
            const safeMethod = (api.method ?? 'POST').toUpperCase();
            const endpointUrn = buildUrn('endpoint', 'emergent', safeMethod, normalizedPath);
            expectedEdges.add(`CALLS|${endpointUrn}`);
        } else {
            // FIX: INBOUND endpoints are stored as `endpoint:code:*` (not emergent:*)
            const safeMethod = (api.method ?? 'POST').toUpperCase();
            const endpointUrn = buildUrn('endpoint', 'code', safeMethod, normalizedPath);
            expectedEdges.add(`IMPLEMENTS_ENDPOINT|${endpointUrn}`);
        }
    }

    // 2. Fetch existing active edges from the Neo4j/Memgraph database
    // FIX: Include all broker edge types in the whitelist so stale PUBLISHES_TO/LISTENS_TO are cleaned up
    const result = await run(
        `MATCH (f:Function {id: $functionVName})-[r]->(target)
         WHERE r.valid_to_commit IS NULL
         AND type(r) IN ['READS', 'WRITES', 'MAPS_TO', 'CALLS', 'IMPLEMENTS_ENDPOINT',
                         'PUBLISHES_TO', 'LISTENS_TO', 'CONNECTS_TO', 'SPAWNS']
         RETURN type(r) AS relType, target.id AS targetId, target.normalizedFrom AS normalizedFrom`,
        { functionVName }
    );

    const existingEdges: (EdgeDef & { normalizedFrom: string | null })[] = result.records.map(r => ({
        relType: r.get('relType') as string,
        targetId: r.get('targetId') as string,
        normalizedFrom: r.get('normalizedFrom') as string | null
    }));

    // 3. Diff to find edges that are in the database but no longer in the code
    const staleEdges: EdgeDef[] = [];
    for (const edge of existingEdges) {
        const key = `${edge.relType}|${edge.targetId}`;
        const keyFallback = edge.normalizedFrom ? `${edge.relType}|${edge.normalizedFrom}` : null;
        if (expectedEdges.has(key) || (keyFallback && expectedEdges.has(keyFallback))) continue;

        // ── Protection: IMPLEMENTS_ENDPOINT to canonical (OpenAPI / code-exposed) endpoints
        // These edges are wired by the matchmaking step, not extracted by the LLM.
        // The LLM output will never contain them in `analysis.emergent_api_calls`,
        // so they would always appear "missing" — but they are correct.
        // Only emergent endpoints (LLM-inferred outbound calls) should be reconciled.
        if (edge.relType === 'IMPLEMENTS_ENDPOINT' &&
            !edge.targetId.startsWith(EMERGENT_ENDPOINT_PREFIX) &&
            !edge.targetId.startsWith(EMERGENT_GQL_PREFIX)) {
            logger.debug(`[EdgeReconciler] Preserving canonical IMPLEMENTS_ENDPOINT for ${functionVName} → ${edge.targetId}`);
            continue;
        }

        staleEdges.push(edge);
    }

    // 4. Soft-delete stale edges
    if (staleEdges.length > 0) {
        logger.debug(`[EdgeReconciler] Soft-deleting ${staleEdges.length} stale edge(s) for ${functionVName}`);
        traceCollector.tracePersist('DELETE', functionVName, `soft-deleting ${staleEdges.length} stale edge(s)`, {
            staleEdgeCount: staleEdges.length,
            edges: staleEdges.map(e => ({ relType: e.relType, targetId: e.targetId })),
        });

        await run(
            `UNWIND $staleEdges AS edge
             MATCH (f:Function {id: $functionVName})-[r]->(target {id: edge.targetId})
             WHERE type(r) = edge.relType AND r.valid_to_commit IS NULL
             SET r.valid_to_commit = $commitHash`,
            { functionVName, staleEdges, commitHash }
        );
    }
}
