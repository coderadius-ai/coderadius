/**
 * Package Dependencies — Graph Mutations
 *
 * Package nodes and dependency edges for Service/Library/Repository.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding } from '../grounding.js';
import semver from 'semver';

// ═══════════════════════════════════════════════════════════════════════════════
// Package Dependencies
// ═══════════════════════════════════════════════════════════════════════════════

export async function mergePackage(ecosystem: string, name: string, isInternal: boolean, commitHash: string) {
    const urn = buildUrn('package', ecosystem, name);
    const prov = astGrounding('package-manifest@v1');
    await run(
        `MERGE (p:Package {id: $urn})
     ON CREATE SET p.valid_from_commit = $commitHash, p.valid_to_commit = null
     ON MATCH SET p.valid_from_commit = coalesce(p.valid_from_commit, $commitHash), p.valid_to_commit = null
     SET p.name = $name, p.ecosystem = $ecosystem, p.isInternal = CASE WHEN p.isInternal = true THEN true ELSE $isInternal END
     ${groundingWriteClause('p')}`,
        { urn, name, ecosystem, isInternal, commitHash, ...groundingParams(prov, commitHash) },
    );
}

export async function linkServiceDependsOnPackage(qualifiedRepoName: string, serviceName: string, packageUrn: string, requiredVersion: string, isDev: boolean, commitHash: string) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (s:Service {id: $sUrn}), (p:Package {id: $packageUrn})
     MERGE (s)-[r:DEPENDS_ON]->(p)
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null
     SET r.requiredVersion = $requiredVersion, r.installedVersion = null, r.isDev = $isDev`,
        { sUrn, packageUrn, requiredVersion, isDev , commitHash },
    );
}

export async function linkLibraryDependsOnPackage(libraryName: string, packageUrn: string, requiredVersion: string, isDev: boolean, commitHash: string) {
    const lUrn = buildUrn('library', libraryName);
    await run(
        `MATCH (l:Library {id: $lUrn}), (p:Package {id: $packageUrn})
     MERGE (l)-[r:DEPENDS_ON]->(p)
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null
     SET r.requiredVersion = $requiredVersion, r.installedVersion = null, r.isDev = $isDev`,
        { lUrn, packageUrn, requiredVersion, isDev , commitHash },
    );
}

export async function linkRepositoryDependsOnPackage(qualifiedRepoName: string, packageUrn: string, requiredVersion: string, isDev: boolean, commitHash: string) {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    await run(
        `MATCH (r:Repository {id: $rUrn}), (p:Package {id: $packageUrn})
     MERGE (r)-[rel:DEPENDS_ON]->(p)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null
     SET rel.requiredVersion = $requiredVersion, rel.installedVersion = null, rel.isDev = $isDev`,
        { rUrn, packageUrn, requiredVersion, isDev , commitHash },
    );
}

/**
 * Retrieve all Service and Library names from the graph.
 * Used to build the "known internal" set for emergent internal package detection.
 */
export async function getKnownInternalNames(): Promise<Set<string>> {
    const result = await run(
        `MATCH (n) WHERE n:Service OR n:Library
     RETURN n.name AS name`,
    );
    return new Set(result.records.map(r => r.get('name') as string).filter(Boolean));
}

/**
 * Upsert a Release node and link it to its parent Package.
 * Uses MERGE on the Release ID (deterministic URN) for idempotency.
 * publishedAt is set ON CREATE only — once recorded, it's immutable.
 */
export async function mergeRelease(
    ecosystem: string,
    packageName: string,
    version: string,
    releaseSource: string,   // 'manifest' | 'tag' | 'registry' | 'webhook' — release-discovery method
    commitHash: string,
    publishedAt?: string,
) {
    const releaseUrn = buildUrn('release', ecosystem, packageName, version);
    const packageUrn = buildUrn('package', ecosystem, packageName);
    const prov = astGrounding(`release-${releaseSource}@v1`);
    await run(
        `MERGE (rel:Release {id: $releaseUrn})
         ON CREATE SET rel.version = $version,
                       rel.publishedAt = CASE WHEN $publishedAt IS NOT NULL
                                              THEN $publishedAt
                                              ELSE toString(datetime()) END,
                       rel.releaseSource = $releaseSource,
                       rel.commitHash = $commitHash,
                       rel.valid_from_commit = $commitHash,
                       rel.valid_to_commit = null
         ON MATCH SET  rel.releaseSource = CASE
                           WHEN $releaseSource IN ['tag','registry','webhook']
                           THEN $releaseSource ELSE rel.releaseSource END,
                       rel.publishedAt = CASE
                           WHEN $publishedAt IS NOT NULL AND $releaseSource IN ['tag','registry','webhook']
                           THEN $publishedAt ELSE rel.publishedAt END,
                       rel.valid_to_commit = null
         ${groundingWriteClause('rel')}
         MERGE (p:Package {id: $packageUrn})
         ON CREATE SET p.name = $packageName, p.ecosystem = $ecosystem,
                       p.valid_from_commit = coalesce(p.valid_from_commit, $commitHash),
                       p.valid_to_commit = null
         SET p.isInternal = true
         MERGE (p)-[:HAS_RELEASE]->(rel)`,
        { releaseUrn, packageUrn, packageName, ecosystem, version, releaseSource, commitHash, publishedAt: publishedAt ?? null, ...groundingParams(prov, commitHash) },
    );
}

