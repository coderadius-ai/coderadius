import path from 'node:path';
import fs from 'node:fs';
import { discoverSpecFiles } from '../core/source-resolver.js';
import { parseOpenAPISpec } from '../core/openapi.js';
import { deleteStaleAPINodes, getExistingEndpointIds, linkServiceExposesAPI, mergeAPIEndpoint, mergeAPIInterface } from '../../graph/mutations/api-contracts.js';
import { getExistingAPIDeploymentIds, mergeAPIDeployment } from '../../graph/mutations/api-deployment.js';
import { linkApiEndpointHasRequestSchema, linkApiEndpointHasResponseSchema, mergeEmergentSchema } from '../../graph/mutations/data-contracts.js';
import { linkServiceOwnsSourceFile, linkSourceFileDefinesAPI } from '../../graph/mutations/merkle.js';
import { astGrounding } from '../../graph/grounding.js';
import { logger } from '../../utils/logger.js';
import { traceCollector } from '../../telemetry/index.js';
import { generateEmbeddingsBatch, flushEmbeddingCache } from '../../ai/embeddings.js';
import type { ResolvedRepo } from '../../graph/types.js';
import { buildUrn, getQualifiedRepoName } from '../../graph/urn.js';
import { normalizeApiPathLossless, normalizePathParams } from '../processors/api-path-utils.js';

const commitHash = "SYSTEM";

/**
 * Determine the owning service for a spec file based on its relative path.
 * Uses the same apps/* / packages/* convention as getMonorepoRouting in ingest-code.ts.
 */
function resolveServiceForFile(
    absolutePath: string,
    repoPath: string,
    serviceRoots: any[],
): string | undefined {
    let best: string | undefined;
    let bestLen = 0;

    for (const svc of serviceRoots) {
        // svc.path is absolute
        const prefix = svc.path.endsWith(path.sep) ? svc.path : svc.path + path.sep;
        if (absolutePath.startsWith(prefix) && prefix.length > bestLen) {
            best = svc.name;
            bestLen = prefix.length;
        }
    }

    return best;
}

/**
 * Determine the owning service for a spec file based on its absolute path and service roots.
 */
function getSpecOwner(
    absolutePath: string,
    relPath: string,
    repoName: string,
    serviceRoots: any[],
): { type: 'service' | 'library' | 'repository'; name: string } {
    const matchedSvc = resolveServiceForFile(absolutePath, '', serviceRoots);
    if (matchedSvc) {
        return { type: 'service', name: matchedSvc };
    }

    if (relPath.startsWith('apps/')) {
        const parts = relPath.split('/');
        if (parts.length >= 2) {
            return { type: 'service', name: parts[1] };
        }
    } else if (relPath.startsWith('packages/')) {
        const parts = relPath.split('/');
        if (parts.length >= 2) {
            return { type: 'library', name: parts[1] };
        }
    }
    // Polyrepo / root — treat as repo-level service
    return { type: 'service', name: repoName };
}

/**
 * API Contract Ingestion — deterministic OpenAPI/Swagger spec parsing.
 * Creates APIInterface + APIEndpoint nodes and links them to services.
 * Generates vector embeddings for endpoints to enable targeted matchmaking.
 */
