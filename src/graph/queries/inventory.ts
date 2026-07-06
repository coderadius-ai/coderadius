/**
 * System Registry — Inventory Queries
 *
 * Extracts aggregated inventory data from Memgraph for the System Registry
 * dashboard tab. Three lightweight queries that provide a factual census
 * of repositories, services, and teams — zero heuristics, zero opinions.
 *
 * Design: each query is a single MATCH with aggregation. Cost is O(n)
 * where n = number of nodes, which is negligible for dashboard generation.
 */

import { getMemgraphSession } from '../neo4j.js';
import { resolveScanMode } from '../scan-mode.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InventoryRepo {
    name: string;
    url: string | null;
    org: string | null;
    repoHash: string | null;
    services: string[];
    fileCount: number;
    functionCount: number;
    teams: string[];
    languages: string[];
    /** Inferred ingestion depth: 'contracts' (data contract extraction), 'semantic' (code analysis), 'structure' (structural only) */
    ingestionLevel: 'contracts' | 'semantic' | 'structure';
    /** Git branch at time of last ingestion */
    branch: string | null;
    /** The canonical default branch (main, master) */
    defaultBranch: string | null;
    /** Core branches: main, master, develop, release/*, hotfix/*, etc. */
    coreBranches: string[];
    /** SCM hosting platform: github | gitlab | bitbucket | azure-devops | unknown */
    hostingPlatform: string | null;
    /** Liveness pulse — raw 12-month commit count. */
    livenessCommits: number | null;
    /** ISO UTC timestamp of the last successful analysis/cache validation. */
    lastAnalyzedAt: string | null;
    /** Structural governance nodes */
    ciPipelines: Array<{ tool: string; filePath: string; hasTestStage: boolean; hasDeployStage: boolean; jobCount: number; stages?: string; triggers?: string }>;
    dockerImages: Array<{ imageTag: string | null; imageName: string | null; filePath: string; context: 'base_image' | 'infrastructure' | 'ci_runner'; scope: string }>;
    toolConfigs: Array<{ toolType: string; filePath: string }>;
    tasks: Array<{ name: string; runner: string | null }>;
}

export interface InventoryService {
    /** Canonical `cr:service:{repo}:{name}` URN. Used to deep-link into the Blast Radius Explorer. */
    urn: string;
    name: string;
    team: string | null;
    languages: string[];
    repository: { name: string | null; url: string | null };
    indexedFunctionCount: number;
    exposedEndpointCount: number;
    dependencyCount: number;
}

export interface InventoryTeam {
    name: string;
    teamType: string | null;
    serviceCount: number;
    repoCount: number;
    languages: string[];
}

/** Single-level org grouping (GitLab base group, GitHub org, IDP unit). */
export interface InventoryOrganization {
    name: string;
    fullPath: string;
    repoCount: number;
    serviceCount: number;
}

export interface InventoryTenant {
    name: string;
    slug: string;
    description?: string;
}

/** A deployment surface of an API: where it answers, in which env, for whom. */
export interface InventoryApiDeployment {
    url: string;
    environment: string;
    visibility: string;
}

export interface InventoryApiEndpoint {
    /** Null for non-HTTP operations (GraphQL SDL). */
    method: string | null;
    path: string;
}

export interface InventoryApiExposer {
    service: string;
    serviceUrn: string;
}

/** One exposed logical API surface with everything the catalog row needs. */
export interface InventoryApi {
    urn: string;
    title: string;
    version: string;
    apiSource: string;
    exposers: InventoryApiExposer[];
    team: string | null;
    repository: string | null;
    specPath: string | null;
    deployments: InventoryApiDeployment[];
    endpoints: InventoryApiEndpoint[];
    consumerCount: number;
}

