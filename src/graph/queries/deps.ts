/**
 * Package Dependencies Query Service
 *
 * Retrieves all Package nodes from the graph grouped by package name,
 * showing all installed versions and which services/repos use each one.
 */

import { getMemgraphSession } from '../neo4j.js';
import semver from 'semver';
import type { DepsPackageGroup, DepsVersionEntry, DepsReport, DepsVulnerability, ReleaseEntry, DriftSummary } from '@coderadius/shared-types';
import { resolveVulnerabilityDisplayId } from '@coderadius/shared-types';

export type { DepsPackageGroup, DepsVersionEntry, DepsReport, DepsVulnerability, ReleaseEntry, DriftSummary };

/**
 * Query all packages, their versions, and who depends on them.
 */
export async function getPackageDepsReport(filter?: string): Promise<DepsReport> {
    const session = getMemgraphSession();
    try {
        const filterClause = filter ? 'AND toLower(p.name) CONTAINS toLower($filter)' : '';

        // ── Query 1: Dependency edges with consumer metadata ─────────────
        // Uses iterative WITH aggregation to prevent the Cartesian explosion
        // that the old 4-chained OPTIONAL MATCH pattern caused (5.8K edges ×
        // 6.6 fan-out = 38K intermediate rows → 34 seconds).
        const depsResult = await session.run(`
            MATCH (consumer)-[r:DEPENDS_ON]->(p:Package)
            WHERE r.valid_to_commit IS NULL AND p.valid_to_commit IS NULL
              AND consumer.valid_to_commit IS NULL ${filterClause}

            // Step 0: Dedup — skip Repository consumer when a Service in the
            // same repo already has a DEPENDS_ON edge to the same Package.
            // The Repository edge stays in the graph (carries installedVersion
            // from lockfile) but is excluded from the consumer list.
            OPTIONAL MATCH (svcDup:Service)-[rDup:DEPENDS_ON]->(p),
                           (svcDup)-[rSi:STORED_IN]->(consumer)
              WHERE consumer:Repository
                AND svcDup.valid_to_commit IS NULL
                AND rDup.valid_to_commit IS NULL
                AND rSi.valid_to_commit IS NULL
            WITH consumer, r, p
            WHERE svcDup IS NULL OR NOT consumer:Repository

            // Step 1: Direct team ownership — aggregate immediately
            OPTIONAL MATCH (t1:Team)-[r_owns:OWNS]->(consumer)
              WHERE t1.valid_to_commit IS NULL AND r_owns.valid_to_commit IS NULL
            WITH p, r, consumer, head(collect(DISTINCT t1.name)) AS directTeam

            // Step 2: Indirect team for Repository consumers via Service→STORED_IN→Repo
            // Aggregate BEFORE proceeding to prevent fan-out
            OPTIONAL MATCH (svc:Service)-[r_si:STORED_IN]->(consumer)
              WHERE consumer:Repository AND svc.valid_to_commit IS NULL AND r_si.valid_to_commit IS NULL
            OPTIONAL MATCH (t2:Team)-[r_owns2:OWNS]->(svc)
              WHERE t2.valid_to_commit IS NULL AND r_owns2.valid_to_commit IS NULL
            WITH p, r, consumer, directTeam, head(collect(DISTINCT t2.name)) AS indirectTeam

            // Step 3: Repo URL and Lockfile Inheritance
            OPTIONAL MATCH (consumer)-[r_stored:STORED_IN]->(repo:Repository)
              WHERE r_stored.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL
              
            // Step 4: Monorepo Lockfile Fallback
            // If the consumer is a Service/Library inside a Repo, check if the Repo has a lockfile edge to the same package
            OPTIONAL MATCH (repo)-[r_repo:DEPENDS_ON]->(p)
              WHERE r_repo.valid_to_commit IS NULL

            RETURN p.name AS packageName,
                   p.ecosystem AS ecosystem,
                   p.isInternal AS isInternal,
                   p.latestKnownVersion AS latestKnownVersion,
                   p.latestKnownConfidence AS latestKnownConfidence,
                   r.requiredVersion AS requiredVersion,
                   coalesce(r.installedVersion, r_repo.installedVersion) AS installedVersion,
                   r.isDev AS isDev,
                   consumer.name AS consumerName,
                   CASE WHEN consumer:Service THEN 'Service'
                        WHEN consumer:Library THEN 'Library'
                        WHEN consumer:Repository THEN 'Repository'
                        ELSE 'Unknown' END AS consumerType,
                   coalesce(directTeam, indirectTeam) AS teamName,
                   coalesce(repo.url,
                     CASE WHEN consumer:Repository THEN consumer.url ELSE null END
                   ) AS repoUrl,
                   coalesce(repo.name,
                     CASE WHEN consumer:Repository THEN consumer.name ELSE null END
                   ) AS repoName,
                   coalesce(repo.livenessCommits,
                     CASE WHEN consumer:Repository THEN consumer.livenessCommits ELSE null END
                   ) AS livenessCommits
            ORDER BY p.name, r.requiredVersion, consumer.name
        `, filter ? { filter } : {});

        // ── Query 2: Package-level publisher & release data ──────────────
        // Queried ONCE per package (not per consumer-package row).
        // With 1.8K packages this is sub-second vs 5.8K pattern comprehension
        // evaluations in the old query.
        const pkgMetaResult = await session.run(`
            MATCH (p:Package) WHERE p.valid_to_commit IS NULL ${filterClause}
            OPTIONAL MATCH (publisher:Repository)-[pub:PUBLISHES]->(p)
              WHERE pub.valid_to_commit IS NULL AND publisher.valid_to_commit IS NULL
            WITH p, head(collect(DISTINCT { name: publisher.name, url: publisher.url })) AS pub
            OPTIONAL MATCH (p)-[:HAS_RELEASE]->(rel:Release)
              WHERE rel.valid_to_commit IS NULL
            RETURN p.name AS packageName,
                   pub.name AS publishedBy,
                   pub.url AS publishedByUrl,
                   collect({ version: rel.version, publishedAt: rel.publishedAt, confidence: rel.confidence }) AS releases
        `, filter ? { filter } : {});

        // Index publisher/release metadata by package name for O(1) lookup
        const pkgMeta = new Map<string, { publishedBy: string | null; publishedByUrl: string | null; releases: ReleaseEntry[] }>();
        for (const rec of pkgMetaResult.records) {
            const name = rec.get('packageName') as string;
            const releases = (rec.get('releases') as any[] ?? []).filter((r: any) => r.version != null);
            pkgMeta.set(name, {
                publishedBy: rec.get('publishedBy') as string | null,
                publishedByUrl: rec.get('publishedByUrl') as string | null,
                releases,
            });
        }

        // ── Query 3: Vulnerability data per package ───────────────────────
        const vulnResult = await session.run(`
            MATCH (p:Package) WHERE p.valid_to_commit IS NULL ${filterClause}
            OPTIONAL MATCH (p)-[hv:HAS_VULNERABILITY]->(v:Vulnerability)
              WHERE hv.valid_to_commit IS NULL AND v.valid_to_commit IS NULL
            WITH p.name AS packageName,
                 collect(CASE WHEN v IS NOT NULL THEN {
                   osvId: v.osvId,
                   aliases: v.aliases,
                   severity: v.severity,
                   summary: v.summary,
                   affectedVersions: hv.vulnerableInstalledVersions
                 } END) AS vulns
            WHERE size(vulns) > 0
            RETURN packageName, vulns
        `, filter ? { filter } : {});

        interface RawVuln extends DepsVulnerability { affectedVersions?: string[] }
        const vulnMap = new Map<string, RawVuln[]>();
        for (const rec of vulnResult.records) {
            const name = rec.get('packageName') as string;
            const vulns = (rec.get('vulns') as any[] ?? []).filter(Boolean) as RawVuln[];
            if (vulns.length > 0) vulnMap.set(name, vulns);
        }

        // ── Group in memory (same logic as before) ───────────────────────
        const groupMap = new Map<string, DepsPackageGroup>();

        for (const record of depsResult.records) {
            const pkgName = record.get('packageName') as string;
            const ecosystem = record.get('ecosystem') as string;
            const isInternal = record.get('isInternal') as boolean;
            const requiredVersion = record.get('requiredVersion') as string;
            const installedVersion = record.get('installedVersion') as string | null;
            const isDev = record.get('isDev') as boolean;
            const consumerName = record.get('consumerName') as string;
            const consumerType = record.get('consumerType') as 'Service' | 'Library' | 'Repository';
            const teamName = record.get('teamName') as string | null;
            const repoUrl = record.get('repoUrl') as string | null;
            const repoName = record.get('repoName') as string | null;
            const rawLivenessCommits = record.get('livenessCommits');
            const livenessCommits = rawLivenessCommits != null
                ? (typeof rawLivenessCommits === 'object' && 'toNumber' in rawLivenessCommits
                    ? rawLivenessCommits.toNumber() : Number(rawLivenessCommits))
                : undefined;
            
            const latestKnownVersion = record.get('latestKnownVersion') as string | null;
            const latestKnownConfidence = record.get('latestKnownConfidence') as string | null;

            if (!groupMap.has(pkgName)) {
                const meta = pkgMeta.get(pkgName);
                const vulns = vulnMap.get(pkgName);
                groupMap.set(pkgName, {
                    packageName: pkgName,
                    ecosystem,
                    isInternal,
                    versions: [],
                    totalConsumers: 0,
                    hasVersionSkew: false,
                    latestPublished: latestKnownVersion ?? undefined,
                    versionConfidence: latestKnownConfidence ?? undefined,
                    publishedBy: meta?.publishedBy ?? undefined,
                    publishedByUrl: meta?.publishedByUrl ?? undefined,
                    releaseHistory: meta?.releases ?? [],
                    vulnerabilities: vulns,
                });
            }

            const group = groupMap.get(pkgName)!;

            const displayVersion = installedVersion || requiredVersion || '?';
            const isLocked = installedVersion !== null;
            
            // Find or create version entry
            let versionEntry = group.versions.find(
                (v) => v.displayVersion === displayVersion && v.isLocked === isLocked && v.isDev === isDev,
            );
            if (!versionEntry) {
                versionEntry = {
                    displayVersion,
                    isLocked,
                    isDev,
                    driftLevel: undefined, // computed in post-processing
                    consumers: [],
                };
                group.versions.push(versionEntry);
            }

            // Deduplicate consumer entries per version by repo
            // In a monorepo, multiple services share the same repo and package edge.
            // Collapse to one consumer per repo to avoid N identical "acme-platform" rows.
            const dedupKey = repoName || consumerName;
            const existing = versionEntry.consumers.find(c => (c.repoName || c.name) === dedupKey);
            if (!existing) {
                versionEntry.consumers.push({
                    name: consumerName,
                    type: consumerType,
                    team: teamName,
                    url: repoUrl,
                    repoName,
                    requiredVersion,
                    livenessCommits,
                });
            } else {
                if (!existing.team && teamName) existing.team = teamName;
                if (!existing.url && repoUrl) existing.url = repoUrl;
            }
        }

        // Post-process: compute totals and skew
        const packages: DepsPackageGroup[] = [];
        for (const group of groupMap.values()) {
            const allConsumers = new Set<string>();
            for (const v of group.versions) {
                for (const c of v.consumers) allConsumers.add(c.name);
            }
            group.totalConsumers = allConsumers.size;

            // Skew is when we have more than one distinct displayVersion
            const distinctDisplay = new Set(group.versions.map(v => v.displayVersion));
            
            group.hasVersionSkew = distinctDisplay.size > 1;

            // Sort versions descending by displayVersion
            group.versions.sort((a, b) => {
                return b.displayVersion.localeCompare(a.displayVersion, undefined, { numeric: true });
            });
            
            // Compute Version Drift if we have a latest published version
            if (group.latestPublished) {
                const drift: DriftSummary = {
                    maxLevel: 'none',
                    consumersAtMajorDrift: 0,
                    consumersAtMinorDrift: 0,
                    consumersAtPatchDrift: 0,
                    consumersUpToDate: 0,
                };
                
                for (const v of group.versions) {
                    let level: 'major' | 'minor' | 'patch' | 'none' = 'none';
                    // Skip workspace: protocol and wildcard versions (not meaningful for drift)
                    if (v.displayVersion?.startsWith('workspace:') || v.displayVersion === '*') {
                        v.driftLevel = 'none';
                        drift.consumersUpToDate += v.consumers.length;
                        continue;
                    }

                    let targetVer: string | undefined;
                    if (v.isLocked) {
                        targetVer = v.displayVersion;
                    } else {
                        try {
                            targetVer = semver.minVersion(v.displayVersion)?.version;
                        } catch {
                            // Non-semver specs (Composer file:/path:, git URLs, dev-master, etc.) — leave drift at 'none'
                            targetVer = undefined;
                        }
                    }

                    if (targetVer && semver.valid(targetVer) && semver.valid(group.latestPublished)) {
                        const diff = semver.diff(targetVer, group.latestPublished);
                        if (diff === 'major' || diff === 'premajor') level = 'major';
                        else if (diff === 'minor' || diff === 'preminor') level = 'minor';
                        else if (diff === 'patch' || diff === 'prepatch') level = 'patch';
                    }
                    
                    // Piggyback driftLevel onto each version entry
                    v.driftLevel = level;
                    
                    const consumerCount = v.consumers.length;
                    if (level === 'major') drift.consumersAtMajorDrift += consumerCount;
                    else if (level === 'minor') drift.consumersAtMinorDrift += consumerCount;
                    else if (level === 'patch') drift.consumersAtPatchDrift += consumerCount;
                    else drift.consumersUpToDate += consumerCount;
                    
                    // Update maxLevel
                    if (level === 'major') drift.maxLevel = 'major';
                    else if (level === 'minor' && drift.maxLevel !== 'major') drift.maxLevel = 'minor';
                    else if (level === 'patch' && drift.maxLevel === 'none') drift.maxLevel = 'patch';
                }
                
                group.drift = drift;
            }

            // Stamp CVE IDs per version entry and filter package-level
            // vulnerabilities to only those affecting installed versions.
            // Uses semver range matching: affectedVersions may contain exact
            // versions ("2.3.5"), ranges (">=1.0.0 <2.0.0"), or wildcards ("*").
            const pkgVulns = vulnMap.get(group.packageName);
            if (pkgVulns && pkgVulns.length > 0) {
                const activeVulns: typeof pkgVulns = [];

                for (const vuln of pkgVulns) {
                    const affected = vuln.affectedVersions ?? [];
                    const isWildcard = affected.includes('*');
                    const cveId = resolveVulnerabilityDisplayId(vuln);
                    let matchedAny = false;

                    for (const v of group.versions) {
                        const ver = v.displayVersion;
                        if (!ver || ver === '?') continue;
                        const isAffected = isWildcard || affected.some(range => {
                            if (range === ver) return true;
                            try { return semver.satisfies(ver, range, { includePrerelease: true }); } catch { return false; }
                        });
                        if (isAffected) {
                            if (!v.cveIds) v.cveIds = [];
                            v.cveIds.push(cveId);
                            matchedAny = true;
                        }
                    }

                    if (matchedAny) activeVulns.push(vuln);
                }

                group.vulnerabilities = activeVulns.length > 0 ? activeVulns : undefined;
            }

            packages.push(group);
        }

        // Sort: skewed first, then by consumer count desc, then name
        packages.sort((a, b) => {
            if (a.hasVersionSkew !== b.hasVersionSkew) return a.hasVersionSkew ? -1 : 1;
            if (b.totalConsumers !== a.totalConsumers) return b.totalConsumers - a.totalConsumers;
            return a.packageName.localeCompare(b.packageName);
        });

        const ecosystems = [...new Set(packages.map(p => p.ecosystem))].sort();

        return {
            packages,
            summary: {
                totalPackages: packages.length,
                totalWithSkew: packages.filter(p => p.hasVersionSkew).length,
                ecosystems,
            },
        };
    } finally {
        await session.close();
    }
}
