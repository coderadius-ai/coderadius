/**
 * Merkle Tree — Incremental Ingestion Mutations
 *
 * SourceFile tracking, file-hash comparisons, and the Merkle index.
 */
import { run } from './_run.js';
import { z } from 'zod';
import { buildUrn } from '../urn.js';
import type { ScanMode } from '../scan-mode.js';

const commitHash = "SYSTEM";

// ═══════════════════════════════════════════════════════════════════════════════
// Merkle Tree (Incremental Ingestion)
// ═══════════════════════════════════════════════════════════════════════════════

export async function mergeSourceFile(filePath: string, fileHash: string, qualifiedRepoName: string, containerUrn: string, scanMode: ScanMode | undefined, commitHash: string) {
    const name = filePath.split('/').pop() || filePath;
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    // FIX: use startsWith check on the URN prefix — containerUrn is 'cr:repository:...' or 'cr:service:...'
    const relType = containerUrn.startsWith('cr:repository:') ? 'CONTAINS' : 'OWNS';
    await run(
        `MERGE (sf:SourceFile {id: $sfUrn})
     ON CREATE SET sf.valid_from_commit = $commitHash, sf.valid_to_commit = null, sf.name = $name, sf.path = $filePath, sf.fileHash = $fileHash, sf.scanMode = $scanMode, sf.createdAt = timestamp()
     ON MATCH SET sf.valid_from_commit = coalesce(sf.valid_from_commit, $commitHash), sf.valid_to_commit = null, sf.name = $name, sf.path = $filePath, sf.fileHash = $fileHash, sf.scanMode = coalesce($scanMode, sf.scanMode)
     WITH sf
     MATCH (container {id: $containerUrn})
     MERGE (container)-[:${relType}]->(sf)`,
        { sfUrn, containerUrn, filePath, fileHash, name, scanMode: scanMode ?? null, commitHash },
    );
}

export async function linkSourceFileContainsFunction(filePath: string, functionId: string, qualifiedRepoName: string, commitHash: string) {
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    await run(
        `MATCH (sf:SourceFile {id: $sfUrn})
     MATCH (f:Function {id: $functionId})
     MERGE (sf)-[rel:CONTAINS]->(f)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sfUrn, functionId, commitHash },
    );
}

/**
 * Link a Service to a SourceFile via an [:OWNS] relationship.
 * Used by the auto-discovery fallback (and Backstage-driven services) to
 * establish the Service → SourceFile hierarchy when no monorepo `apps/`
 * convention is present.
 */
export async function linkServiceOwnsSourceFile(qualifiedRepoName: string, serviceName: string, filePath: string, commitHash: string) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    await run(
        `MATCH (s:Service {id: $sUrn})
     MATCH (sf:SourceFile {id: $sfUrn})
     MERGE (s)-[rel:OWNS]->(sf)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sUrn, sfUrn, commitHash },
    );
}

export async function updateRepositoryHash(qualifiedRepoName: string, repoHash: string, scanMode: ScanMode | undefined, commitHash: string) {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    const lastAnalyzedAt = new Date().toISOString();
    await run(
        `MERGE (r:Repository {id: $rUrn})
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null
     SET r.repoHash = $repoHash, r.scanMode = coalesce($scanMode, r.scanMode),
         r.lastAnalyzedAt = $lastAnalyzedAt`,
        { rUrn, repoHash, scanMode: scanMode ?? null, commitHash, lastAnalyzedAt },
    );
}

// ─── Merkle Index Schema ─────────────────────────────────────────────────────

const MerkleIndexRowSchema = z.object({
    repoHash: z.string().nullable(),
    repoScanMode: z.string().nullable(),
    filePath: z.string().nullable(),
    fileHash: z.string().nullable(),
    fileScanMode: z.string().nullable(),
    functionId: z.string().nullable(),
    sourceHash: z.string().nullable(),
    hasIO: z.boolean(),
});

export type MerkleIndexRow = z.infer<typeof MerkleIndexRowSchema>;

export async function loadMerkleIndex(qualifiedRepoName: string): Promise<MerkleIndexRow[]> {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    const result = await run(
        `MATCH (r:Repository {id: $rUrn}) WHERE r.valid_to_commit IS NULL
     OPTIONAL MATCH (r)-[rc:CONTAINS]->(sf:SourceFile) WHERE rc.valid_to_commit IS NULL AND sf.valid_to_commit IS NULL
     OPTIONAL MATCH (sf)-[rf:CONTAINS]->(f:Function) WHERE rf.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
     RETURN r.repoHash AS repoHash,
            r.scanMode AS repoScanMode,
            sf.path AS filePath,
            sf.fileHash AS fileHash,
            sf.scanMode AS fileScanMode,
            f.id AS functionId,
            f.sourceHash AS sourceHash,
            CASE WHEN f.intent IS NULL OR f.intent = '' THEN false ELSE true END AS hasIO`,
        { rUrn },
    );

    return result.records.map(r => MerkleIndexRowSchema.parse({
        repoHash: r.get('repoHash'),
        repoScanMode: r.get('repoScanMode'),
        fileHash: r.get('fileHash'),
        fileScanMode: r.get('fileScanMode'),
        filePath: r.get('filePath'),
        functionId: r.get('functionId'),
        sourceHash: r.get('sourceHash'),
        hasIO: r.get('hasIO'),
    }));
}

export async function linkRepositoryContainsSourceFile(qualifiedRepoName: string, filePath: string, commitHash: string) {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    await run(
        `MERGE (r:Repository {id: $rUrn})
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null, r.name = $qualifiedRepoName, r.createdAt = timestamp()
     WITH r
     MERGE (sf:SourceFile {id: $sfUrn})
     MERGE (r)-[rel:CONTAINS]->(sf)
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null`,
        { rUrn, qualifiedRepoName, sfUrn, commitHash },
    );
}

export async function linkSourceFileDefinesAPI(filePath: string, qualifiedRepoName: string, apiUrn: string, commitHash: string) {
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    const name = filePath.split('/').pop() || filePath;
    await run(
        `MERGE (sf:SourceFile {id: $sfUrn})
     ON CREATE SET sf.name = $name, sf.path = $filePath
     MERGE (api:APIInterface {id: $apiUrn})
     MERGE (sf)-[rel:DEFINES_API]->(api)
     ON CREATE SET sf.valid_from_commit = $commitHash, sf.valid_to_commit = null
     ON MATCH SET sf.valid_from_commit = coalesce(sf.valid_from_commit, $commitHash), sf.valid_to_commit = null`,
        { sfUrn, apiUrn, name, filePath, commitHash },
    );
}

export async function mergeSourceFileStub(qualifiedRepoName: string, filePath: string) {
    const sfUrn = buildUrn('sourcefile', qualifiedRepoName, filePath);
    await run(
        `MERGE (sf:SourceFile {id: $sfUrn}) ON CREATE SET sf.path = $filePath ON MATCH SET sf.path = coalesce(sf.path, $filePath)`,
        { sfUrn, filePath }
    );
}
