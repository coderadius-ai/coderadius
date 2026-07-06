/**
 * Reconcile pass: tombstone live DataContainers whose NAME violates
 * identifier shape — the same deterministic predicates the sanitizer and the
 * static-bypass apply at emission time (bare SQL reserved words, whitespace,
 * dotted framework-DI ids).
 *
 * Why a graph pass too: emissions from BEFORE a guard landed persist via
 * Merkle-cached functions (their producers are never re-run), so the graph
 * keeps shape-invalid names forever unless a reconcile-time sweep applies
 * the same contract. Idempotent, name-only (no source evidence available
 * here — evidence-based guards stay at emission time).
 */

import { getNeo4jSession } from '../../graph/neo4j.js';
import { isSqlReservedTokenName } from '../core/name-safety.js';
import { anyPluginRecognizesFrameworkDiHandle } from '../core/languages/registry.js';

export function isShapeInvalidContainerName(name: string): boolean {
    // The graph sweep has no language context (names only), so the
    // framework DI-handle grammar is aggregated across ALL registered
    // language plugins — the knowledge stays plugin-owned.
    return isSqlReservedTokenName(name)
        || /\s/.test(name.trim())
        || anyPluginRecognizesFrameworkDiHandle(name, 'container');
}

export async function tombstoneShapeInvalidDataContainers(commitHash: string): Promise<number> {
    const session = getNeo4jSession();
    try {
        const rows = await session.run(
            `MATCH (d:DataContainer) WHERE d.valid_to_commit IS NULL RETURN d.id AS id, d.name AS name`,
        );
        const invalidIds = rows.records
            .filter((r) => isShapeInvalidContainerName(String(r.get('name') ?? '')))
            .map((r) => r.get('id') as string);
        if (invalidIds.length === 0) return 0;

        await session.run(
            `UNWIND $ids AS id
             MATCH (d:DataContainer {id: id})
             SET d.valid_to_commit = $commitHash`,
            { ids: invalidIds, commitHash },
        );
        return invalidIds.length;
    } finally {
        await session.close();
    }
}
