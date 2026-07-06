/**
 * Skill Duplicates view builder.
 *
 * Composes:
 *   - `querySemanticDuplicates` filtered to skills + cross-repo
 *   - member-detail enrichment (description, semanticIntent, topics, tech)
 *   - embedding fetch for the clustered nodes
 *   - cluster construction + 2D projection (skill-clusters.ts)
 *
 * Output is meant to be embedded directly into AgentHarnessReport.skillDuplicates.
 */

import { run } from '../mutations/_run.js';
import { querySemanticDuplicates, type SemanticDuplicate } from '../mutations/agentic.js';
import {
    buildSkillClusters,
    buildCanonicalSkillMap,
    canonicalizeSkillPairs,
    computeSkillProjection,
    type SkillDuplicateCluster,
    type SkillMemberView,
    type SkillProjectionPoint,
} from './skill-clusters.js';

export interface SkillDuplicatesView {
    clusters: SkillDuplicateCluster[];
    projection: SkillProjectionPoint[];
    threshold: number;
    totalSkills: number;
    totalCrossRepoClusters: number;
}

const DEFAULT_THRESHOLD = 0.90;
const DEFAULT_TOPK = 20;
const DEFAULT_LIMIT = 200;

export function emptySkillDuplicatesView(threshold = DEFAULT_THRESHOLD): SkillDuplicatesView {
    return {
        clusters: [],
        projection: [],
        threshold,
        totalSkills: 0,
        totalCrossRepoClusters: 0,
    };
}

export async function querySkillDuplicatesView(
    threshold = DEFAULT_THRESHOLD,
): Promise<SkillDuplicatesView> {
    const totalSkills = await querySkillCount();

    const pairs = await querySemanticDuplicates({
        configType: 'skill',
        crossRepoOnly: true,
        skipFingerprintDedup: true,
        threshold,
        topK: DEFAULT_TOPK,
        limit: DEFAULT_LIMIT,
    });
    if (pairs.length === 0) return { ...emptySkillDuplicatesView(threshold), totalSkills };

    const memberIds = uniqueIds(pairs);
    const memberMap = await fetchSkillMembers(memberIds);

    // Collapse harness-dir copies of one skill within a service to a single
    // logical node before clustering, so the same (service, skill) cannot appear
    // twice in a cluster (see buildCanonicalSkillMap).
    const canonical = buildCanonicalSkillMap(memberMap);
    const clusters = buildSkillClusters(
        canonicalizeSkillPairs(pairs.map(toClusterPair), canonical),
        memberMap,
    );
    if (clusters.length === 0) return { ...emptySkillDuplicatesView(threshold), totalSkills };

    const clusteredIds = new Set<string>(clusters.flatMap(c => c.memberIds));
    const clusterByMember = new Map<string, string>();
    for (const c of clusters) for (const m of c.memberIds) clusterByMember.set(m, c.id);

    const embeddings = await fetchSkillEmbeddings([...clusteredIds]);
    const projection = await computeSkillProjection(
        embeddings.map(e => ({
            configId: e.configId,
            vector: e.vector,
            clusterId: clusterByMember.get(e.configId) ?? null,
        })),
    );

    return {
        clusters,
        projection,
        threshold,
        totalSkills,
        totalCrossRepoClusters: clusters.length,
    };
}

function toClusterPair(d: SemanticDuplicate) {
    return { a: d.configIdA, b: d.configIdB, similarity: d.similarity };
}

function uniqueIds(pairs: SemanticDuplicate[]): string[] {
    const set = new Set<string>();
    for (const p of pairs) { set.add(p.configIdA); set.add(p.configIdB); }
    return [...set];
}

async function querySkillCount(): Promise<number> {
    const r = await run(
        `MATCH (a:AgenticConfig) WHERE a.configType = 'skill' RETURN count(a) AS c`
    );
    return Number(r.records[0]?.get('c') ?? 0);
}

async function fetchSkillMembers(ids: string[]): Promise<Map<string, SkillMemberView>> {
    const out = new Map<string, SkillMemberView>();
    if (ids.length === 0) return out;

    // Service resolution must mirror semantic-duplicates-query.ts (see comment there).
    const result = await run(
        `UNWIND $ids AS id
         MATCH (a:AgenticConfig { id: id })
         OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(svcDir:Service)
         OPTIONAL MATCH (a)<-[:HAS_AGENTIC_CONFIG]-(repoDir:Repository)
         OPTIONAL MATCH (a)<-[:DEFINES]-(sf)<-[:STORED_IN|HAS_CONFIG]-(svcStored:Service)
         RETURN a.id        AS configId,
                coalesce(a.skillName, a.name) AS name,
                coalesce(a.description, '')   AS description,
                a.semanticIntent              AS semanticIntent,
                a.filePath                    AS filePath,
                coalesce(svcDir.name, svcStored.name, repoDir.name, split(a.id, ':')[2], 'unknown') AS service,
                a.topics                      AS topics,
                a.technologies                AS technologies,
                a.skillSourceUrl              AS sourceUrl,
                a.symlinkTarget               AS symlinkTarget,
                a.installedVia                AS installedVia,
                a.contentFingerprint          AS contentFingerprint`,
        { ids },
    );

    for (const r of result.records) {
        const id = r.get('configId') as string;
        out.set(id, {
            configId: id,
            name: r.get('name') as string,
            description: r.get('description') as string,
            semanticIntent: (r.get('semanticIntent') as string | null) ?? undefined,
            filePath: r.get('filePath') as string,
            service: r.get('service') as string,
            topics: csvToArray(r.get('topics') as string | null),
            technologies: csvToArray(r.get('technologies') as string | null),
            sourceUrl: (r.get('sourceUrl') as string | null) ?? undefined,
            symlinkTarget: (r.get('symlinkTarget') as string | null) ?? undefined,
            installedVia: (r.get('installedVia') as string | null) ?? undefined,
            contentFingerprint: (r.get('contentFingerprint') as string | null) ?? undefined,
        });
    }
    return out;
}

async function fetchSkillEmbeddings(ids: string[]): Promise<{ configId: string; vector: number[] }[]> {
    if (ids.length === 0) return [];
    const result = await run(
        `UNWIND $ids AS id
         MATCH (a:AgenticConfig { id: id })
         WHERE a.embedding IS NOT NULL
         RETURN a.id AS configId, a.embedding AS vector`,
        { ids },
    );
    return result.records.map(r => ({
        configId: r.get('configId') as string,
        vector: r.get('vector') as number[],
    }));
}

function csvToArray(v: string | null | undefined): string[] {
    if (!v) return [];
    return v.split(',').map(s => s.trim()).filter(Boolean);
}
