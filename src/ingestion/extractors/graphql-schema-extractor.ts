// ═══════════════════════════════════════════════════════════════════════════════
// GraphQL SDL Schema Extractor
//
// Walks all repositories for .graphql / .gql files, parses them with
// graphql-js (the official GraphQL Foundation reference parser), extracts
// root field definitions from Query / Mutation / Subscription types, and
// persists them as first-class SDL APIEndpoint nodes using the graphql: URN
// taxonomy (Model B).
//
// Architecture:
//   • Per-service lifecycle — SDL nodes are reconciled against the current
//     commit hash. Stale nodes (removed fields) are soft-deleted via
//     markGraphQLEndpointsStale.
//   • Extend-safe — `extend type Query { ... }` adds fields to the root set
//     without overwriting existing nodes.
//   • Code-inferred bridging — after populating SDL nodes, the caller (Phase 8)
//     triggers rewireGraphQLCodeToSDL per-service to link existing
//     graphql-code: nodes to their SDL twin.
//   • Fail-safe — a malformed SDL file is logged and skipped; it does not
//     abort the workflow.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { getExistingSDLGraphQLEndpointIds, linkServiceExposesAPI, markGraphQLEndpointsStale, mergeAPIInterface, mergeSDLGraphQLEndpoint } from '../../graph/mutations/api-contracts.js';
import { buildUrn, getQualifiedRepoName } from '../../graph/urn.js';
import { astGrounding } from '../../graph/grounding.js';
import { logger } from '../../utils/logger.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { DiscoveredService } from './autodiscovery.js';
import type { ProgressReporter } from '../core/progress.js';
import { parse as parseGraphQL, Kind } from 'graphql';
import type { DocumentNode } from 'graphql';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SDLRootField {
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
    fieldName: string;
}

interface ServiceSDL {
    serviceUrn: string;
    serviceName: string | null;  // null = repo-level fallback (no discovered service)
    apiUrn: string;
    fields: SDLRootField[];
    commitHash: string;
    /**
     * Whether the owning workspace actually hosts a GraphQL server (per
     * `LanguagePlugin.frameworkRoleSignals['graphql-server']`). Drives the
     * EXPOSES_API gate — see Fix #2 in plan serene-sniffing-stonebraker.
     */
    hasGraphQLServerRole: boolean;
}

export interface GraphQLIngestionResult {
    specsProcessed: number;
    endpointsCreated: number;
    endpointsStaled: number;
    errors: string[];
}

// ─── Operation type map ──────────────────────────────────────────────────────

const ROOT_TYPE_MAP: Record<string, SDLRootField['operation']> = {
    Query: 'QUERY',
    Mutation: 'MUTATION',
    Subscription: 'SUBSCRIPTION',
};

// ─── SDL parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a GraphQL SDL string and extract all root fields defined under
 * Query, Mutation, and Subscription object type definitions.
 *
 * Uses the official graphql-js reference parser (pure JavaScript, zero native
 * dependencies). Handles both `type Query { ... }` and `extend type Query { ... }`.
 * Field arguments and directives are intentionally ignored — we only need
 * the root field name to build the URN.
 */
function extractRootFields(
    sdlContent: string,
    filePath: string,
): SDLRootField[] {
    let doc: DocumentNode;
    try {
        doc = parseGraphQL(sdlContent);
    } catch (err) {
        logger.debug(`[GraphQLExtractor] Parse error in ${filePath}: ${(err as Error).message}`);
        return [];
    }

    const fields: SDLRootField[] = [];

    for (const def of doc.definitions) {
        // ObjectTypeDefinition:  `type Query { ... }`
        // ObjectTypeExtension:   `extend type Query { ... }`
        const isTypeDef = def.kind === Kind.OBJECT_TYPE_DEFINITION;
        const isExtend  = def.kind === Kind.OBJECT_TYPE_EXTENSION;
        if (!isTypeDef && !isExtend) continue;

        const typeName = def.name.value;
        const operation = ROOT_TYPE_MAP[typeName];
        if (!operation) continue; // Not a root type (e.g. scalar, input, fragment)

        if (!def.fields || def.fields.length === 0) continue;

        for (const fieldDef of def.fields) {
            const fieldName = fieldDef.name.value;
            if (fieldName) {
                fields.push({ operation, fieldName });
            }
        }
    }

    return fields;
}

