/**
 * Service Discovery Query Service
 *
 * Single source of truth for service-related Cypher queries.
 * Both the CLI and the MCP server delegate to this module.
 */

import { getMemgraphSession } from '../neo4j.js';
import { teamFallbackExpr, teamListFallbackExpr } from '../cypher-utils.js';
import type { ScanMode } from '../scan-mode.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServiceContextHints {
    filePath?: string | undefined;
    repositoryUrl?: string | undefined;
    repositoryName?: string | undefined;
}

export interface ResolvedServiceContext {
    name: string;
    language: string | null;
    description: string | null;
    team: string | null;
    repository: string | null;
    repositoryUrl: string | null;
    pathInRepo: string | null;
}

export interface ServiceSummary {
    id: string;
    name: string;
    description: string | null;
    team: string | null;
    languages: string[];
    repository: { name: string | null; url: string | null };
    indexedFunctionCount: number;
    /** Number of DeploymentUnit facets linked via DEPLOYED_AS (0 for monorepo services) */
    deploymentUnitCount: number;
    /** Inferred topology: 'monolith' if service has DeploymentUnits, 'standard' otherwise */
    topology: 'monolith' | 'standard';
}

export interface ExposedApi {
    title: string;
    version: string;
    endpointCount: number;
    hint: string;
}

export interface ServiceDetails {
    id: string;
    name: string;
    description: string | null;
    team: string | null;
    languages: string[];
    repository: { name: string | null; url: string | null; pathInRepo: string | null };
    exposedApis: ExposedApi[];
    indexedFunctionCount: number;
    /** DeploymentUnit facets of this service (C4 runtime containers). Empty for monorepo services. */
    deploymentUnits: string[];
    infrastructure: InfrastructureBlock;
}

export interface InfrastructureBlock {
    ciPipelines: { tool: string; filePath: string; hasTestStage: boolean; hasDeployStage: boolean; jobCount: number; stages?: string; triggers?: string }[];
    dockerImages: { name: string | null; tag: string | null; filePath: string }[];
    toolConfigs: { tool: string; filePath: string }[];
    tasks: { name: string; runner: string | null }[];
}

export interface RepositoryDetails {
    name: string;
    url: string | null;
    branch: string | null;
    defaultBranch: string | null;
    coreBranches: string[];
    hostingPlatform: string | null;
    scanMode: ScanMode | null;
    /** Raw 12-month no-merges commit count. Tier derived via `tierFromCommits()`. */
    livenessCommits: number | null;
    fileCount: number;
    services: { name: string; language: string | null; team: string | null }[];
    infrastructure: InfrastructureBlock;
}

