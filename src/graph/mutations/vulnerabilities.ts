import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { infraGrounding } from '../grounding.js';

const OSV_GROUNDING = infraGrounding('osv-enrichment@v1');

export async function mergeVulnerability(
    osvId: string,
    data: {
        summary: string;
        severity: string;
        aliases?: string[];
        cvssScore?: number;
        cvssVector?: string;
        published?: string;
        modified?: string;
        withdrawn?: string;
        references?: string[];
    },
    commitHash: string,
): Promise<string> {
    const urn = buildUrn('vulnerability', osvId);
    await run(
        `MERGE (v:Vulnerability {id: $urn})
         SET v.osvId = $osvId,
             v.summary = $summary,
             v.severity = $severity,
             v.aliases = $aliases,
             v.cvssScore = $cvssScore,
             v.cvssVector = $cvssVector,
             v.published = $published,
             v.modified = $modified,
             v.withdrawn = $withdrawn,
             v.references = $references,
             v.lastFetchedAt = $lastFetchedAt
         ${groundingWriteClause('v')}`,
        {
            urn,
            osvId,
            summary: data.summary,
            severity: data.severity,
            aliases: data.aliases ?? [],
            cvssScore: data.cvssScore ?? null,
            cvssVector: data.cvssVector ?? null,
            published: data.published ?? null,
            modified: data.modified ?? null,
            withdrawn: data.withdrawn ?? null,
            references: (data.references ?? []).slice(0, 5),
            lastFetchedAt: new Date().toISOString(),
            ...groundingParams(OSV_GROUNDING, commitHash),
        },
    );
    return urn;
}

export async function linkPackageVulnerability(
    packageUrn: string,
    vulnerabilityUrn: string,
    vulnerableInstalledVersions: string[],
    affectedRanges: string,
    fixedVersion: string | null,
    introducedVersion: string | null,
    commitHash: string,
): Promise<void> {
    await run(
        `MATCH (p:Package {id: $packageUrn}), (v:Vulnerability {id: $vulnerabilityUrn})
         MERGE (p)-[rel:HAS_VULNERABILITY]->(v)
         SET rel.vulnerableInstalledVersions = $vulnerableInstalledVersions,
             rel.affectedRanges = $affectedRanges,
             rel.fixedVersion = $fixedVersion,
             rel.introducedVersion = $introducedVersion,
             rel.lastVerifiedAt = $lastVerifiedAt,
             rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
             rel.valid_to_commit = null`,
        {
            packageUrn,
            vulnerabilityUrn,
            vulnerableInstalledVersions,
            affectedRanges,
            fixedVersion,
            introducedVersion,
            lastVerifiedAt: new Date().toISOString(),
            commitHash,
        },
    );
}