export interface InventoryReport {
    repositories: InventoryRepo[];
    services: InventoryService[];
    teams: InventoryTeam[];
    organizations: InventoryOrganization[];
    apiCatalog: InventoryApi[];
    tenant?: InventoryTenant;
    summary: {
        totalRepos: number;
        totalServices: number;
        totalTeams: number;
        totalFiles: number;
        totalFunctions: number;
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe integer extraction from Neo4j Integer objects */
function toNumber(val: any): number {
    if (val == null) return 0;
    if (typeof val === 'number') return val;
    if (typeof val?.toNumber === 'function') return val.toNumber();
    return Number(val) || 0;
}

/** Map Repository.scanMode to the three-level ingestion depth */
function resolveIngestionLevel(scanMode: string | null, fileCount: number): 'contracts' | 'semantic' | 'structure' {
    const mode = resolveScanMode(scanMode);
    if (mode === 'contracts') return 'contracts';
    if (mode === 'semantic') return 'semantic';
    // scanMode null = no code pipeline was run; check if any files exist
    if (fileCount > 0) return 'semantic';
    return 'structure';
}

// ─── Queries ─────────────────────────────────────────────────────────────────

async function getRepositories(): Promise<InventoryRepo[]> {
    const session = getMemgraphSession();
    try {
        // ── Query 1: Base repo / service / team data (no structural nodes) ──
        const baseResult = await session.run(
            `MATCH (r:Repository) WHERE r.valid_to_commit IS NULL

             OPTIONAL MATCH (r)-[:CONTAINS]->(sf:SourceFile)
               WHERE sf.valid_to_commit IS NULL
             WITH r, count(DISTINCT sf) AS fileCount

             OPTIONAL MATCH (s:Service)-[rs:STORED_IN]->(r)
               WHERE rs.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
             WITH r, fileCount, s

             OPTIONAL MATCH (s)-[:CONTAINS]->(f:Function)
               WHERE f.valid_to_commit IS NULL
             OPTIONAL MATCH (f)-[:WRITTEN_IN]->(flang:Technology)
             WITH r, fileCount, s, count(DISTINCT f) AS functionCount, collect(DISTINCT flang.slug) AS fnLanguages

             OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
               WHERE t.valid_to_commit IS NULL
             WITH r, fileCount, s, functionCount, fnLanguages, t
             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)

             WITH r, fileCount,
                  collect(DISTINCT s.name) AS services,
                  sum(functionCount) AS functionCount,
                  collect(DISTINCT t.name) AS teams,
                  collect(DISTINCT slang.slug) AS svcLanguages,
                  collect(fnLanguages) AS fnLanguagesList

             OPTIONAL MATCH (r)-[:BELONGS_TO]->(orgNode:Organization)

             RETURN r.name AS name, r.url AS url, orgNode.fullPath AS org, r.repoHash AS repoHash,
                    services, fileCount, functionCount, teams, svcLanguages, fnLanguagesList,
                    r.scanMode AS scanMode,
                    r.branch AS branch,
                    r.defaultBranch AS defaultBranch,
                    r.coreBranches AS coreBranches,
                    coalesce(r.hostingPlatform, 'unknown') AS hostingPlatform,
                    r.livenessCommits AS livenessCommits,
                    r.lastAnalyzedAt AS lastAnalyzedAt
             ORDER BY name`
        );

        // ── Query 2: Flat structural data — one row per (repo, entity) pair ──
        // Returns all structural nodes in a single flat result set with type
        // discrimination. Zero cartesian products — each row is an independent match.
        const structResult = await session.run(
            `MATCH (r:Repository) WHERE r.valid_to_commit IS NULL
             OPTIONAL MATCH (r)<-[:STORED_IN]-(svc:Service)-[rel1]->(e1)
               WHERE type(rel1) IN ['HAS_CI_PIPELINE', 'HAS_DOCKER_IMAGE', 'HAS_TOOL_CONFIG', 'HAS_TASK']
             OPTIONAL MATCH (r)-[rel2]->(e2)
               WHERE type(rel2) IN ['HAS_CI_PIPELINE', 'HAS_DOCKER_IMAGE', 'HAS_TOOL_CONFIG', 'HAS_TASK']
             WITH r,
                  collect({rel: type(rel1), e: e1}) + collect({rel: type(rel2), e: e2}) AS combined
             UNWIND combined AS row
             WITH r, row WHERE row.e IS NOT NULL
             WITH DISTINCT r.name AS repoName, row.rel AS relType, row.e AS entity
             RETURN repoName, relType, entity.id AS entityId,
                    entity.tool AS tool, entity.filePath AS filePath,
                    entity.hasTestStage AS hasTestStage, entity.hasDeployStage AS hasDeployStage,
                    entity.jobCount AS jobCount, entity.stages AS stages, entity.triggers AS triggers,
                    entity.tag AS tag, entity.name AS entityName,
                    entity._sourcePath AS sourcePath,
                    entity.source AS source`
        );

        // ── Query 2b: Docker images with provenance context ─────────────────
        // Traverses the (StructuralFile)-[USES_BASE_IMAGE|USES_IMAGE]->(DockerImage)
        // provenance chain to read context/scope from edge properties.
        const dockerProvenanceResult = await session.run(
            `MATCH (r:Repository) WHERE r.valid_to_commit IS NULL
             OPTIONAL MATCH (r)-[:HAS_CONFIG]->(sf:StructuralFile)-[imgRel]->(img:DockerImage)
               WHERE type(imgRel) IN ['USES_BASE_IMAGE', 'USES_IMAGE']
             OPTIONAL MATCH (r)<-[:STORED_IN]-(svc:Service)-[:HAS_CONFIG]->(sf2:StructuralFile)-[imgRel2]->(img2:DockerImage)
               WHERE type(imgRel2) IN ['USES_BASE_IMAGE', 'USES_IMAGE']
             WITH r,
                  collect({img: img, rel: type(imgRel), ctx: imgRel.context, scope: imgRel.scope, fp: sf.path})
                + collect({img: img2, rel: type(imgRel2), ctx: imgRel2.context, scope: imgRel2.scope, fp: sf2.path})
                  AS combined
             UNWIND combined AS row
             WITH r, row WHERE row.img IS NOT NULL
             WITH DISTINCT r.name AS repoName, row.img AS img, row.rel AS relType,
                  row.ctx AS context, row.scope AS scope, row.fp AS filePath
             RETURN repoName, img.name AS imageName, img.tag AS imageTag, filePath,
                    CASE WHEN relType = 'USES_BASE_IMAGE' THEN 'base_image'
                         ELSE coalesce(context, 'infrastructure') END AS context,
                    coalesce(scope, 'unknown') AS scope`
        );

        // ── Build structural lookup map: repoName → categorised entities ──
        type StructBucket = {
            ciPipelines: InventoryRepo['ciPipelines'];
            dockerImages: InventoryRepo['dockerImages'];
            toolConfigs: InventoryRepo['toolConfigs'];
            tasks: InventoryRepo['tasks'];
        };
        const structMap = new Map<string, StructBucket>();

        for (const rec of structResult.records) {
            const repoName = rec.get('repoName') as string;
            const relType = rec.get('relType') as string;
            const entityId = rec.get('entityId') as string;

            let bucket = structMap.get(repoName);
            if (!bucket) {
                bucket = { ciPipelines: [], dockerImages: [], toolConfigs: [], tasks: [] };
                structMap.set(repoName, bucket);
            }

            switch (relType) {
                case 'HAS_CI_PIPELINE': {
                    const tool = rec.get('tool') as string;
                    if (tool && !bucket.ciPipelines.some(ci => ci.filePath === rec.get('filePath'))) {
                        bucket.ciPipelines.push({
                            tool,
                            filePath: (rec.get('filePath') || rec.get('sourcePath') || '') as string,
                            hasTestStage: rec.get('hasTestStage') === true,
                            hasDeployStage: rec.get('hasDeployStage') === true,
                            jobCount: toNumber(rec.get('jobCount')),
                            stages: (rec.get('stages') as string | undefined),
                            triggers: (rec.get('triggers') as string | undefined),
                        });
                    }
                    break;
                }
                case 'HAS_DOCKER_IMAGE': {
                    // Shortcut-based Docker images — backward compat for existing data.
                    // These are supplemented by Query 2b provenance results below.
                    const fp = (rec.get('sourcePath') || rec.get('filePath') || '') as string;
                    const imgTag = (rec.get('tag') as string) || null;
                    if (!bucket.dockerImages.some(d => d.filePath === fp && d.imageTag === imgTag)) {
                        bucket.dockerImages.push({
                            imageTag: imgTag,
                            imageName: (rec.get('entityName') as string) || null,
                            filePath: fp,
                            context: 'base_image',  // Shortcut edges are always from dockerfilePlugin
                            scope: 'production',
                        });
                    }
                    break;
                }
                case 'HAS_TOOL_CONFIG': {
                    const toolType = (rec.get('tool') as string) || null;
                    const fp = (rec.get('sourcePath') || rec.get('filePath') || '') as string;
                    if (toolType && !bucket.toolConfigs.some(t => t.filePath === fp)) {
                        bucket.toolConfigs.push({ toolType, filePath: fp });
                    }
                    break;
                }
                case 'HAS_TASK': {
                    const name = rec.get('entityName') as string;
                    if (name && !bucket.tasks.some(t => t.name === name)) {
                        bucket.tasks.push({
                            name,
                            runner: (rec.get('source') as string) || null,
                        });
                    }
                    break;
                }
            }
        }

        // ── Merge provenance-based Docker images (Query 2b) ─────────────────
        for (const rec of dockerProvenanceResult.records) {
            const repoName = rec.get('repoName') as string;
            let bucket = structMap.get(repoName);
            if (!bucket) {
                bucket = { ciPipelines: [], dockerImages: [], toolConfigs: [], tasks: [] };
                structMap.set(repoName, bucket);
            }

            const imgName = (rec.get('imageName') as string) || null;
            const imgTag = (rec.get('imageTag') as string) || null;
            const fp = (rec.get('filePath') as string) || '';
            const ctx = (rec.get('context') as string) || 'infrastructure';
            const scope = (rec.get('scope') as string) || 'unknown';

            // Dedup: skip if same image+filePath already present
            if (!bucket.dockerImages.some(d => d.imageName === imgName && d.imageTag === imgTag && d.filePath === fp)) {
                bucket.dockerImages.push({
                    imageTag: imgTag,
                    imageName: imgName,
                    filePath: fp,
                    context: ctx as 'base_image' | 'infrastructure' | 'ci_runner',
                    scope,
                });
            }
        }

        // ── Merge base repos with structural data ──
        return baseResult.records.map((r: any) => {
            const fileCount = toNumber(r.get('fileCount'));
            const functionCount = toNumber(r.get('functionCount'));
            const name = r.get('name') as string;
            const bucket = structMap.get(name);

            const svcLanguages: string[] = (r.get('svcLanguages') || []).filter(Boolean);
            const fnLanguagesList: string[][] = (r.get('fnLanguagesList') || []);
            const allLanguages = [...new Set([
                ...svcLanguages,
                ...fnLanguagesList.flat()
            ])].filter(l => l !== 'unknown');

            return {
                name,
                url: r.get('url') || null,
                org: r.get('org') || null,
                repoHash: r.get('repoHash') || null,
                services: (r.get('services') || []).filter(Boolean),
                fileCount,
                functionCount,
                teams: (r.get('teams') || []).filter(Boolean),
                languages: allLanguages,
                ingestionLevel: resolveIngestionLevel(r.get('scanMode'), fileCount),
                branch: r.get('branch') || null,
                defaultBranch: r.get('defaultBranch') || null,
                coreBranches: (r.get('coreBranches') || []).filter(Boolean) as string[],
                hostingPlatform: r.get('hostingPlatform') || null,
                livenessCommits: r.get('livenessCommits') != null ? toNumber(r.get('livenessCommits')) : null,
                lastAnalyzedAt: r.get('lastAnalyzedAt') || null,
                ciPipelines: bucket?.ciPipelines ?? [],
                dockerImages: bucket?.dockerImages ?? [],
                toolConfigs: bucket?.toolConfigs ?? [],
                tasks: bucket?.tasks ?? [],
            };
        });
    } finally {
        await session.close();
    }
}


async function getServices(): Promise<InventoryService[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (s:Service) WHERE s.valid_to_commit IS NULL
             
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s)
               WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             WITH s, t
             
             OPTIONAL MATCH (s)-[rel:STORED_IN]->(r:Repository)
               WHERE rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
             WITH s, t, r
             
             OPTIONAL MATCH (s)-[:CONTAINS]->(f:Function)
               WHERE f.valid_to_commit IS NULL
             OPTIONAL MATCH (f)-[:WRITTEN_IN]->(flang:Technology)
             WITH s, t, r, count(DISTINCT f) AS fnCount, collect(DISTINCT flang.slug) AS fnLanguages
             
             OPTIONAL MATCH (s)-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
               WHERE api.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
             WITH s, t, r, fnCount, fnLanguages, count(DISTINCT ep) AS endpointCount
             
             OPTIONAL MATCH (s)-[:CONTAINS]->(fn:Function)-[dep]->(target)
               WHERE fn.valid_to_commit IS NULL AND target.valid_to_commit IS NULL
                 AND type(dep) IN ['CALLS', 'READS', 'WRITES', 'LISTENS_TO', 'PUBLISHES_TO',
                                    'CONSUMES', 'COMMUNICATES_WITH', 'SPAWNS', 'DEPENDS_ON', 'PRODUCES']
             WITH s, t, r, fnCount, fnLanguages, endpointCount, count(DISTINCT target) AS depCount

             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)