/**
 * Declare a Repository as the publisher of a Package.
 * Updates Package.latestKnownVersion only if the new version is semver-greater
 * than the current value (prevents dev placeholders from overwriting real versions).
 */
export async function linkRepositoryPublishesPackage(
    qualifiedRepoName: string,
    ecosystem: string,
    packageName: string,
    version: string,
    registryUrl: string | null,
    confidence: string,
    commitHash: string,
) {
    const rUrn = buildUrn('repository', qualifiedRepoName);
    const pUrn = buildUrn('package', ecosystem, packageName);

    // Read current latestKnownVersion to do semver comparison in TS
    const result = await run(
        `MATCH (p:Package {id: $pUrn}) RETURN p.latestKnownVersion AS current`,
        { pUrn },
    );
    const currentVersion = result.records.length > 0
        ? (result.records[0].get('current') as string | null)
        : null;

    // Only update if new version is semver-greater or current is unset
    const shouldUpdate = !currentVersion
        || !semver.valid(currentVersion)
        || (semver.valid(version) && semver.gt(version, currentVersion));

    const versionToSet = shouldUpdate ? version : currentVersion!;
    const confidenceToSet = shouldUpdate ? confidence : undefined;

    await run(
        `MERGE (r:Repository {id: $rUrn})
         ON CREATE SET r.name = $qualifiedRepoName, r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null
         MERGE (p:Package {id: $pUrn})
         ON CREATE SET p.name = $packageName, p.ecosystem = $ecosystem,
                       p.valid_from_commit = $commitHash, p.valid_to_commit = null
         SET p.isInternal = true,
             p.latestKnownVersion = $version,
             p.latestKnownConfidence = CASE WHEN $confidence IS NOT NULL THEN $confidence ELSE p.latestKnownConfidence END,
             p.publishRegistry = $registryUrl,
             p.sourceRepoName = $qualifiedRepoName,
             p.valid_to_commit = null
         MERGE (r)-[rel:PUBLISHES]->(p)
         SET rel.publishedVersion = $version,
             rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
             rel.valid_to_commit = null`,
        { rUrn, pUrn, qualifiedRepoName, packageName, ecosystem, version: versionToSet, registryUrl, confidence: confidenceToSet ?? null, commitHash },
    );
}

/**
 * Recompute latestKnownVersion from all Release nodes for a package.
 * Called after git tag backfill to ensure the highest semver version wins.
 */
export async function recomputeLatestVersion(
    ecosystem: string,
    packageName: string,
): Promise<void> {
    const pUrn = buildUrn('package', ecosystem, packageName);

    // Fetch all release versions for this package
    const result = await run(
        `MATCH (p:Package {id: $pUrn})-[:HAS_RELEASE]->(rel:Release)
         WHERE rel.valid_to_commit IS NULL
         RETURN rel.version AS version, rel.confidence AS confidence`,
        { pUrn },
    );

    if (result.records.length === 0) return;

    // Find the semver-greatest version
    let bestVersion: string | null = null;
    let bestConfidence: string | null = null;
    for (const record of result.records) {
        const v = record.get('version') as string;
        const c = record.get('confidence') as string;
        if (!semver.valid(v)) continue;
        if (!bestVersion || semver.gt(v, bestVersion)) {
            bestVersion = v;
            bestConfidence = c;
        }
    }

    if (bestVersion) {
        await run(
            `MATCH (p:Package {id: $pUrn})
             SET p.latestKnownVersion = $version, p.latestKnownConfidence = $confidence`,
            { pUrn, version: bestVersion, confidence: bestConfidence },
        );
    }
}
