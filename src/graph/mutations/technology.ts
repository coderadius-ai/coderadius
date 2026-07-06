/**
 * Technology — canonical, kind-discriminated tech identity.
 *
 * One node type for languages, datastore engines, brokers, frameworks, etc.
 * The edge verb carries the semantics (WRITTEN_IN for languages; RUNS / USES
 * for the operational kinds added later). URN: cr:technology:{kind}:{slug}.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding } from '../grounding.js';

function techSlug(raw: string): string {
    return raw.trim().toLowerCase();
}

/** Upsert a Technology node (canonical, case-insensitive). Idempotent. */
export async function mergeTechnology(slug: string, kind: string, commitHash: string) {
    const clean = techSlug(slug);
    if (!clean) return;
    const urn = buildUrn('technology', kind, clean);
    const prov = astGrounding('tech-detect@v1');
    await run(
        `MERGE (t:Technology {id: $urn})
         ON CREATE SET t.name = $clean, t.slug = $clean, t.kind = $kind, t.createdAt = timestamp()
         ON MATCH SET  t.slug = $clean, t.kind = $kind
         ${groundingWriteClause('t')}`,
        { urn, clean, kind, commitHash, ...groundingParams(prov, commitHash) },
    );
}

/**
 * Link a node to the Technology it is WRITTEN_IN (one language per node, so any
 * previous edge is replaced). Creates the Technology node if needed.
 */
export async function linkWrittenIn(nodeUrn: string, slug: string, commitHash: string) {
    const clean = techSlug(slug);
    if (!clean) return;
    await mergeTechnology(clean, 'language', commitHash);
    const techUrn = buildUrn('technology', 'language', clean);
    await run(
        `MATCH (n {id: $nodeUrn})
         OPTIONAL MATCH (n)-[old:WRITTEN_IN]->(:Technology)
         DELETE old
         WITH n
         MATCH (t:Technology {id: $techUrn})
         MERGE (n)-[:WRITTEN_IN {valid_from_commit: $commitHash}]->(t)`,
        { nodeUrn, techUrn, commitHash },
    );
}