// ─── File discovery ──────────────────────────────────────────────────────────

function findSDLFiles(repoRoot: string): string[] {
    const results: string[] = [];
    const GQL_EXTS = new Set(['.graphql', '.gql']);

    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Skip hidden dirs, node_modules, vendor
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
                walk(fullPath);
            } else if (entry.isFile() && GQL_EXTS.has(path.extname(entry.name).toLowerCase())) {
                results.push(fullPath);
            }
        }
    }

    walk(repoRoot);
    return results;
}

// ─── Service rooting ─────────────────────────────────────────────────────────

/**
 * Resolve which DiscoveredService (if any) owns the given absolute file path.
 * Returns the first service whose root is an ancestor of the file path.
 */
function resolveOwnerService(
    filePath: string,
    serviceRoots: DiscoveredService[],
): DiscoveredService | null {
    for (const svc of serviceRoots) {
        if (filePath.startsWith(svc.path + path.sep) || filePath.startsWith(svc.path + '/')) {
            return svc;
        }
    }
    return null;
}

// ─── Main entrypoint ─────────────────────────────────────────────────────────

/**
 * Ingest all GraphQL SDL files across all resolved repositories.
 *
 * For each service with SDL files:
 *   1. Parse all SDL files → collect root fields
 *   2. Merge / upsert SDL APIEndpoint nodes (mergeSDLGraphQLEndpoint)
 *   3. Mark stale SDL endpoints from previous commits (markGraphQLEndpointsStale)
 */
