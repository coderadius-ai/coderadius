import { run } from '../../../graph/mutations/_run.js';
import { buildUrn } from '../../../graph/urn.js';
import { logger } from '../../../utils/logger.js';
import { traceCollector } from '../../../telemetry/index.js';

/**
 * Soft-delete a SourceFile and its [:CONTAINS] edges.
 * CRITICAL: Does NOT cascade to the Function nodes. If a function moved files,
 * its global VName survives, but the old file's edge is retired.
 *
 * @param deletedPaths Array of relative file paths that were deleted on disk
 * @param repoName Name of the repository
 * @param commitHash The commit hash marking the deletion
 */
export async function contractDeletedFiles(deletedPaths: string[], qualifiedRepoName: string, commitHash: string): Promise<void> {
    if (!deletedPaths || deletedPaths.length === 0) return;

    logger.debug(`[Contract] Soft-deleting ${deletedPaths.length} file(s) at commit ${commitHash}`);
    traceCollector.traceContract('DELETE', `sourcefile:${qualifiedRepoName}`, `soft-deleting ${deletedPaths.length} file(s)`, { deletedPaths, commitHash });

    const sfUrns = deletedPaths.map(p => buildUrn('sourcefile', qualifiedRepoName, p));

    // Step 1: Tombstone the SourceFile node itself.
    await run(
        `UNWIND $sfUrns AS sfUrn
         MATCH (sf:SourceFile {id: sfUrn})
         SET sf.valid_to_commit = $commitHash`,
        { sfUrns, commitHash }
    );

    // Step 2: Tombstone active [:CONTAINS] edges from that SourceFile.
    // WHERE must follow OPTIONAL MATCH directly — cannot be after WITH in this pattern.
    await run(
        `UNWIND $sfUrns AS sfUrn
         MATCH (sf:SourceFile {id: sfUrn})
         WITH sf
         OPTIONAL MATCH (sf)-[r:CONTAINS]->(f:Function)
         WHERE r.valid_to_commit IS NULL
         SET r.valid_to_commit = $commitHash`,
        { sfUrns, commitHash }
    );
}

/**
 * Soft-delete individual functions based on global VName absence.
 * Also soft-deletes all live outbound edges from these functions.
 *
 * @param deletedFunctionIds Array of VName URIs that disappeared globally
 * @param commitHash The commit hash marking the deletion
 */
export async function contractDeletedFunctions(deletedFunctionIds: string[], commitHash: string): Promise<void> {
    if (!deletedFunctionIds || deletedFunctionIds.length === 0) return;

    logger.debug(`[Contract] Soft-deleting ${deletedFunctionIds.length} globally missing function(s) at commit ${commitHash}`);
    traceCollector.traceContract('DELETE', 'functions', `soft-deleting ${deletedFunctionIds.length} globally missing function(s)`, { deletedFunctionIds, commitHash });

    // Step 1: Tombstone the Function nodes.
    await run(
        `UNWIND $deletedFunctionIds AS funcId
         MATCH (f:Function {id: funcId})
         SET f.valid_to_commit = $commitHash`,
        { deletedFunctionIds, commitHash }
    );

    // Step 2: Tombstone all live outbound edges from the dead functions.
    await run(
        `UNWIND $deletedFunctionIds AS funcId
         MATCH (f:Function {id: funcId})
         WITH f
         OPTIONAL MATCH (f)-[r]->()
         WHERE r.valid_to_commit IS NULL
         SET r.valid_to_commit = $commitHash`,
        { deletedFunctionIds, commitHash }
    );
}