export interface AmbiguousServiceDetails {
    warning: string;
    availableTargets: string[];
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Helper to map a Neo4j record into a ResolvedServiceContext */
function parseServiceContextRecord(r: any): ResolvedServiceContext {
    return {
        name: r.get('name'),
        language: r.get('language'),
        description: r.get('description'),
        team: r.get('team'),
        repository: r.get('repository'),
        repositoryUrl: r.get('repositoryUrl'),
        pathInRepo: r.get('pathInRepo'),
    };
}

/**
 * Resolve which service the caller is working in using a multi-strategy approach:
 *   1. Match by repository URL
 *   2. Match by repository name (case-insensitive)
 *   3. Match by file path (monorepo sub-path → fuzzy segment match)
 */
export async function resolveServiceContext(hints: ServiceContextHints): Promise<ResolvedServiceContext[]> {
    const session = getMemgraphSession();
    try {
        // Strategy 1: Match by repository URL
        if (hints.repositoryUrl) {
            const result = await session.run(
                `MATCH (s:Service)-[rel:STORED_IN]->(r:Repository)
                 WHERE s.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
                   AND r.url CONTAINS $repoUrl
                 OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
                 WITH s, t, r, collect(rel.path) AS paths
                 OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
                 RETURN s.name AS name, slang.slug AS language, s.description AS description,
                        ${teamFallbackExpr('t', 'r')} AS team, r.name AS repository, r.url AS repositoryUrl,
                        coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), null) AS pathInRepo
                 ORDER BY s.name LIMIT 20`,
                { repoUrl: hints.repositoryUrl }
            );
            if (result.records.length > 0) {
                return result.records.map(parseServiceContextRecord);
            }
        }

        // Strategy 2: Match by repository name
        if (hints.repositoryName) {
            const result = await session.run(
                `MATCH (s:Service)-[rel:STORED_IN]->(r:Repository)
                 WHERE s.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
                   AND toLower(r.name) = toLower($repoName)
                 OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
                 WITH s, t, r, collect(rel.path) AS paths
                 OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
                 RETURN s.name AS name, slang.slug AS language, s.description AS description,
                        ${teamFallbackExpr('t', 'r')} AS team, r.name AS repository, r.url AS repositoryUrl,
                        coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), null) AS pathInRepo
                 ORDER BY s.name LIMIT 20`,
                { repoName: hints.repositoryName }
            );
            if (result.records.length > 0) {
                return result.records.map(parseServiceContextRecord);
            }
        }

        // Strategy 3: Match by file path
        if (hints.filePath) {
            const normalizedPath = hints.filePath.replace(/^\/+/, '').replace(/\/+$/, '');

            // 3a: Match against STORED_IN.path (monorepo sub-paths)
            const result = await session.run(
                `MATCH (s:Service)-[rel:STORED_IN]->(r:Repository)
                 WHERE s.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
                   AND rel.path IS NOT NULL AND rel.path <> ''
                   AND $filePath CONTAINS rel.path
                 OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
                 WITH s, t, r, collect(rel.path) AS paths
                 OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
                 RETURN s.name AS name, slang.slug AS language, s.description AS description,
                        ${teamFallbackExpr('t', 'r')} AS team, r.name AS repository, r.url AS repositoryUrl,
                        coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), null) AS pathInRepo
                 ORDER BY size(coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), '')) DESC
                 LIMIT 5`,
                { filePath: normalizedPath }
            );
            if (result.records.length > 0) {
                return result.records.map(parseServiceContextRecord);
            }

            // 3b: Fuzzy match — extract path segments and match against service names
            const segments = normalizedPath.split('/').filter(Boolean);
            for (const segment of segments.reverse()) {
                const fuzzyResult = await session.run(
                    `MATCH (s:Service)
                     WHERE s.valid_to_commit IS NULL AND toLower(s.name) = toLower($segment)
                     OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
                     OPTIONAL MATCH (s)-[rel:STORED_IN]->(r:Repository) WHERE rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
                     WITH s, t, r, collect(rel.path) AS paths
                     OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
                     RETURN s.name AS name, slang.slug AS language, s.description AS description,
                            ${teamFallbackExpr('t', 'r')} AS team, r.name AS repository, r.url AS repositoryUrl,
                            coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), null) AS pathInRepo
                     LIMIT 5`,
                    { segment }
                );
                if (fuzzyResult.records.length > 0) {
                    return fuzzyResult.records.map(parseServiceContextRecord);
                }
            }
        }

        return [];
    } finally {
        await session.close();
    }
}

/**
 * Whether the Service contains ANY code artifact (Function, Class or
 * SourceFile — schema: `(Service)-[:CONTAINS]->(Function)` and
 * `(Repository / Service / Library)-[:CONTAINS]->(SourceFile)`).
 *
 * Attribution gate for repo-global env defaults (helm values, accessor
 * defaults, config-declared broker connections): those sources describe app
 * processes, so an infra-only compose service (nginx/sftp/assets) must not
 * receive them. Deliberately BROADER than Function-only: a config-only
 * service with SourceFiles but zero extracted Functions still has code.
 */
export async function serviceContainsCodeArtifact(serviceUrn: string): Promise<boolean> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (s:Service {id: $serviceUrn})-[c:CONTAINS]->(x)
             WHERE s.valid_to_commit IS NULL AND c.valid_to_commit IS NULL
               AND x.valid_to_commit IS NULL
               AND (x:Function OR x:Class OR x:SourceFile)
             RETURN count(x) > 0 AS hasCode`,
            { serviceUrn },
        );
        return Boolean(result.records[0]?.get('hasCode'));
    } finally {
        await session.close();
    }
}

/**
 * List all indexed services with summary metadata.
 */
export async function listServices(limit: number = 50, offset: number = 0): Promise<ServiceSummary[]> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (s:Service) WHERE s.valid_to_commit IS NULL
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             OPTIONAL MATCH (s)-[rel:STORED_IN]->(r:Repository) WHERE rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
             OPTIONAL MATCH (s)-[r_contains:CONTAINS]->(f:Function) WHERE r_contains.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
             OPTIONAL MATCH (f)-[:WRITTEN_IN]->(flang:Technology)
             OPTIONAL MATCH (s)-[r_du:DEPLOYED_AS]->(du:DeploymentUnit) WHERE r_du.valid_to_commit IS NULL AND du.valid_to_commit IS NULL
             WITH s, t, r, count(DISTINCT f) AS fnCount, collect(DISTINCT flang.slug) AS fnLanguages, count(DISTINCT du) AS duCount
             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
             RETURN s.id AS id, s.name AS name, slang.slug AS language, s.description AS description,
                    ${teamFallbackExpr('t', 'r')} AS team, r.name AS repoName, r.url AS repoUrl,
                    fnCount, fnLanguages, duCount
             ORDER BY s.name SKIP toInteger($offset) LIMIT toInteger($limit)`,
             { limit, offset }
        );

        return result.records.map((r: any) => {
            const fnLanguages: string[] = (r.get('fnLanguages') || []).filter(Boolean);
            const svcLanguage: string | null = r.get('language');
            const languages = [...new Set([
                ...(svcLanguage ? [svcLanguage] : []),
                ...fnLanguages,
            ])];

            const duCount = typeof r.get('duCount')?.toNumber === 'function'
                ? r.get('duCount').toNumber()
                : r.get('duCount');

            return {
                id: r.get('id'),
                name: r.get('name'),
                description: r.get('description'),
                team: r.get('team'),
                languages,
                repository: {
                    name: r.get('repoName') || null,
                    url: r.get('repoUrl') || null,
                },
                indexedFunctionCount: typeof r.get('fnCount')?.toNumber === 'function'
                    ? r.get('fnCount').toNumber()
                    : r.get('fnCount'),
                deploymentUnitCount: duCount,
                topology: duCount > 0 ? 'monolith' : 'standard',
            };
        });
    } finally {
        await session.close();
    }
}

