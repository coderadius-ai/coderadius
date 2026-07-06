import crypto from 'node:crypto';
import { initSchema } from '../../graph/neo4j.js';
import { resolveAllSources, detectGitSubmoduleProvenance, type SourceStrategy } from '../core/source-resolver.js';
import { mergeRepositoriesBatch } from '../../graph/mutations/code-graph.js';
import { discoverBackstageComponents } from '../extractors/backstage-extractor.js';
import { discoverCortexComponents } from '../extractors/cortex-extractor.js';
import { discoverAutoComponents, classifyFrameworkRoles, inferLanguageFromDir, type DiscoveredService } from '../extractors/autodiscovery.js';
import { getLanguagePlugin } from '../core/languages/registry.js';
import { collapseToTopology, resolveCatalogPriority, writeTopologyToGraph, weldIdentities, getServiceRootDir } from '../topology-resolver.js';
import { loadRepoHints, getTopology, getNameOverrides } from '../../config/repo-hints.js';
import { ingestCodeowners } from '../extractors/codeowners-extractor.js';
import { reconcileOwnership } from '../extractors/ownership-reconciler.js';
import { resolveTeamAliases } from '../extractors/team-alias-resolver.js';
import { ingestStructural, type IngestStructuralOptions } from '../structural/plugin-manager.js';
import { ingestLockfileDependencies } from '../extractors/lockfile-extractor.js';
import { mergeContextProvenanceEdges } from '../../graph/mutations/context-provenance.js';
import { ingestOpenAPI } from '../extractors/openapi-extractor.js';
import { ingestAPIDeploymentHints } from '../processors/api-deployment-resolver.js';
import { ingestSchemaFiles } from '../extractors/schema-extractor.js';
import { ingestGraphQLSchemas } from '../extractors/graphql-schema-extractor.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import type { ProgressReporter, IngestionContext, IngestionStep } from '../core/progress.js';
import type { ResolvedRepo } from '../../graph/types.js';


/**
 * Shared context for the governance scan workflow.
 */
export interface GovernanceScanContext extends IngestionContext {
    sourcePaths: string[];
    repos: ResolvedRepo[];
    discoveredServiceRoots: DiscoveredService[];
}

/**
 * Options for configuring the governance scan run.
 */
export interface GovernanceScanCommandOptions {
    sourcePaths: string[];
    debug?: boolean;
    fresh?: boolean;
    sourceStrategy?: SourceStrategy;
}

/**
 * Returns the discrete steps of the Agentic Context Ingestion workflow.
 * Fast path (~1-2s per repo) extracting capabilities, skills, rules, and dependency graphs.
 */