export async function ingestOpenAPI(repos: ResolvedRepo[], serviceRoots: any[] = [], task?: any): Promise<{
    specsProcessed: number;
    endpointsCreated: number;
    errors: string[];
}> {
    let specsProcessed = 0;
    let endpointsCreated = 0;
    const errors: string[] = [];

    for (const repo of repos) {
        const specFiles = await discoverSpecFiles(repo.path);
        logger.debug(`[OpenAPI] Discovered ${specFiles.length} spec candidate(s) in ${repo.name}: ${specFiles.map(f => path.relative(repo.path, f)).join(', ') || '(none)'}`);
        if (task && specFiles.length > 0) task.report(`Found ${specFiles.length} spec file(s) in ${repo.name}`);

        const openApiCandidates = specFiles.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ext !== '.avsc' && ext !== '.proto';
        });

        for (const specFile of openApiCandidates) {
            try {
                const relPath = path.relative(repo.path, specFile);
                if (task) task.report(`Parsing spec: ${relPath}`);

                const content = fs.readFileSync(specFile, 'utf-8');
                const parsed = parseOpenAPISpec(content, relPath);

                if (!parsed) {
                    // Not parseable as OpenAPI/Swagger — log and skip
                    logger.debug(`[OpenAPI] Skipped ${relPath}: not a valid OpenAPI/Swagger document (missing openapi/swagger root key)`);
                    if (task) task.report(`  ↳ Skipped ${relPath}: not a valid OpenAPI spec`);
                    continue;
                }

                const owner = getSpecOwner(specFile, relPath, repo.name, serviceRoots);
                const apiUrn = buildUrn('api', getQualifiedRepoName(repo), owner.name, relPath);

                // Create APIInterface node. Grounding: ast/exact — OpenAPI spec is deterministic.
                const apiProv = astGrounding('openapi-extractor@v1');
                await mergeAPIInterface(apiUrn, parsed.title, parsed.version, commitHash, 'openapi', 'INBOUND', apiProv);

                // Link to owning service (only for services)
                if (owner.type === 'service') {
                    await linkServiceExposesAPI(getQualifiedRepoName(repo), owner.name, apiUrn, commitHash);
                }

                // ── Mark phase: collect fresh IDs ────────────────────────────
                const freshEndpointIds = new Set<string>();
                const freshServerUrlIds = new Set<string>();

                // ── Generate embeddings for all endpoints in a single batch ──
                const embeddingTexts = parsed.endpoints.map(ep =>
                    `[${ep.method.toUpperCase()}] ${ep.path} — ${ep.summary || 'No description'}`
                );
                const embeddings = await generateEmbeddingsBatch(embeddingTexts);

                // Create APIEndpoint nodes (with embeddings)
                // Path params are normalized to {param} (e.g. {id}, {userId} → {param})
                // so the URN key is consistent with code-inferred endpoints extracted by
                // the static route extractors. Embeddings are generated on the ORIGINAL
                // path to preserve semantic richness for vector similarity matching.
                for (let i = 0; i < parsed.endpoints.length; i++) {
                    const ep = parsed.endpoints[i];
                    // Use the same lossless normalization that graph-writer.ts applies
                    // to code-inferred and emergent endpoints. This guarantees that the
                    // raw path comparison in rewireImplementsEdgesToOpenApi can match
                    // OpenAPI ↔ code-inferred endpoints byte-for-byte. Fallback on
                    // normalizePathParams for the rare paths where lossless returns null
                    // (e.g. dynamic placeholders like {baseUrl}/foo).
                    const normalizedPath = normalizeApiPathLossless(ep.path) ?? normalizePathParams(ep.path);
                    const endpointUrn = buildUrn('endpoint', getQualifiedRepoName(repo), relPath, ep.method.toUpperCase(), normalizedPath);
                    await mergeAPIEndpoint(apiUrn, endpointUrn, normalizedPath, ep.method.toUpperCase() as import('@coderadius/shared-types').HttpMethod, ep.operationId, ep.summary, embeddings[i], commitHash, 'openapi', apiProv);
                    freshEndpointIds.add(endpointUrn);
                    endpointsCreated++;

                    // Persist request/response body schemas as DataStructure nodes
                    // and link directly via HAS_REQUEST_SCHEMA / HAS_RESPONSE_SCHEMA.
                    // Deterministic (no LLM): the OpenAPI spec is the ground truth.
                    if (ep.requestSchema) {
                        const name = ep.requestSchema.name
                            ?? `${ep.method.toUpperCase()}_${normalizedPath.replace(/[/{}]/g, '_')}_RequestBody`;
                        const merged = await mergeEmergentSchema({
                            qualifiedRepoName: getQualifiedRepoName(repo),
                            filepath: relPath,
                            schemaName: name,
                            schemaType: 'message_payload',
                            fields: ep.requestSchema.fields.map(f => ({ name: f.name, type: f.type, required: f.required })),
                            commitHash,
                            schemaFormat: 'json-schema',
                            grounding: astGrounding('openapi-extractor@v1'),
                        });
                        await linkApiEndpointHasRequestSchema(endpointUrn, merged.schemaUrn, commitHash);
                    }
                    if (ep.responseSchema) {
                        const name = ep.responseSchema.name
                            ?? `${ep.method.toUpperCase()}_${normalizedPath.replace(/[/{}]/g, '_')}_ResponseBody`;
                        const merged = await mergeEmergentSchema({
                            qualifiedRepoName: getQualifiedRepoName(repo),
                            filepath: relPath,
                            schemaName: name,
                            schemaType: 'message_payload',
                            fields: ep.responseSchema.fields.map(f => ({ name: f.name, type: f.type, required: f.required })),
                            commitHash,
                            schemaFormat: 'json-schema',
                            grounding: astGrounding('openapi-extractor@v1'),
                        });
                        await linkApiEndpointHasResponseSchema(endpointUrn, merged.schemaUrn, commitHash);
                    }
                }

                // Link SourceFile → APIInterface.
                // NOTE: We intentionally do NOT call mergeSourceFile() + linkRepositoryContainsSourceFile()
                // here. Those calls would register openapi.yml in the code pipeline Merkle index
                // (via Repository -[:CONTAINS]-> SourceFile). The code pipeline's discoverFiles()
                // does not enumerate YAML files, so every Merkle diff would emit openapi.yml as
                // "deleted", tombstoning the spec file and cascading to the APIEndpoint nodes.
                // Using only linkSourceFileDefinesAPI() gives us the SourceFile → APIInterface
                // traceability without polluting the Merkle tracking.
                await linkSourceFileDefinesAPI(relPath, getQualifiedRepoName(repo), apiUrn, commitHash);

                if (owner.type === 'service') {
                    await linkServiceOwnsSourceFile(getQualifiedRepoName(repo), owner.name, relPath, commitHash);
                } else if (owner.type === 'library') {
                    // libraries don't have OWNS yet in merkle logic, but we can safely add it or 
                    // just wait if we need it. For now, try adding it if there is a query, or skip.
                    // Wait, do we have linkLibraryOwnsSourceFile? No. 
                }

                // Create :APIDeployment nodes for server base URLs (renamed from :PhysicalResource).
                for (const serverUrl of parsed.serverUrls) {
                    const deploymentUrn = await mergeAPIDeployment({
                        apiUrn,
                        baseUrl: serverUrl,
                        declaredBy: 'oas-servers',
                        confidence: 'exact',
                    }, commitHash);
                    freshServerUrlIds.add(deploymentUrn);
                }

                // ── Sweep phase: delete stale nodes scoped to this APIInterface ──
                const existingEndpointIds = await getExistingEndpointIds(apiUrn);
                const staleEndpoints = existingEndpointIds.filter(id => !freshEndpointIds.has(id));
                if (staleEndpoints.length > 0) {
                    await deleteStaleAPINodes(staleEndpoints);
                    logger.debug(`[OpenAPI] Reconciled ${relPath}: removed ${staleEndpoints.length} stale endpoint(s)`);
                }

                const existingDeploymentIds = await getExistingAPIDeploymentIds(apiUrn);
                const staleDeployments = existingDeploymentIds.filter(id => !freshServerUrlIds.has(id));
                if (staleDeployments.length > 0) {
                    await deleteStaleAPINodes(staleDeployments);
                    logger.debug(`[OpenAPI] Reconciled ${relPath}: removed ${staleDeployments.length} stale deployment(s)`);
                }

                specsProcessed++;
                traceCollector.traceContract('INCLUDE', relPath, `parsed ${parsed.endpoints.length} endpoint(s)`, { title: parsed.title, version: parsed.version, endpointCount: parsed.endpoints.length, owner: owner.name });
                if (task) task.report(`${relPath}: ${parsed.endpoints.length} endpoints, ${parsed.serverUrls.length} servers (${parsed.title} v${parsed.version})`);
            } catch (err) {
                const msg = `[OpenAPI] Error processing ${specFile}: ${(err as Error).message}`;
                logger.error(msg);
                errors.push(msg);
            }
        }
    }

    return { specsProcessed, endpointsCreated, errors };
}