             RETURN s.urn AS urn, s.name AS name, slang.slug AS language,
                    t.name AS team, r.name AS repoName, r.url AS repoUrl,
                    fnCount, fnLanguages, endpointCount, depCount
             ORDER BY s.name`
        );

        return result.records.map((r: any) => {
            const fnLanguages: string[] = (r.get('fnLanguages') || []).filter(Boolean);
            const svcLanguage: string | null = r.get('language');
            const languages = [...new Set([
                ...(svcLanguage ? [svcLanguage] : []),
                ...fnLanguages,
            ])].filter(l => l !== 'unknown');

            return {
                urn: r.get('urn'),
                name: r.get('name'),
                team: r.get('team') || null,
                languages,
                repository: {
                    name: r.get('repoName') || null,
                    url: r.get('repoUrl') || null,
                },
                indexedFunctionCount: toNumber(r.get('fnCount')),
                exposedEndpointCount: toNumber(r.get('endpointCount')),
                dependencyCount: toNumber(r.get('depCount')),
            };
        });
    } finally {
        await session.close();
    }
}

async function getTeams(): Promise<InventoryTeam[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (t:Team) WHERE t.valid_to_commit IS NULL
             
             OPTIONAL MATCH (t)-[:OWNS]->(s:Service)
               WHERE s.valid_to_commit IS NULL
             WITH t, s
             
             OPTIONAL MATCH (s)-[:CONTAINS]->(f:Function)
               WHERE f.valid_to_commit IS NULL
             OPTIONAL MATCH (f)-[:WRITTEN_IN]->(flang:Technology)
             WITH t, s, collect(DISTINCT flang.slug) AS fnLanguages
             
             OPTIONAL MATCH (s)-[:STORED_IN]->(r:Repository)
               WHERE r.valid_to_commit IS NULL
             WITH t, s, fnLanguages, r
             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
             
             WITH t,
                  count(DISTINCT s) AS serviceCount,
                  count(DISTINCT r) AS repoCount,
                  collect(DISTINCT slang.slug) AS svcLanguages,
                  collect(fnLanguages) AS fnLanguagesList
             RETURN t.name AS name, t.teamType AS teamType,
                    serviceCount, repoCount, svcLanguages, fnLanguagesList
             ORDER BY t.name`
        );

        return result.records.map((r: any) => {
            const svcLanguages: string[] = (r.get('svcLanguages') || []).filter(Boolean);
            const fnLanguagesList: string[][] = (r.get('fnLanguagesList') || []);
            const allLanguages = [...new Set([
                ...svcLanguages,
                ...fnLanguagesList.flat()
            ])].filter(l => l !== 'unknown');

            return {
                name: r.get('name'),
                teamType: r.get('teamType') || null,
                serviceCount: toNumber(r.get('serviceCount')),
                repoCount: toNumber(r.get('repoCount')),
                languages: allLanguages,
            };
        });
    } finally {
        await session.close();
    }
}