/**
 * Get detailed information about a specific service including exposed APIs.
 */
export async function getServiceDetails(serviceName: string): Promise<ServiceDetails | AmbiguousServiceDetails | null> {
    const session = getMemgraphSession();
    try {
        const lookupField = serviceName.startsWith('cr:') ? 'id' : 'name';
        const result = await session.run(
            `MATCH (s:Service {${lookupField}: $serviceName}) WHERE s.valid_to_commit IS NULL
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             OPTIONAL MATCH (s)-[rel:STORED_IN]->(r:Repository) WHERE rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
             OPTIONAL MATCH (s)-[r_contains:CONTAINS]->(f:Function) WHERE r_contains.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
             OPTIONAL MATCH (f)-[:WRITTEN_IN]->(flang:Technology)
             OPTIONAL MATCH (s)-[r_du:DEPLOYED_AS]->(du:DeploymentUnit) WHERE r_du.valid_to_commit IS NULL AND du.valid_to_commit IS NULL
             WITH s, t, r,
                  count(DISTINCT f) AS fnCount,
                  collect(DISTINCT flang.slug) AS fnLanguages,
                  collect(rel.path) AS paths,
                  collect(DISTINCT du.name) AS deploymentUnitNames
             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
             RETURN s.id AS id, s.name AS name, slang.slug AS language,
                    s.description AS description,
                    ${teamFallbackExpr('t', 'r')} AS team,
                    r.name AS repoName, r.url AS repoUrl,
                    coalesce(head([p IN paths WHERE p IS NOT NULL AND p <> '']), head(paths), null) AS pathInRepo,
                    fnCount, fnLanguages, deploymentUnitNames`,
            { serviceName }
        );

        if (result.records.length === 0) return null;
        if (!serviceName.startsWith('cr:') && result.records.length > 1) {
            return {
                warning: 'Ambiguous service name. Multiple matches found.',
                availableTargets: result.records.map((record: any) => {
                    const id = record.get('id') as string;
                    const repoName = record.get('repoName') as string | null;
                    const pathInRepo = record.get('pathInRepo') as string | null;
                    const suffix = repoName
                        ? ` (in ${repoName}${pathInRepo ? `:${pathInRepo}` : ''})`
                        : '';
                    return `${id}${suffix}`;
                }),
            };
        }

        const r = result.records[0] as any;
        const serviceId = r.get('id') as string;

        const apiResult = await session.run(
            `MATCH (s:Service {id: $serviceId}) WHERE s.valid_to_commit IS NULL
             OPTIONAL MATCH (s)-[r_exp:EXPOSES_API]->(api:APIInterface) WHERE r_exp.valid_to_commit IS NULL AND api.valid_to_commit IS NULL
             OPTIONAL MATCH (api)-[r_has:HAS_ENDPOINT]->(ep:APIEndpoint) WHERE r_has.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
             WITH api, count(DISTINCT ep) AS endpointCount
             WHERE api IS NOT NULL
             RETURN api.title AS title, api.version AS version, endpointCount
             ORDER BY title`,
            { serviceId }
        );

        const exposedApis: ExposedApi[] = apiResult.records.map((ar: any) => ({
            title: ar.get('title'),
            version: ar.get('version'),
            endpointCount: typeof ar.get('endpointCount')?.toNumber === 'function'
                ? ar.get('endpointCount').toNumber()
                : ar.get('endpointCount'),
            hint: `Use get_data_contract("${ar.get('title')}") to explore endpoints and schemas`,
        }));

        const fnLanguages: string[] = (r.get('fnLanguages') || []).filter(Boolean);
        const svcLanguage: string | null = r.get('language');
        const languages = [...new Set([
            ...(svcLanguage ? [svcLanguage] : []),
            ...fnLanguages,
        ])];

        const fnCount = typeof r.get('fnCount')?.toNumber === 'function'
            ? r.get('fnCount').toNumber()
            : r.get('fnCount');

        // ── Structural infrastructure (flat query — no cartesian products) ──
        const structResult = await session.run(
            `MATCH (s:Service {id: $serviceId})-[rel]->(entity)
             WHERE type(rel) IN ['HAS_CI_PIPELINE', 'HAS_DOCKER_IMAGE', 'HAS_TOOL_CONFIG', 'HAS_TASK']
             RETURN type(rel) AS relType, entity.tool AS tool, entity.filePath AS filePath,
                    entity.hasTestStage AS hasTestStage, entity.hasDeployStage AS hasDeployStage,
                    entity.jobCount AS jobCount, entity.stages AS stages, entity.triggers AS triggers,
                    entity.name AS entityName,
                    entity.tag AS tag, entity._sourcePath AS sourcePath, entity.source AS source`,
            { serviceId }
        );

        const infrastructure = parseStructuralRecords(structResult.records);

        const deploymentUnits: string[] = (r.get('deploymentUnitNames') || []).filter(Boolean);

        return {
            id: r.get('id'),
            name: r.get('name'),
            description: r.get('description'),
            team: r.get('team'),
            languages,
            repository: {
                name: r.get('repoName') || null,
                url: r.get('repoUrl') || null,
                pathInRepo: r.get('pathInRepo') || null,
            },
            exposedApis,
            indexedFunctionCount: fnCount,
            deploymentUnits,
            infrastructure,
        };
    } finally {
        await session.close();
    }
}

