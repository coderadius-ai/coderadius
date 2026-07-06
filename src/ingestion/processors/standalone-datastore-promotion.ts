/**
 * Standalone datastore promotion (reconcile stage).
 *
 * A datastore whose only I/O function is dropped by the taint gate (e.g. a
 * cache built in a constructor, or a store accessed through a wrapper) never
 * reaches the per-function binding loop in graph-writer, so no :Datastore node
 * is created — a blast-radius False Negative. This step materialises such
 * datastores from the deterministic connection hints, gated by the
 * high-confidence FP guard in `datastore-promotion.ts` (declared client library
 * OR an unambiguous DSN scheme).
 *
 * It runs AFTER the per-function loop, so it is purely additive: identities
 * that already produced a function-bound :Datastore are skipped (idempotent,
 * and a function-bound node's grounding is never clobbered). No CONNECTS_TO is
 * emitted — there is no function in scope.
 */
import { logger } from '../../utils/logger.js';
import { getMemgraphSession } from '../../graph/neo4j.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import { heuristicGrounding } from '../../graph/grounding.js';
import { emptyDelta, mergeDeltas, type GraphDelta } from '../../graph/write-model/delta.js';
import { MemgraphGraphStore } from '../../graph/write-model/memgraph-applier.js';
import type { GraphStore } from '../../graph/write-model/store.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { ProgressReporter } from '../core/progress.js';
import { extractAllPhysicalHints } from './connection-extractors/registry.js';
import { canonicalizeDatastoreIdentities } from './connection-extractors/canonicalizer.js';
import { readDeclaredPackages, selectPromotableDatastores } from './datastore-promotion.js';
import { datastoreNodeFacts, type DatastoreNodeContext } from './code-pipeline/interpret/datastore.js';
import type { DatastoreBinding, DatastoreIdentity } from './db-scope-resolver.js';

const PROMOTION_EXTRACTOR = 'datastore-promotion@v1';

export interface PromotedDatastore {
    urn: string;
    technology: string;
}

export interface StandalonePromotionResult {
    promoted: number;
}

/**
 * Minimal binding from a promotable identity. `datastoreNodeFacts` reads only
 * `datastoreId` / `technology` / `shared` / `environments`, so the connection
 * tier and confidence fields are nominal.
 */
function identityToPromotionBinding(id: DatastoreIdentity): DatastoreBinding {
    return {
        datastoreId: id.identityKey,
        technology: id.canonicalHint.technology,
        shared: false,
        bindingSource: 'connection_string',
        confidence: 0.9,
        bindingReason: 'env-canonical-default',
        environments: [...id.environments],
    };
}

/**
 * Pure core: which promotable identities become standalone :Datastore nodes,
 * and the GraphDelta that materialises them (node + physical endpoints, NO
 * CONNECTS_TO). Identities already live in `existingUrns` are skipped.
 */
export function computeStandaloneDatastoreDeltas(
    identities: readonly DatastoreIdentity[],
    declaredPackages: ReadonlySet<string>,
    existingUrns: ReadonlySet<string>,
    ctx: DatastoreNodeContext,
): { delta: GraphDelta; promoted: PromotedDatastore[] } {
    const promotable = selectPromotableDatastores(identities, declaredPackages);
    const deltas: GraphDelta[] = [];
    const promoted: PromotedDatastore[] = [];
    for (const id of promotable) {
        const binding = identityToPromotionBinding(id);
        const { dsUrn, delta } = datastoreNodeFacts(binding, ctx, heuristicGrounding(PROMOTION_EXTRACTOR, 'high'));
        if (existingUrns.has(dsUrn)) continue;
        deltas.push(delta);
        promoted.push({ urn: dsUrn, technology: binding.technology });
    }
    return { delta: deltas.length ? mergeDeltas(...deltas) : emptyDelta(), promoted };
}

async function liveDatastoreUrns(namespace: string): Promise<Set<string>> {
    const session = getMemgraphSession();
    try {
        const res = await session.run(
            'MATCH (d:Datastore) WHERE d.valid_to_commit IS NULL AND d.namespace = $ns RETURN d.id AS id',
            { ns: namespace },
        );
        return new Set(res.records.map(r => r.get('id') as string).filter(Boolean));
    } finally {
        await session.close();
    }
}

/**
 * Reconcile-stage recall: per repo, materialise standalone :Datastore nodes for
 * datastores whose only I/O function was dropped by the taint gate. Idempotent
 * against function-bound datastores. The `store` is injectable for tests.
 */
export async function promoteStandaloneDatastores(
    repos: ResolvedRepo[],
    task?: ProgressReporter,
    store: GraphStore = new MemgraphGraphStore(),
): Promise<StandalonePromotionResult> {
    let promotedTotal = 0;
    for (const repo of repos) {
        const namespace = getQualifiedRepoName(repo);
        const commitHash = repo.commit || 'SYSTEM';
        let identities: DatastoreIdentity[];
        try {
            identities = canonicalizeDatastoreIdentities(extractAllPhysicalHints(repo.path).hints);
        } catch (e) {
            logger.debug(`[standalone-datastore-promotion] hint extraction failed for ${namespace}: ${(e as Error).message}`);
            continue;
        }
        if (identities.length === 0) continue;
        const declaredPackages = readDeclaredPackages(repo.path);
        const existingUrns = await liveDatastoreUrns(namespace);
        const ctx: DatastoreNodeContext = { qualifiedRepoName: namespace, commitHash, allowPlainTextHosts: false };
        const { delta, promoted } = computeStandaloneDatastoreDeltas(identities, declaredPackages, existingUrns, ctx);
        if (promoted.length === 0) continue;
        await store.apply(delta, { commitHash });
        promotedTotal += promoted.length;
        task?.report(`Promoted ${promoted.length} standalone datastore(s) in ${namespace}: ${promoted.map(p => p.technology).join(', ')}`);
    }
    return { promoted: promotedTotal };
}