// ─── Organizations (single-level) ────────────────────────────────────────────

async function getOrganizations(): Promise<InventoryOrganization[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (o:Organization)
             OPTIONAL MATCH (r:Repository)-[:BELONGS_TO]->(o)
               WHERE r.valid_to_commit IS NULL
             OPTIONAL MATCH (s:Service)-[:STORED_IN]->(r)
               WHERE s.valid_to_commit IS NULL
             WITH o, count(DISTINCT r) AS repoCount, count(DISTINCT s) AS serviceCount
             RETURN o.name AS name, o.fullPath AS fullPath, repoCount, serviceCount
             ORDER BY o.fullPath`
        );

        return result.records.map((r: any) => ({
            name: r.get('name'),
            fullPath: r.get('fullPath'),
            repoCount: toNumber(r.get('repoCount')),
            serviceCount: toNumber(r.get('serviceCount')),
        }));
    } finally {
        await session.close();
    }
}

async function getTenant(): Promise<InventoryTenant | undefined> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (t:Tenant) RETURN t.name AS name, t.slug AS slug, t.description AS description LIMIT 1`
        );
        if (result.records.length === 0) return undefined;
        const r = result.records[0];
        return {
            name: r.get('name'),
            slug: r.get('slug'),
            description: r.get('description') || undefined,
        };
    } finally {
        await session.close();
    }
}