// ─── Repository Details ──────────────────────────────────────────────────────

/**
 * Get detailed information about a repository including services, structural
 * governance data (CI/CD, Docker, tool configs, tasks), and liveness metrics.
 */
export async function getRepositoryDetails(repositoryName: string): Promise<RepositoryDetails | null> {
    const session = getMemgraphSession();
    try {
        const result = await session.run(
            `MATCH (r:Repository {name: $repositoryName}) WHERE r.valid_to_commit IS NULL
             OPTIONAL MATCH (r)-[:CONTAINS]->(sf:SourceFile) WHERE sf.valid_to_commit IS NULL
             WITH r, count(DISTINCT sf) AS fileCount
             RETURN r.name AS name, r.url AS url, r.branch AS branch,
                    r.defaultBranch AS defaultBranch,
                    r.coreBranches AS coreBranches,
                    coalesce(r.hostingPlatform, 'unknown') AS hostingPlatform,
                    r.scanMode AS scanMode,
                    r.livenessCommits AS livenessCommits,
                    fileCount`,
            { repositoryName }
        );

        if (result.records.length === 0) return null;
        const rec = result.records[0] as any;

        // Services in this repo
        const svcResult = await session.run(
            `MATCH (s:Service)-[rel:STORED_IN]->(r:Repository {name: $repositoryName})
             WHERE s.valid_to_commit IS NULL AND rel.valid_to_commit IS NULL AND r.valid_to_commit IS NULL
             OPTIONAL MATCH (t:Team)-[r_owns:OWNS]->(s) WHERE r_owns.valid_to_commit IS NULL AND t.valid_to_commit IS NULL
             WITH DISTINCT s, r, collect(DISTINCT t.name) AS teamNames
             OPTIONAL MATCH (s)-[:WRITTEN_IN]->(slang:Technology)
             RETURN s.name AS name, slang.slug AS language,
                    ${teamListFallbackExpr('teamNames', 'r')} AS team
             ORDER BY s.name`,
            { repositoryName }
        );

        const services = svcResult.records.map((sr: any) => ({
            name: sr.get('name') as string,
            language: sr.get('language') as string | null,
            team: sr.get('team') as string | null,
        }));

        // Structural infrastructure — covers both direct (Repo→entity) and via Service
        const structResult = await session.run(
            `MATCH (r:Repository {name: $repositoryName}) WHERE r.valid_to_commit IS NULL
             OPTIONAL MATCH (r)-[rel1]->(e1)
               WHERE type(rel1) IN ['HAS_CI_PIPELINE', 'HAS_DOCKER_IMAGE', 'HAS_TOOL_CONFIG', 'HAS_TASK']
             WITH r, collect({relType: type(rel1), entity: e1}) AS direct
             OPTIONAL MATCH (r)<-[:STORED_IN]-(:Service)-[rel2]->(e2)
               WHERE type(rel2) IN ['HAS_CI_PIPELINE', 'HAS_DOCKER_IMAGE', 'HAS_TOOL_CONFIG', 'HAS_TASK']
             WITH direct + collect({relType: type(rel2), entity: e2}) AS all
             UNWIND all AS row
             WITH row WHERE row.entity IS NOT NULL
             WITH DISTINCT row.relType AS relType, row.entity AS entity
             RETURN relType, entity.tool AS tool, entity.filePath AS filePath,
                    entity.hasTestStage AS hasTestStage, entity.hasDeployStage AS hasDeployStage,
                    entity.jobCount AS jobCount, entity.stages AS stages, entity.triggers AS triggers,
                    entity.name AS entityName,
                    entity.tag AS tag, entity._sourcePath AS sourcePath, entity.source AS source`,
            { repositoryName }
        );

        const infrastructure = parseStructuralRecords(structResult.records);

        const toNum = (v: any) => typeof v?.toNumber === 'function' ? v.toNumber() : (v ?? 0);

        return {
            name: rec.get('name'),
            url: rec.get('url') || null,
            branch: rec.get('branch') || null,
            defaultBranch: rec.get('defaultBranch') || null,
            coreBranches: (rec.get('coreBranches') || []).filter(Boolean) as string[],
            hostingPlatform: rec.get('hostingPlatform') || null,
            scanMode: rec.get('scanMode') || null,
            livenessCommits: rec.get('livenessCommits') != null ? toNum(rec.get('livenessCommits')) : null,
            fileCount: toNum(rec.get('fileCount')),
            services,
            infrastructure,
        };
    } finally {
        await session.close();
    }
}