export async function ingestGraphQLSchemas(
    repos: ResolvedRepo[],
    serviceRoots: DiscoveredService[],
    reporter?: ProgressReporter,
): Promise<GraphQLIngestionResult> {
    const result: GraphQLIngestionResult = {
        specsProcessed: 0,
        endpointsCreated: 0,
        endpointsStaled: 0,
        errors: [],
    };

    const r = reporter ?? { report: () => {}, warn: () => {}, error: () => {} };

    for (const repo of repos) {
        const qualifiedName = getQualifiedRepoName(repo);
        const commitHash = repo.commit ?? 'unknown';
        const sdlFiles = findSDLFiles(repo.path);

        if (sdlFiles.length === 0) continue;

        r.report(`[GraphQLSDL] ${qualifiedName}: found ${sdlFiles.length} SDL file(s)`);

        // Group fields by effective service URN
        // Key: apiUrn  Value: { serviceUrn, fields[] }
        const byService = new Map<string, ServiceSDL>();

        for (const filePath of sdlFiles) {
            result.specsProcessed++;
            let sdlContent: string;
            try {
                sdlContent = fs.readFileSync(filePath, 'utf-8');
            } catch (err) {
                const msg = `[GraphQLSDL] Cannot read ${filePath}: ${(err as Error).message}`;
                logger.warn(msg);
                result.errors.push(msg);
                continue;
            }

            const fields = extractRootFields(sdlContent, filePath);
            if (fields.length === 0) {
                logger.debug(`[GraphQLSDL] No root fields found in ${filePath}`);
                continue;
            }

            // Determine which service owns this SDL file
            const ownerSvc = resolveOwnerService(filePath, serviceRoots);
            let serviceUrn: string;
            let apiUrn: string;

            if (ownerSvc) {
                serviceUrn = buildUrn('service', qualifiedName, ownerSvc.name);
                // SDL APIInterface URN — canonical per service
                apiUrn = buildUrn('api', qualifiedName, ownerSvc.name, 'graphql-sdl');
            } else {
                // Repo-level fallback: no discovered service
                serviceUrn = buildUrn('repository', qualifiedName);
                apiUrn = buildUrn('api', qualifiedName, 'graphql-sdl');
            }

            const existing = byService.get(apiUrn);
            if (existing) {
                existing.fields.push(...fields);
            } else {
                byService.set(apiUrn, {
                    serviceUrn,
                    serviceName: ownerSvc?.name ?? null,
                    apiUrn,
                    fields,
                    commitHash,
                    hasGraphQLServerRole: ownerSvc?.frameworkRoles?.has('graphql-server') ?? false,
                });
            }
        }

        // Merge SDL nodes per service
        for (const [apiUrn, sdl] of byService) {
            // Deduplicate fields across multiple SDL files for the same service
            const seen = new Set<string>();
            const uniqueFields = sdl.fields.filter(f => {
                const key = `${f.operation}:${f.fieldName}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            // Fetch existing SDL endpoint IDs for stale detection
            const existingIds = await getExistingSDLGraphQLEndpointIds(apiUrn);
            const freshIds = new Set<string>();

            // 1A-fix: create the APIInterface node BEFORE merging endpoints.
            // mergeSDLGraphQLEndpoint does MATCH (api:APIInterface {id: $apiUrn}) — if the
            // node doesn't exist, the HAS_ENDPOINT edge is silently skipped.
            // We also link Service→APIInterface so the SDL graph has a clear architectural owner.
            const serviceName = sdl.serviceName ?? qualifiedName;
            // Pass 'sdl' as the source (5th arg). The 3rd `version` arg historically
            // received 'sdl' too — that was a bug: it stamped the version field with
            // the source taxonomy. Real version not exposed by .graphql files; '1.0.0'
            // is the conventional placeholder used elsewhere for SDL specs.
            await mergeAPIInterface(apiUrn, `${serviceName} GraphQL SDL`, '1.0.0', sdl.commitHash, 'sdl', 'INBOUND', astGrounding('graphql-sdl-extractor@v1'));
            // EXPOSES_API gate (Fix #2): the SDL extractor binds operations to a
            // workspace based on file ownership, but a workspace that owns a
            // schema.gql is NOT necessarily a GraphQL server (CLI tools and
            // workers can ship their own .gql for typings without hosting a
            // resolver runtime). Only emit EXPOSES_API when the workspace
            // actually declares a graphql-server role.
            if (sdl.serviceName && sdl.hasGraphQLServerRole) {
                await linkServiceExposesAPI(qualifiedName, sdl.serviceName, apiUrn, sdl.commitHash);
            } else if (sdl.serviceName) {
                logger.debug(
                    `[GraphQLSDL] Skipping EXPOSES_API on ${sdl.serviceName} — no graphql-server role detected. ` +
                    `SDL nodes are still merged for catalog completeness; the service-level edge is suppressed.`,
                );
            }

            for (const field of uniqueFields) {
                try {
                    const epUrn = await mergeSDLGraphQLEndpoint(
                        apiUrn,
                        field.operation,
                        field.fieldName,
                        sdl.commitHash,
                    );
                    freshIds.add(epUrn);
                    result.endpointsCreated++;
                } catch (err) {
                    const msg = `[GraphQLSDL] Failed to merge ${field.operation} ${field.fieldName}: ${(err as Error).message}`;
                    logger.warn(msg);
                    result.errors.push(msg);
                }
            }

            // Soft-delete stale endpoints (fields that disappeared from the SDL)
            const staleIds = existingIds.filter(id => !freshIds.has(id));
            if (staleIds.length > 0) {
                try {
                    await markGraphQLEndpointsStale(staleIds, sdl.commitHash);
                    result.endpointsStaled += staleIds.length;
                    logger.debug(`[GraphQLSDL] Staled ${staleIds.length} SDL endpoint(s) for ${apiUrn}`);
                } catch (err) {
                    logger.warn(`[GraphQLSDL] Stale marking failed for ${apiUrn}: ${(err as Error).message}`);
                }
            }

            r.report(`[GraphQLSDL] ${apiUrn}: ${uniqueFields.length} SDL fields merged (${staleIds.length} staled)`);
        }
    }

    return result;
}