export function getGovernanceScanSteps(opts: GovernanceScanCommandOptions): IngestionStep<GovernanceScanContext>[] {
    return [
        {
            title: 'Bootstrapping Graph Engine',
            run: async (ctx, r) => {
                await initSchema();
            }
        },
        {
            title: 'Resolving Source Repositories',
            run: async (ctx, r) => {
                ctx.repos = await resolveAllSources(ctx.sourcePaths, ctx.sessionId, opts.sourceStrategy, r);

                // Batch-persist all Repository nodes in a single UNWIND transaction
                // instead of 300+ sequential MERGEs (10x faster for large scans).
                const now = new Date().toISOString();
                await mergeRepositoriesBatch(
                    ctx.repos.map(repo => ({
                        name: repo.name,
                        url: repo.remoteUrl,
                        commitHash: repo.commit || 'unknown',
                        org: repo.org,
                        branch: repo.branch,
                        defaultBranch: repo.defaultBranch,
                        coreBranches: repo.coreBranches,
                        hostingPlatform: repo.hostingPlatform,
                        lastAnalyzedAt: now,
                        liveness: repo.livenessCommits != null ? {
                            commits:     repo.livenessCommits,
                            computedAt:  now,
                        } : undefined,
                        gitConventions: repo.gitConventions,
                    })),
                );
                r.report(`Persisted ${ctx.repos.length} repository nodes`);


            }
        },
        {
            title: 'Mapping Context Provenance',
            run: async (ctx, r) => {
                // Detect cross-repo context imports for all resolved repos.
                // Today: git submodules only.
                // To add a future mechanism (npm, symlinks), call its detect function here
                // and spread results into the provenance array — no other changes needed.
                let totalEdges = 0;
                for (const repo of ctx.repos) {
                    // Today: git submodules only
                    const provenance = detectGitSubmoduleProvenance(repo.path, repo.remoteUrl);

                    if (provenance.length > 0) {
                        const count = await mergeContextProvenanceEdges(getQualifiedRepoName(repo), provenance);
                        totalEdges += count;
                        r.report(
                            `[Provenance] ${repo.name}: ${provenance.length} import(s) via ${[...new Set(provenance.map(p => p.mechanism))].join(', ')}`,
                        );
                    }
                }
                if (totalEdges > 0) {
                    r.report(`Mapped ${totalEdges} context provenance edge(s)`);
                }
            },
        },
        {
            title: 'Mapping Service Topology',
            run: async (ctx, r) => {
                // ── Step 1: Discover components from ALL catalog sources ─────
                const backstage = await discoverBackstageComponents(ctx.repos, r);
                const cortex = await discoverCortexComponents(ctx.repos, r);

                ctx.discoveredServiceRoots = [];

                // ── Step 2: Per-repo catalog resolution + topology application ─
                for (const repo of ctx.repos) {
                    const catalogPriority = resolveCatalogPriority(
                        backstage.components.some(c => c.catalogFile.startsWith(repo.path)),
                        cortex.components.some(c => c.catalogFile.startsWith(repo.path)),
                    );

                    // Filter components for this repo
                    let repoComponents = catalogPriority === 'cortex'
                        ? cortex.components.filter(c => c.catalogFile.startsWith(repo.path))
                        : catalogPriority === 'backstage'
                            ? backstage.components.filter(c => c.catalogFile.startsWith(repo.path))
                            : [];

                    const repoAux = catalogPriority === 'cortex'
                        ? cortex.auxiliaryEntities
                        : catalogPriority === 'backstage'
                            ? backstage.auxiliaryEntities
                            : [];

                    if (catalogPriority !== 'autodiscovery' && repoComponents.length > 0) {
                        r.report(`${repo.name}: using ${catalogPriority} catalog (${repoComponents.length} components)`);
                    }

                    // ── Step 2b: Autodiscovery (runs for ALL paths, not just unclaimed) ──
                    const auto = await discoverAutoComponents([repo], [], r);
                    ctx.discoveredServiceRoots.push(...auto.serviceRoots);

                    // ── Step 2c: Identity Welding ────────────────────────────
                    // Merge catalog metadata with autodiscovery identity by path.
                    // Catalog provides: owner, system, deps.
                    // Autodiscovery provides: useful name, language.
                    const hints = loadRepoHints(repo.path);
                    const nameOverrides = getNameOverrides(hints);
                    const weldResult = weldIdentities(
                        repoComponents, auto.components,
                        repo.path, repo.name, nameOverrides,
                    );

                    // Log catalog-only components for observability
                    for (const unmatched of weldResult.unmatchedCatalogComponents) {
                        r.report(`  ⚠ ${repo.name}: catalog-only "${unmatched.name}" — no code detected, skipping Service node`);
                    }

                    const weldedComponents = weldResult.components;

                    if (weldedComponents.length === 0) continue;

                    // ── Step 3: Apply topology ─────────────────────────────────
                    const topology = getTopology(hints);
                    const result = collapseToTopology(weldedComponents, repoAux, topology, repo.name, repo.path, hints, weldResult.allCatalogComponents);

                    // ── Step 4: Write to graph ─────────────────────────────────
                    const written = await writeTopologyToGraph(result, repo);

                    // Track catalog-claimed roots for downstream consumers.
                    // `catalogFile` is a YAML manifest path for backstage/cortex
                    // and a directory for autodiscovery — normalise to the dir.
                    for (const entry of result.services) {
                        const svcDir = getServiceRootDir(entry.component.catalogFile);
                        let language = entry.component.language ?? 'unknown';
                        if (language === 'unknown') language = inferLanguageFromDir(svcDir, repo.path);
                        const plugin = getLanguagePlugin(language);
                        const frameworkRoles = classifyFrameworkRoles(svcDir, plugin);
                        ctx.discoveredServiceRoots.push({
                            name: entry.component.name,
                            path: svcDir,
                            language,
                            // Catalog-promoted entries (Backstage / Cortex /
                            // post-topology) are confirmed Services: the
                            // topology-resolver has already created the
                            // :Service node.
                            isRuntimeService: true,
                            frameworkRoles: frameworkRoles.size > 0 ? frameworkRoles : undefined,
                        });
                    }

                    if (written.servicesCreated.length > 0) {
                        const topoLabel = topology === 'auto'
                            ? `auto→${result.effectiveTopology}`
                            : topology;
                        r.report(`${repo.name}: ${written.servicesCreated.length} service(s) [topology: ${topoLabel}]`);
                    }
                }

                // CODEOWNERS — path-level team ownership
                const codeownersResult = await ingestCodeowners(ctx.repos, ctx.discoveredServiceRoots, r);
                if (codeownersResult.totalTeams > 0) {
                    r.report(`Mapped ${codeownersResult.totalTeams} team(s) from CODEOWNERS`);
                }
                
                const discrepancies = await reconcileOwnership();
                if (discrepancies.length > 0) {
                    r.report(`Found ${discrepancies.length} organizational ownership discrepancies (logged for governance alerts)`);
                }

                // Team alias resolution — AI-powered identity matching
                const aliasResult = await resolveTeamAliases(r);
                if (aliasResult.proposalsCreated > 0) {
                    r.report(`Proposed ${aliasResult.proposalsCreated} team alias(es) — review with 'cr team-alias list'`);
                }
            }
        },
        {
            title: 'Extracting Agentic Capabilities',
            run: async (ctx, r) => {
                const result = await ingestStructural(
                    ctx.repos,
                    ctx.discoveredServiceRoots,
                    r,
                    { force: opts.fresh },
                );
                
                const parts: string[] = [];
                if (result.entitiesPersisted > 0) parts.push(`${result.entitiesPersisted} entities`);
                if (result.ghostDirectoriesFound > 0) parts.push(`${result.ghostDirectoriesFound} ghost dirs`);
                if (result.entitiesRemoved > 0) parts.push(`${result.entitiesRemoved} stale removed`);
                
                if (parts.length > 0) {
                    r.report(`Structural extraction complete: ${parts.join(', ')}`);
                } else {
                    r.report('No structural artifacts found');
                }


            }
        },
        {
            title: 'Building Dependency Graph',
            run: async (ctx, r) => {
                await ingestLockfileDependencies(ctx.repos, r);
                r.report('Extracted exact dependencies from lockfiles');
            }
        },
        {
            title: 'Enriching Vulnerability Data',
            run: async (ctx: GovernanceScanContext, r: ProgressReporter) => {
                const { enrichVulnerabilities } = await import('../enrichment/index.js');
                const commitHash = ctx.repos[0]?.commit ?? 'SYSTEM';
                const result = await enrichVulnerabilities(commitHash, r);
                if (result.vulnsFound > 0) {
                    r.report(`Found ${result.vulnsFound} vulnerabilities across ${result.packagesScanned} packages (${result.cacheHits} cached)`);
                } else {
                    r.report('No known vulnerabilities found');
                }
            }
        },
        {
            title: 'Ingesting API Contracts',
            run: async (ctx, r) => {
                const result = await ingestOpenAPI(ctx.repos, ctx.discoveredServiceRoots, r);
                if (result.specsProcessed > 0) {
                    r.report(`Parsed ${result.specsProcessed} spec(s), ${result.endpointsCreated} endpoints`);
                } else {
                    r.report('No OpenAPI/Swagger specs found');
                }

                // Multi-source :APIDeployment hints (helm/k8s ingress) — augments
                // OAS `servers[]` so the URL-match welder (L0a / L0b) can resolve
                // emergent caller URLs against the customer's deployment topology.
                const deploymentResult = await ingestAPIDeploymentHints(
                    ctx.repos,
                    ctx.discoveredServiceRoots,
                    ctx.repos[0]?.commit ?? 'SYSTEM',
                    r,
                );
                if (deploymentResult.deploymentsCreated > 0) {
                    r.report(`Discovered ${deploymentResult.deploymentsCreated} :APIDeployment from helm/k8s ingress`);
                }

                // Schema contracts (Avro, Protobuf) — creates DataStructure nodes
                // that the code pipeline will link to MessageChannels via HAS_SCHEMA.
                const schemaResult = await ingestSchemaFiles(ctx.repos, ctx.discoveredServiceRoots, r);
                if (schemaResult.schemasProcessed > 0) {
                    r.report(`Parsed ${schemaResult.schemasProcessed} schema contract(s)`);
                }
            }
        },
        {
            title: 'Ingesting GraphQL Schemas',
            run: async (ctx, r) => {
                try {
                    const result = await ingestGraphQLSchemas(ctx.repos, ctx.discoveredServiceRoots, r);
                    if (result.specsProcessed > 0) {
                        r.report(`GraphQL SDL: ${result.specsProcessed} file(s), ${result.endpointsCreated} endpoint(s) merged` +
                            (result.endpointsStaled > 0 ? `, ${result.endpointsStaled} staled` : ''));
                    } else {
                        r.report('No GraphQL SDL files found');
                    }
                    if (result.errors.length > 0) {
                        r.warn(`GraphQL SDL: ${result.errors.length} non-fatal error(s) — check debug log`);
                    }
                } catch (err) {
                    // Fail-safe: SDL extraction is best-effort; never abort the governance scan
                    r.warn(`GraphQL SDL extraction failed: ${(err as Error).message}`);
                }
            }
        },
    ];
}

/**
 * Executes the entire end-to-end Agentic Context Ingestion workflow (Headless mode).
 */
export async function runGovernanceScan(
    opts: GovernanceScanCommandOptions,
    reporter?: ProgressReporter
): Promise<void> {
    const sessionId = crypto.randomUUID();
    const r = reporter ?? { report: () => { }, warn: () => { }, error: () => { } };

    const ctx: GovernanceScanContext = {
        sessionId,
        sourcePaths: opts.sourcePaths,
        repos: [],
        discoveredServiceRoots: []
    };

    const steps = getGovernanceScanSteps(opts);
    for (const step of steps) {
        r.report(`[Step] ${step.title}`);
        await step.run(ctx, r);
    }
}