// ─── API Catalog ─────────────────────────────────────────────────────────────

/**
 * One row per EXPOSED logical API surface. Consumed-only APIs (CONSUMES_API
 * without an exposer) are references to someone else's surface and stay out.
 *
 * Code-inferred ingestion mints one APIInterface node PER ENDPOINT, so node
 * rows are grouped by (service, title, version, source) into the logical
 * surface the catalog actually describes.
 */
async function getApiCatalog(): Promise<InventoryApi[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (s:Service)-[exp:EXPOSES_API]->(api:APIInterface)
             WHERE api.valid_to_commit IS NULL AND s.valid_to_commit IS NULL
               AND exp.valid_to_commit IS NULL

             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s)
               WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             WITH api, s, t

             OPTIONAL MATCH (s)-[rel:STORED_IN]->(r:Repository)
               WHERE rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
             WITH api, s, t, r

             OPTIONAL MATCH (sf:SourceFile)-[:DEFINES_API]->(api)
             WITH api, s, t, r, head(collect(DISTINCT sf.path)) AS specPath

             OPTIONAL MATCH (api)-[da:DEPLOYED_AT]->(d:APIDeployment)
               WHERE da.valid_to_commit IS NULL AND d.valid_to_commit IS NULL
             WITH api, s, t, r, specPath,
                  collect(DISTINCT {url: coalesce(d.canonicalUrl, d.name),
                                    environment: coalesce(d.environment, 'unknown'),
                                    visibility: coalesce(d.visibility, 'unknown')}) AS deployments

             OPTIONAL MATCH (api)-[he:HAS_ENDPOINT]->(ep:APIEndpoint)
               WHERE he.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
             WITH api, s, t, r, specPath, deployments,
                  collect(DISTINCT {method: ep.method, path: ep.path}) AS endpoints

             OPTIONAL MATCH (consumer:Service)-[:CONSUMES_API]->(api)
               WHERE consumer.valid_to_commit IS NULL
             RETURN api.id AS urn, api.title AS title, api.version AS version,
                    coalesce(api.apiSource, 'code') AS apiSource,
                    s.name AS service, s.id AS serviceUrn, t.name AS team,
                    r.name AS repository, specPath, deployments, endpoints,
                    collect(DISTINCT consumer.id) AS consumerIds
             ORDER BY title, service`
        );

        return groupApiSurfaces(result.records.map(mapApiNodeRow));
    } finally {
        await session.close();
    }
}

interface ApiNodeRow extends Omit<InventoryApi, 'consumerCount'> {
    consumerIds: string[];
}

function mapApiNodeRow(r: any): ApiNodeRow {
    const service = r.get('service') || null;
    const serviceUrn = r.get('serviceUrn') || null;
    return {
        urn: r.get('urn'),
        title: r.get('title'),
        version: r.get('version'),
        apiSource: r.get('apiSource'),
        exposers: service && serviceUrn ? [{ service, serviceUrn }] : [],
        team: r.get('team') || null,
        repository: r.get('repository') || null,
        specPath: r.get('specPath') || null,
        deployments: (r.get('deployments') || []).filter((d: any) => d.url != null),
        endpoints: (r.get('endpoints') || []).filter((e: any) => e.path != null),
        consumerIds: (r.get('consumerIds') || []).filter(Boolean),
    };
}

/**
 * Merge per-node rows into logical surfaces, deduping every facet.
 *
 * The key is (repository, title, version, source): the same spec exposed by
 * two services in one repo is ONE surface with two exposers, while a vendored
 * copy in another repo stays a separate (honest) row.
 */
function groupApiSurfaces(rows: ApiNodeRow[]): InventoryApi[] {
    const groups = new Map<string, ApiNodeRow>();
    for (const row of rows) {
        const key = [row.repository, row.title, row.version, row.apiSource].join('|');
        const group = groups.get(key);
        if (!group) {
            groups.set(key, row);
            continue;
        }
        group.urn = group.urn < row.urn ? group.urn : row.urn; // stable key
        group.exposers = dedupeBy([...group.exposers, ...row.exposers], e => e.serviceUrn);
        group.team = group.team ?? row.team;
        group.specPath = group.specPath ?? row.specPath;
        group.deployments = dedupeBy([...group.deployments, ...row.deployments], d => d.url);
        group.endpoints = [...group.endpoints, ...row.endpoints];
        group.consumerIds = [...new Set([...group.consumerIds, ...row.consumerIds])];
    }

    return [...groups.values()].map(({ consumerIds, ...api }) => ({
        ...api,
        exposers: [...api.exposers].sort((a, b) => a.service.localeCompare(b.service)),
        endpoints: dedupeBy(api.endpoints, e => `${e.method} ${e.path}`)
            .sort((a, b) => a.path.localeCompare(b.path) || (a.method ?? '').localeCompare(b.method ?? '')),
        consumerCount: consumerIds.length,
    }));
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
    const seen = new Map<string, T>();
    for (const item of items) {
        if (!seen.has(key(item))) seen.set(key(item), item);
    }
    return [...seen.values()];
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Full inventory report — runs all queries in parallel.
 */
export async function getInventoryReport(): Promise<InventoryReport> {
    const [repositories, services, teams, organizations, apiCatalog, tenant] = await Promise.all([
        getRepositories(),
        getServices(),
        getTeams(),
        getOrganizations(),
        getApiCatalog(),
        getTenant(),
    ]);

    return {
        repositories,
        services,
        teams,
        organizations,
        apiCatalog,
        tenant,
        summary: {
            totalRepos: repositories.length,
            totalServices: services.length,
            totalTeams: teams.length,
            totalFiles: repositories.reduce((sum, r) => sum + r.fileCount, 0),
            totalFunctions: repositories.reduce((sum, r) => sum + r.functionCount, 0),
        },
    };
}