// ─── Shared structural parser ────────────────────────────────────────────────

/**
 * Parses flat structural entity records into a categorised InfrastructureBlock.
 * Deduplication is done by filePath to avoid duplicates from dual-attached edges.
 */
function parseStructuralRecords(records: any[]): InfrastructureBlock {
    const infra: InfrastructureBlock = { ciPipelines: [], dockerImages: [], toolConfigs: [], tasks: [] };
    const seen = new Set<string>();

    for (const rec of records) {
        const relType = rec.get('relType') as string;
        const fp = (rec.get('filePath') || rec.get('sourcePath') || '') as string;
        const entityName = (rec.get('entityName') as string) || '';
        // Tasks share filePath (e.g. all from Makefile), so include name in dedup key
        const dedupeKey = relType === 'HAS_TASK' ? `${relType}:${entityName}` : `${relType}:${fp}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const toNum = (v: any) => typeof v?.toNumber === 'function' ? v.toNumber() : (v ?? 0);

        switch (relType) {
            case 'HAS_CI_PIPELINE': {
                const tool = rec.get('tool') as string;
                if (tool) {
                    infra.ciPipelines.push({
                        tool,
                        filePath: fp,
                        hasTestStage: rec.get('hasTestStage') === true,
                        hasDeployStage: rec.get('hasDeployStage') === true,
                        jobCount: toNum(rec.get('jobCount')),
                        stages: (rec.get('stages') as string | undefined) || undefined,
                        triggers: (rec.get('triggers') as string | undefined) || undefined,
                    });
                }
                break;
            }
            case 'HAS_DOCKER_IMAGE':
                infra.dockerImages.push({
                    name: (rec.get('entityName') as string) || null,
                    tag: (rec.get('tag') as string) || null,
                    filePath: fp,
                });
                break;
            case 'HAS_TOOL_CONFIG': {
                const tool = (rec.get('tool') as string) || null;
                if (tool) infra.toolConfigs.push({ tool, filePath: fp });
                break;
            }
            case 'HAS_TASK': {
                const name = rec.get('entityName') as string;
                if (name) infra.tasks.push({ name, runner: (rec.get('source') as string) || null });
                break;
            }
        }
    }

    return infra;
}
