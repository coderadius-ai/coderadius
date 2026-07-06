import { linkFunctionCallsEndpoint, mergeCodeExposedEndpoint, mergeCodeInferredAPIInterface, mergeCodeInferredGraphQLEndpoint, mergeEmergentAPIEndpoint, mergeEmergentGraphQLConsumedAPIInterface, mergeEmergentGraphQLEndpoint } from '../../../graph/mutations/api-contracts.js';
import { mergeService } from '../../../graph/mutations/c4.js';
import { linkLibraryContainsFunction, linkLibraryStoredIn, linkServiceContainsFunction, linkServiceStoredIn, mergeFunction, mergeLibrary, tombstoneFunctionRelationships } from '../../../graph/mutations/code-graph.js';
import { findDataStructureBySourceFile, linkChannelToSchema, linkFunctionConsumesFields, linkFunctionConsumesSchema, linkFunctionProducesFields, linkFunctionProducesSchema, mergeEmergentSchema } from '../../../graph/mutations/data-contracts.js';
import { linkRepositoryContainsSourceFile, linkServiceOwnsSourceFile, linkSourceFileContainsFunction, mergeSourceFile } from '../../../graph/mutations/merkle.js';
import { linkLibraryDependsOnPackage, linkRepositoryDependsOnPackage, linkServiceDependsOnPackage, mergePackage } from '../../../graph/mutations/packages.js';
import { telemetryCollector } from '../../../telemetry/index.js';
import { traceCollector } from '../../../telemetry/index.js';
import { logger } from '../../../utils/logger.js';
import { buildUrn, assertScopeSegment } from '../../../graph/urn.js';
import { llmGrounding, astGrounding, type GroundingFields } from '../../../graph/grounding.js';
import { getQualifiedRepoName } from '../../../graph/urn.js';
import type { ScanMode } from '../../../graph/scan-mode.js';
import { loadRepoContext } from '../../../config/repo-context.js';
import { configManager } from '../../../config/index.js';
import { interpretDatastore, interpretCache, interpretObjectStorage, interpretResourceDeclarations } from './interpret/datastore.js';
import { interpretEnvVars } from './interpret/env-vars.js';
import { interpretProcess } from './interpret/system-process.js';
import { interpretApiCalls, type EmergentApiCallItem, type EmergentSchemaIntent } from './interpret/api-calls.js';
import { interpretPayloads, type LlmPayloadItem, type EntitySchemaItem } from './interpret/payloads.js';
import { interpretMessageChannel, type SchemaLinkIntent } from './interpret/message-channel.js';
import { MemgraphGraphStore } from '../../../graph/write-model/memgraph-applier.js';
import { mergeDeltas, type GraphDelta } from '../../../graph/write-model/delta.js';
import type { GraphStore } from '../../../graph/write-model/store.js';
import type { KindFamily } from '../db-scope-resolver.js';
import { buildRepoEnvMap } from '../connection-extractors/env-var-resolver.js';
import { resolveCallerBaseUrl } from '../caller-base-url-resolver.js';
import type { DataContainerWeldingHints } from '../../../graph/mutations/data-contracts.js';
import type { DiscoveredService } from '../../extractors/autodiscovery.js';
import {
    GENERIC_INFRA_NAMES,
    SYSTEM_DATABASE_NAMES,
    isTemplatedPayloadName,
    isUnresolvedTemplateName,
} from '../../../ai/workflows/sanitizer.js';
import type {
    FileContext,
    OwnershipRouting,
    ExtractedFunctionData,
    ExtractedSchemaData,
    ManifestResult,
    StaticAnalysisResult,
    CacheHitResult,
    UnchangedFunctionRef,
    PersistenceResult,
    ProgressReporter,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 4: Graph Persistence (GraphWriter)
//
// Responsibility:
//   - Persist extracted data into Neo4j via Cypher MERGE queries
//   - Create/update Function, SourceFile, Datastore, DataContainer,
//     MessageChannel, SystemProcess, EnvVar, Schema, and relationship nodes/edges
//   - Handle manifest dependency linking
//
// This stage performs NO data transformation. It is a pure write layer.
// It takes fully structured data from Stage 2 and Stage 3 and writes it
// to the graph.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────────────────────

// GraphStore port for delta-based persistence. Known limitation: the adapter
// is module-level rather than injected through persistFunction's signature.
const graphStore: GraphStore = new MemgraphGraphStore();

// NOTE: Repo hints memoization is now handled directly by loadRepoHints()
// in repo-hints.ts. The previous _repoHintsCache in this file was removed
// as redundant (see v3.1 Datastore Discovery plan, Component 1).

import type { MessageChannelKind } from '../../../graph/mutations/data-contracts.js';

// NOTE: InfraWithGrounding + groundingForInfra moved to
// interpret/infra-grounding.ts.
import { groundingForInfra, type InfraWithGrounding } from './interpret/infra-grounding.js';

// NOTE: emitDatabaseEndpointsForBinding moved into the datastore
// interpreter (interpret/datastore.ts appendEndpointFacts).

/**
 * EXPOSES_API GraphQL gate.
 *
 * Returns true when the hosting service actually bootstraps a GraphQL server.
 * Backed by the `frameworkRoleSignals` declared per language plugin
 * (CLAUDE.md §1, §2: detection lives in plugins, the core just consults).
 *
 * Without this gate, every workspace that imports a resolver lib produces
 * phantom EXPOSES_API edges — observed in monorepos where CLI/worker apps
 * pull the same resolver classes via TS workspace imports.
 */
function serviceHasGraphQLServerRole(
    ownerService: DiscoveredService | null,
    routing: OwnershipRouting,
): boolean {
    void routing; // routing is currently used only for naming; reserved for future role overrides
    if (!ownerService) return false;
    return ownerService.frameworkRoles?.has('graphql-server') === true;
}

// NOTE: channel-name resolution (resolveMessageChannelName & helpers) moved
// to interpret/message-channel.ts.

// NOTE: inferGraphQLDocumentNameFromSource moved to
// interpret/api-calls.ts.


// NOTE: inferDatastoreFromEnvVars() and DATASTORE_ENV_PATTERNS moved to
// db-scope-resolver.ts next to the binding resolver that
// consumes the hint; the datastore interpreter imports them from there.
// NOTE: selectDatastoreHint() and INFRA_TYPE_TO_TECH have been moved to
// db-scope-resolver.ts as _selectFromYamlDatastores() and used internally
// by resolveDatastoreBinding(). See v3.1 Datastore Discovery plan, Component 4.

/**
 * Persist the SourceFile node and its routing relationships
 * (service/library ownership, [:OWNS] links).
 */
async function persistFileContext(fileContext: FileContext, scanMode: ScanMode): Promise<void> {
    const { relativePath, fileHash, repo, routing, ownerService } = fileContext;
    const commitHash = fileContext.repo.commit || "SYSTEM";

    await mergeSourceFile(
        relativePath,
        fileHash,
        getQualifiedRepoName(repo),
        routing.urn,
        scanMode,
        commitHash,
    );

    // Always link Repository→SourceFile via [:CONTAINS] for graph traversal.
    // This guarantees the Merkle index query can use O(1)-hop traversal
    // instead of O(N) label scan with STARTS WITH, regardless of monorepo routing.
    await linkRepositoryContainsSourceFile(getQualifiedRepoName(repo), relativePath, commitHash);

    // Monorepo routing relationships. Service discovered from autodiscovery
    // heuristic on monorepo file structure — deterministic AST classification.
    if (routing.type === 'service') {
        await mergeService(
            getQualifiedRepoName(repo), routing.name, undefined, undefined, undefined, undefined,
            repo.branch, repo.commit, commitHash,
            astGrounding('monorepo-autodiscovery@v1'),
        );
        await linkServiceStoredIn(getQualifiedRepoName(repo), routing.name, getQualifiedRepoName(repo), `apps/${routing.name}`, commitHash);
    } else if (routing.type === 'library') {
        await mergeLibrary(routing.name, commitHash);
        await linkLibraryStoredIn(routing.name, getQualifiedRepoName(repo), `packages/${routing.name}`, commitHash);
    }

    // Auto-discovery [:OWNS] link + [:STORED_IN] fallback. Library workspaces
    // have no OWNS mutation (Library-CONTAINS-Function in persistFunction is
    // the canonical link) so we skip the Service-only calls when the owner is
    // a library; STORED_IN for libraries is already written by the
    // topology-resolver.
    if (ownerService && ownerService.isRuntimeService) {
        await linkServiceOwnsSourceFile(getQualifiedRepoName(repo), ownerService.name, relativePath, commitHash);
        const servicePath = relativePath.split('/').slice(0, relativePath.split('/').indexOf(ownerService.name) + 1).join('/');
        await linkServiceStoredIn(getQualifiedRepoName(repo), ownerService.name, getQualifiedRepoName(repo), servicePath || ownerService.name, commitHash);
    }
}

// ─── Function Persistence ────────────────────────────────────────────────────

/**
 * Persist a single extracted function and all its relationships.
 *
 * Creates:
 *   - Function node (MERGE)
 *   - Ownership: Service/Library [:CONTAINS] Function
 *   - Infrastructure: Function [:READS|:WRITES] DataContainer, [:CONNECTS_TO] Datastore,
 *                      [:COMMUNICATES_WITH] MessageChannel|SystemProcess
 *   - Emergent API calls: Function [:CALLS] APIEndpoint
 *   - Data contracts: Function [:PRODUCES|:CONSUMES] DataStructure [:HAS_FIELD] DataField
 *   - Env vars: Function [:READS_ENV] EnvVar
 */

// NOTE: mergeAstWithLlm + payloadGroundingFor moved to
// interpret/payloads.ts.


/**
 * Per-function persistence context threaded through the collector and the
 * intent executors.
 */
interface FunctionPersistContext {
    data: ExtractedFunctionData;
    functionId: string;
    commitHash: string;
    relativePath: string;
    chunk: ExtractedFunctionData['chunk'];
    repo: FileContext['repo'];
    routing: OwnershipRouting;
    ownerService: FileContext['ownerService'];
    qualifiedRepoName: string;
    scopeKey: string;
    isDeepScan: boolean;
    repoCtx: ReturnType<typeof loadRepoContext>;
    analysis: ExtractedFunctionData['analysis'];
}

/**
 * Dispatch the pure interpreters (infra kinds, resource declarations,
 * env vars) and collect their GraphDeltas plus the channel schema-link
 * intents. No graph IO happens here.
 */
function collectInterpretedDeltas(pctx: FunctionPersistContext): { deltas: GraphDelta[]; schemaLinks: SchemaLinkIntent[] } {
    const { data, functionId, commitHash, relativePath, chunk, qualifiedRepoName, repoCtx, analysis } = pctx;
    const infraDeltas: GraphDelta[] = [];
    const channelSchemaLinks: SchemaLinkIntent[] = [];
    const datastoreCtx = () => ({
        functionId,
        qualifiedRepoName,
        commitHash,
        repoHints: repoCtx.hints,
        identities: repoCtx.identities,
        envVarNames: (data.chunk.envVars || []).map((v: string) => v.toUpperCase()),
        allowPlainTextHosts: configManager.getAllowPlainTextHosts(),
    });

    if (analysis.infrastructure) {
        const qualifiedName = qualifiedRepoName;
        const repoHints = repoCtx.hints;

        for (const infra of analysis.infrastructure) {
            // Layer 0: drop generic technology names entirely (replaces -unknown-db transform)
            if (GENERIC_INFRA_NAMES.has(infra.name.toLowerCase())) {
                logger.debug(`[GraphWriter] Dropped generic infra name: "${infra.name}"`);
                traceCollector.tracePersist('DROP', `infra:${infra.type}:${infra.name}`, 'generic infra name (graph-writer layer)', { filePath: relativePath, functionName: chunk.name });
                continue;
            }

            switch (infra.type) {
                case 'Database': {
                    // The Database kind is interpreted into a
                    // GraphDelta by the pure datastore interpreter and applied
                    // in ONE transaction after the infra loop. Decision logic
                    // (placeholder binding, system-db denylist, ambiguity,
                    // welding hints, grounding precedence) lives in
                    // interpret/datastore.ts, pinned by unit tests.
                    const outcome = interpretDatastore({
                        name: infra.name,
                        operation: infra.operation,
                        kindFamily: (infra as { kindFamily?: KindFamily }).kindFamily,
                        technology: (infra as { technology?: string }).technology,
                        grounding: (infra as InfraWithGrounding).grounding,
                    }, datastoreCtx());
                    infraDeltas.push(outcome.delta);
                    for (const t of outcome.traces) {
                        traceCollector.tracePersist(t.action, t.target, t.reason, { filePath: relativePath, functionName: chunk.name, ...t.meta });
                    }
                    break;
                }
                case 'MessageChannel': {
                    // Interpreted into a GraphDelta by the
                    // pure channel interpreter (env-var + alias resolution,
                    // routingKey edge identity, subscription routing) and
                    // applied with the other infra facts after the loop.
                    // Schema linkage needs a DataStructure lookup, so it
                    // comes back as an intent processed post-apply.
                    const channelItem = infra as InfraWithGrounding & {
                        name: string;
                        operation: 'READS' | 'WRITES' | 'MAPS_TO';
                        channelKind?: MessageChannelKind;
                        schemaPath?: string;
                        schemaFormat?: string;
                        technology?: string;
                        routingKey?: string;
                        partitionKey?: string;
                        consumerGroup?: string;
                    };
                    const outcome = interpretMessageChannel(channelItem, {
                        functionId,
                        commitHash,
                        repoHints,
                        envVarDict: repoCtx.envVarDict,
                    });
                    infraDeltas.push(outcome.delta);
                    channelSchemaLinks.push(...outcome.schemaLinks);
                    for (const log of outcome.logs) {
                        logger[log.level](`[GraphWriter] ${log.message}`);
                    }
                    for (const t of outcome.traces) {
                        traceCollector.tracePersist(t.action, t.target, t.reason, { filePath: relativePath, functionName: chunk.name, ...t.meta });
                    }
                    break;
                }
                case 'Cache': {
                    // Interpreted (kv auto-promotion; explicit DI
                    // grounding wins). No DataContainer for caches.
                    const outcome = interpretCache(infra as InfraWithGrounding & { name: string }, datastoreCtx());
                    infraDeltas.push(outcome.delta);
                    break;
                }
                case 'ObjectStorage': {
                    // Interpreted (placeholder-first-binding, object
                    // tech autopromotion, yaml fallback).
                    const outcome = interpretObjectStorage(
                        infra as InfraWithGrounding & { name: string; operation: 'READS' | 'WRITES' | 'MAPS_TO'; technology?: string },
                        datastoreCtx(),
                    );
                    infraDeltas.push(outcome.delta);
                    for (const t of outcome.traces) {
                        traceCollector.tracePersist(t.action, t.target, t.reason, { filePath: relativePath, functionName: chunk.name, ...t.meta });
                    }
                    break;
                }
                case 'ExternalAPI': {
                    // ExternalAPI → already handled by emergent_api_calls, skip
                    break;
                }
                case 'Process': {
                    const outcome = interpretProcess(infra as InfraWithGrounding & { name: string }, { functionId, commitHash });
                    infraDeltas.push(outcome.delta);
                    break;
                }
            }
        }
    }


    if (data.resourceDeclarations && data.resourceDeclarations.length > 0) {
        const outcome = interpretResourceDeclarations(data.resourceDeclarations, datastoreCtx());
        infraDeltas.push(outcome.delta);
        for (const log of outcome.logs ?? []) logger[log.level](`[GraphWriter] ${log.message}`);
        for (const t of outcome.traces) {
            traceCollector.tracePersist(t.action, t.target, t.reason, { filePath: relativePath, functionName: chunk.name, ...t.meta });
        }
    }

    // ── Environment variable relationships ──────────────────────────────
    if (chunk.envVars && chunk.envVars.length > 0) {
        infraDeltas.push(interpretEnvVars(chunk.envVars, repoCtx.envVarDict, { functionId, commitHash }).delta);
    }

    return { deltas: infraDeltas, schemaLinks: channelSchemaLinks };
}

/**
 * Execute the emergent-API write intents against the bespoke API mutations
 * (the APIEndpoint dedup/welding contract stays on that path). Returns the
 * counters plus the request-body fingerprints consumed by the payload pass.
 */
async function executeApiCallIntents(pctx: FunctionPersistContext): Promise<{
    apiEndpointsLinked: number;
    dataContractsLinked: number;
    requestBodyFingerprints: Set<string>;
}> {
    const { functionId, commitHash, relativePath, chunk, repo, routing, ownerService, scopeKey, isDeepScan, analysis } = pctx;
    let apiEndpointsLinked = 0;
    let dataContractsLinked = 0;
    // ── Emergent API Calls → APIEndpoint nodes ──────────────────────────
    //
    // Every DECISION (noisy/dynamic filtering, GraphQL/HTTP fork,
    // EXPOSES_API server-role gate, payload naming + link direction, dedup
    // fingerprints) lives in interpret/api-calls.ts as a pure interpreter
    // returning typed write intents. The intents execute below against the
    // bespoke API mutations — the APIEndpoint dedup/welding contract
    // (apiSource/epSource, welding anchors) stays on the proven write path.
    //
    // `writtenRequestBodyFingerprints` suppresses produced/consumed payload
    // duplicates downstream: the LLM frequently emits the same body both as
    // `payload_schema` and as a top-level payload entry.
    const writtenRequestBodyFingerprints = new Set<string>();

    if ('emergent_api_calls' in analysis && analysis.emergent_api_calls && analysis.emergent_api_calls.length > 0) {
        // Caller-side base URL resolution (fs-backed env map) is IO, so it is
        // resolved here and handed to the executor for the :CALLS edges.
        let callerResolution: ReturnType<typeof resolveCallerBaseUrl> | null = null;
        try {
            callerResolution = resolveCallerBaseUrl(chunk.sourceCode, buildRepoEnvMap(repo.path, { serviceRoot: ownerService?.path }));
        } catch (e) {
            logger.debug(`[GraphWriter] caller base URL resolution failed for ${chunk.name}: ${(e as Error).message}`);
        }
        const callerCallsOpts = callerResolution
            ? {
                observedBaseUrl: callerResolution.canonicalUrl,
                observedEnvironment: callerResolution.environment,
                declaredBy: 'env-var' as const,
            }
            : undefined;

        const serviceName = routing.type === 'service' ? routing.name : (ownerService?.name ?? null);
        const outcome = interpretApiCalls(analysis.emergent_api_calls as EmergentApiCallItem[], {
            functionId,
            sourceCode: chunk.sourceCode,
            isDeepScan,
            serviceName,
            callerServiceUrn: buildUrn('service', getQualifiedRepoName(repo), ownerService?.name ?? routing.name),
            graphqlServerRole: serviceHasGraphQLServerRole(ownerService, routing),
        });
        for (const log of outcome.logs) logger[log.level](`[GraphWriter] ${log.message}`);
        for (const t of outcome.traces) {
            traceCollector.tracePersist(t.action, t.target, t.reason, { filePath: relativePath, functionName: chunk.name, ...t.meta });
        }
        for (const fp of outcome.requestBodyFingerprints) writtenRequestBodyFingerprints.add(fp);

        // Code-inferred API interface: lazily merged once per function
        // (idempotent per service).
        let codeInferredApiUrn: string | null = null;
        const ensureCodeInferredApi = async (intentServiceName: string): Promise<string> => {
            if (!codeInferredApiUrn) {
                codeInferredApiUrn = await mergeCodeInferredAPIInterface(getQualifiedRepoName(repo), intentServiceName, commitHash);
            }
            return codeInferredApiUrn;
        };
        const writeSchemaIntents = async (schemas: EmergentSchemaIntent[]): Promise<void> => {
            for (const schema of schemas) {
                const merged = await mergeEmergentSchema({
                    qualifiedRepoName: getQualifiedRepoName(repo),
                    filepath: relativePath,
                    schemaName: schema.schemaName,
                    schemaType: 'message_payload',
                    fields: schema.fields,
                    commitHash,
                    scopeKey: scopeKey,
                    grounding: llmGrounding('unified-analyzer', 'graph-writer@v1'),
                });
                if (schema.link === 'produces') await linkFunctionProducesSchema(functionId, merged.schemaUrn, undefined, commitHash);
                else await linkFunctionConsumesSchema(functionId, merged.schemaUrn, undefined, commitHash);
                dataContractsLinked++;
            }
        };

        for (const intent of outcome.intents) {
            switch (intent.kind) {
                case 'gql-inbound': {
                    const apiUrn = await ensureCodeInferredApi(intent.serviceName);
                    await mergeCodeInferredGraphQLEndpoint(apiUrn, intent.operation, intent.operationName, functionId, commitHash, intent.framework);
                    break;
                }
                case 'gql-outbound': {
                    // Anchor the emergent endpoint to a per-caller outbound
                    // :APIInterface so the global-resolver GraphQL welder has a
                    // service-level CONSUMES_API edge to traverse.
                    const apiUrn = await mergeEmergentGraphQLConsumedAPIInterface(
                        intent.callerServiceUrn, intent.documentName, commitHash, llmGrounding('unified-analyzer', 'graph-writer@v2'));
                    const emergentUrn = await mergeEmergentGraphQLEndpoint(
                        apiUrn, intent.operation, intent.operationName, commitHash, intent.documentName, llmGrounding('unified-analyzer', 'graph-writer@v2'));
                    await linkFunctionCallsEndpoint(functionId, emergentUrn, commitHash, callerCallsOpts);
                    break;
                }
                case 'http-inbound': {
                    const apiUrn = await ensureCodeInferredApi(intent.serviceName);
                    await mergeCodeExposedEndpoint(apiUrn, intent.method, intent.path, functionId, commitHash, intent.framework);
                    await writeSchemaIntents(intent.schemas);
                    break;
                }
                case 'http-outbound': {
                    const endpointUrn = await mergeEmergentAPIEndpoint(
                        intent.method, intent.normalizedPath, intent.rawPath, commitHash, llmGrounding('unified-analyzer', 'graph-writer@v1'));
                    await linkFunctionCallsEndpoint(functionId, endpointUrn, commitHash, callerCallsOpts);
                    await writeSchemaIntents(intent.schemas);
                    break;
                }
            }
            apiEndpointsLinked++;
        }
    }

    return { apiEndpointsLinked, dataContractsLinked, requestBodyFingerprints: writtenRequestBodyFingerprints };
}

/**
 * Interpret and persist produced/consumed payloads + ORM entity schemas.
 * Writes stay on mergeEmergentSchema (its output feeds field lineage).
 * Returns the data-contract count.
 */
async function executePayloadIntents(pctx: FunctionPersistContext, writtenRequestBodyFingerprints: ReadonlySet<string>): Promise<number> {
    const { data, functionId, commitHash, relativePath, chunk, repo, scopeKey, isDeepScan, repoCtx, analysis } = pctx;
    let dataContractsLinked = 0;
    // ── Payloads + ORM entity schemas → DataStructure nodes ─────────────
    // Decisions (AST/LLM merge tagging, opaque governance, template
    // and fingerprint guards, deep-scan field materialisation) live in
    // interpret/payloads.ts. Writes stay on mergeEmergentSchema because its
    // output (schemaUrn + fieldUrns) feeds the field-level lineage links.
    const payloadAnalysis = analysis as {
        produced_payloads?: LlmPayloadItem[];
        consumed_payloads?: LlmPayloadItem[];
        entity_schemas?: EntitySchemaItem[];
    };
    const payloadOutcome = interpretPayloads({
        produced: payloadAnalysis.produced_payloads,
        consumed: payloadAnalysis.consumed_payloads,
        entitySchemas: payloadAnalysis.entity_schemas,
        astResolved: data.astResolvedPayloads,
    }, {
        functionName: chunk.name,
        relativePath,
        isDeepScan,
        writtenFingerprints: writtenRequestBodyFingerprints,
    });
    for (const log of payloadOutcome.logs) {
        const prefix = log.level === 'warn' ? '' : '[GraphWriter] ';
        logger[log.level](`${prefix}${log.message}`);
    }
    telemetryCollector.incrementDsAstResolved(payloadOutcome.telemetry.astResolved);
    telemetryCollector.incrementDsAstLlmConverged(payloadOutcome.telemetry.astLlmConverged);
    telemetryCollector.incrementDsLlmOnly(payloadOutcome.telemetry.llmOnly);

    for (const intent of payloadOutcome.schemas) {
        const merged = await mergeEmergentSchema({
            qualifiedRepoName: getQualifiedRepoName(repo),
            filepath: relativePath,
            schemaName: intent.schemaName,
            schemaType: intent.kind === 'entity-table' ? 'database_table' : 'message_payload',
            fields: intent.fields,
            commitHash,
            ...(intent.kind === 'payload' ? { scopeKey } : {}),
            grounding: intent.grounding,
        });
        if (intent.kind === 'entity-table') {
            await linkFunctionProducesSchema(functionId, merged.schemaUrn, false, commitHash);
            dataContractsLinked++;
            continue;
        }
        if (intent.link === 'produces') await linkFunctionProducesSchema(functionId, merged.schemaUrn, intent.isOpaque, commitHash);
        else await linkFunctionConsumesSchema(functionId, merged.schemaUrn, intent.isOpaque, commitHash);
        // Field-level lineage (Phase 2): deep-mode only, non-opaque payloads.
        if (intent.withFieldLineage && merged.fieldUrns.length > 0) {
            const cap = { cap: repoCtx.hints?.ingestion?.maxFieldsPerPayload };
            if (intent.link === 'produces') {
                const fieldRes = await linkFunctionProducesFields(functionId, merged.schemaUrn, merged.fieldUrns, commitHash, cap);
                telemetryCollector.incrementFieldLineage(fieldRes.linked, 0, fieldRes.capped);
            } else {
                const fieldRes = await linkFunctionConsumesFields(functionId, merged.schemaUrn, merged.fieldUrns, commitHash, cap);
                telemetryCollector.incrementFieldLineage(0, fieldRes.linked, fieldRes.capped);
            }
        }
        // Telemetry: scoped vs global URN distribution.
        if (merged.schemaUrn.split(':').length > 4) telemetryCollector.incrementDsScoped();
        else telemetryCollector.incrementDsGlobal();
        dataContractsLinked++;
    }

    return dataContractsLinked;
}

async function persistFunction(
    data: ExtractedFunctionData,
    embedding: number[] | null,
    scanMode: ScanMode,
): Promise<{ apiEndpointsLinked: number; dataContractsLinked: number }> {
    const commitHash = data.fileContext.repo.commit || "SYSTEM";
    const { functionId, functionHash, chunk, fileContext, analysis } = data;
    const { relativePath, repo, routing, ownerService } = fileContext;
    // Bounded-context scope for emergent message_payload schemas. Form `{repoSeg}:{serviceSeg}`
    // (e.g. `acme:orders`). Per Phase 1A: scoping prevents cross-service collisions on
    // LLM-inferred payload names. Only applied inside `mergeEmergentSchema` when
    // schemaType === 'message_payload' and schemaFormat is undefined.
    const qualifiedRepoName = getQualifiedRepoName(repo);
    const repoScopeSeg = assertScopeSegment(qualifiedRepoName, 'graph-writer.repo');
    const svcName = ownerService?.name ?? (routing.type === 'service' ? routing.name : null);
    const scopeKey = svcName
        ? `${repoScopeSeg}:${assertScopeSegment(svcName, 'graph-writer.service')}`
        : repoScopeSeg;
    const pctx: FunctionPersistContext = {
        data, functionId, commitHash, relativePath, chunk, repo, routing, ownerService,
        qualifiedRepoName, scopeKey,
        isDeepScan: scanMode === 'contracts',
        repoCtx: loadRepoContext(repo.path),
        analysis,
    };

    // Tombstone ALL existing outgoing relationships for this function node.
    // This handles "zombie" infrastructure nodes left behind after renames
    // or changes in analysis. The subsequent writes "revive"
    // (valid_to_commit = null) only the edges that are still valid.
    await tombstoneFunctionRelationships(functionId, commitHash);

    await mergeFunction(functionId,
        chunk.name,
        relativePath,
        analysis.intent,
        analysis.capabilities || [],
        embedding,
        chunk.language,
        chunk.startLine,
        chunk.endLine,
        functionHash, commitHash);

    traceCollector.tracePersist('WRITE', functionId, 'function merged to graph', {
        filePath: relativePath,
        functionName: chunk.name,
        intent: analysis.intent,
        infraCount: analysis.infrastructure?.length ?? 0,
        capsCount: analysis.capabilities?.length ?? 0,
    });

    await linkFunctionOwnership(pctx);
    await linkSourceFileContainsFunction(relativePath, functionId, qualifiedRepoName, commitHash);

    // Pure interpreters → deltas; intent executors → bespoke mutations.
    const { deltas, schemaLinks } = collectInterpretedDeltas(pctx);
    const api = await executeApiCallIntents(pctx);
    const dataContractsLinked = api.dataContractsLinked
        + await executePayloadIntents(pctx, api.requestBodyFingerprints);

    // ── Single-transaction apply of every interpreted fact ──────────────
    // Nodes land before edges, so CONFIGURED_VIA/READS_ENV resolve against
    // EnvVar nodes from this very function.
    const infraDelta = mergeDeltas(...deltas);
    if (infraDelta.nodes.length > 0 || infraDelta.edges.length > 0) {
        const applied = await graphStore.apply(infraDelta, { commitHash });
        // An endpoint miss here means a genuinely dangling ref (e.g. a
        // CONFIGURED_VIA to an env var no function reads) — surface it.
        for (const skipped of applied.skippedEdges) {
            logger.warn(`[GraphWriter] Skipped ${skipped.type} edge (missing endpoint): ${skipped.fromUrn} -> ${skipped.toUrn}`);
        }
    }

    await resolveChannelSchemaLinks(schemaLinks, commitHash, relativePath, chunk.name);

    return { apiEndpointsLinked: api.apiEndpointsLinked, dataContractsLinked };
}

/** Service/Library [:CONTAINS] ownership, with the dynamic longest-prefix fallback. */
async function linkFunctionOwnership(pctx: FunctionPersistContext): Promise<void> {
    const { functionId, commitHash, routing, ownerService, qualifiedRepoName } = pctx;
    if (routing.type === 'service') {
        await linkServiceContainsFunction(qualifiedRepoName, routing.name, functionId, commitHash);
    } else if (routing.type === 'library') {
        await linkLibraryContainsFunction(routing.name, functionId, commitHash);
    } else if (ownerService) {
        // Dynamic fallback: resolve ownership via longest-prefix match.
        // Dispatch to the right target based on the workspace's classification
        // so we never MERGE against a Service node that the topology-resolver
        // did not create (which would silently no-op).
        if (ownerService.isRuntimeService) {
            await linkServiceContainsFunction(qualifiedRepoName, ownerService.name, functionId, commitHash);
        } else {
            await linkLibraryContainsFunction(ownerService.name, functionId, commitHash);
        }
    }
}

/**
 * Channel schema linkage (post-apply: needs the channel nodes live). Looks up
 * the DataStructure created by the Avro structural pass via SourceFile path
 * match — avoids phantom stubs, guarantees URN consistency.
 */
async function resolveChannelSchemaLinks(
    schemaLinks: SchemaLinkIntent[],
    commitHash: string,
    relativePath: string,
    functionName: string,
): Promise<void> {
    for (const link of schemaLinks) {
        const schemaUrn = await findDataStructureBySourceFile(link.schemaPath);
        if (schemaUrn) {
            await linkChannelToSchema(link.channelUrn, schemaUrn, commitHash);
            traceCollector.tracePersist('WRITE', `schema-link:${link.channelName}`,
                'Linked MessageChannel to existing DataStructure via SourceFile match',
                { channelName: link.channelName, schemaPath: link.schemaPath, schemaUrn, filePath: relativePath, functionName });
        } else {
            logger.debug(`[GraphWriter] No DataStructure found for schemaPath="${link.schemaPath}" — schema file may not be in repo`);
        }
    }
}

// ─── Manifest Persistence ────────────────────────────────────────────────────

/**
 * Persist a manifest file's dependencies into the graph.
 */
async function persistManifest(manifest: ManifestResult, scanMode: ScanMode): Promise<void> {
    const commitHash = "SYSTEM";

    const { fileContext, dependencies } = manifest;
    const { relativePath, fileHash, repo, routing, ownerService } = fileContext;

    // Persist the SourceFile node
    await mergeSourceFile(
        relativePath,
        fileHash,
        getQualifiedRepoName(repo),
        routing.urn,
        scanMode,
        commitHash,
    );

    // Always link Repository→SourceFile for graph traversal (same rationale as persistFileContext)
    await linkRepositoryContainsSourceFile(getQualifiedRepoName(repo), relativePath, commitHash);

    // Persist [:OWNS] link + [:STORED_IN] fallback from auto-discovered service.
    // Library workspaces skip this path (see persistFileContext for rationale).
    if (ownerService && ownerService.isRuntimeService) {
        await linkServiceOwnsSourceFile(getQualifiedRepoName(repo), ownerService.name, relativePath, commitHash);
        const servicePath = relativePath.split('/').slice(0, relativePath.split('/').indexOf(ownerService.name) + 1).join('/');
        await linkServiceStoredIn(getQualifiedRepoName(repo), ownerService.name, getQualifiedRepoName(repo), servicePath || ownerService.name, commitHash);
    }

    // Persist dependency relationships
    for (const dep of dependencies) {
        const pkgUrn = buildUrn('package', dep.ecosystem, dep.name);
        await mergePackage(dep.ecosystem, dep.name, dep.isInternal, commitHash);

        if (routing.type === 'service') {
            await linkServiceDependsOnPackage(getQualifiedRepoName(repo), routing.name, pkgUrn, dep.requiredVersion, dep.isDev, commitHash);
        } else if (routing.type === 'library') {
            await linkLibraryDependsOnPackage(routing.name, pkgUrn, dep.requiredVersion, dep.isDev, commitHash);
        } else if (routing.type === 'repository') {
            if (ownerService) {
                if (ownerService.isRuntimeService) {
                    await linkServiceDependsOnPackage(getQualifiedRepoName(repo), ownerService.name, pkgUrn, dep.requiredVersion, dep.isDev, commitHash);
                } else {
                    await linkLibraryDependsOnPackage(ownerService.name, pkgUrn, dep.requiredVersion, dep.isDev, commitHash);
                }
            } else {
                await linkRepositoryDependsOnPackage(routing.name, pkgUrn, dep.requiredVersion, dep.isDev, commitHash);
            }
        }
    }
}

// ─── Schema Persistence ─────────────────────────────────────────────────────

/**
 * Persist extracted data schemas into the graph.
 */
/**
 * Persist extracted data schemas into the graph.
 *
 * Exported for testability — exercised by the unit test that pins the
 * Phase 1A SourceFile URN regression (Doctrine entity Snapshot.php
 * was shadow-merged under `cr:sourcefile:classes:...` because the
 * qualifiedRepoName fell back to `relativePath.split('/')[0]`).
 */
export async function persistSchemas(schemaData: ExtractedSchemaData, scanMode: ScanMode): Promise<number> {
    const commitHash = "SYSTEM";
    const isDeepScan = scanMode === 'contracts';

    let count = 0;
    for (const schema of schemaData.schemas) {
        // Drop schema names that contain unresolved template placeholders
        // (`quote_{kind}`, `order_{type}`). The structural / LLM
        // extractor occasionally lets these through; they are unbindable
        // (no DataContainer can match) and pollute the schema inventory.
        //
        // The existing `isUnresolvedTemplateName` predicate covers PHP
        // variables, printf templates, and UPPERCASE `{ENV_VAR}` patterns
        // but misses lowercase placeholders like `{tipo}` (Italian) /
        // `{type}` / `{name}`. For database_table and message_payload
        // identity, ANY curly brace is illegitimate (these are table or
        // class names, not REST URL paths), so we drop on bare brace
        // presence as a defense-in-depth filter on top of the existing
        // template-name predicate.
        if (isUnresolvedTemplateName(schema.name) || /[{}]/.test(schema.name)) {
            logger.debug(`[GraphWriter] Skipping schema with unresolved template name: "${schema.name}"`);
            continue;
        }
        // Schemas surfaced by deterministic AST/regex extractors (Doctrine,
        // Mongoose, SQL-create-table inference); grounding: ast/exact.
        // No scopeKey: deterministic structural extraction → global URN.
        // qualifiedRepoName comes from SchemaContext (populated in task-builder
        // from FileContext.repo) — MUST match the value merkle.ts used when
        // creating the SourceFile node, else mergeEmergentSchema's
        // `MERGE (sf:SourceFile {id: $sourceFileUrn})` creates a shadow
        // SourceFile orphan from any Repository CONTAINS edge, and
        // linkDataContainerSchemas' Repository-side join silently fails.
        await mergeEmergentSchema({
            qualifiedRepoName: schemaData.qualifiedRepoName,
            filepath: schemaData.relativePath,
            schemaName: schema.name,
            schemaType: schema.type,
            fields: isDeepScan ? schema.fields : [],
            hasDynamicKeys: schema.has_dynamic_keys,
            commitHash,
            grounding: astGrounding('schema-structural-extractor@v1'),
        });
        count++;
    }
    return count;
}

// ─── Unchanged Function Link Persistence ─────────────────────────────────────

/**
 * Persist SourceFile→Function links for functions that matched the
 * Merkle hash (unchanged). Even though the function node already exists
 * in Neo4j, the link must be re-asserted because the SourceFile node
 * may have been recreated (e.g. if the hash was stale after a DB wipe).
 */
async function persistUnchangedFunctionLinks(
    fileContext: FileContext,

    unchangedFunctions: UnchangedFunctionRef[],
): Promise<void> {
    const commitHash = fileContext.repo.commit || "SYSTEM";

    for (const ref of unchangedFunctions) {
        await linkSourceFileContainsFunction(ref.relativePath,
            ref.functionId,
            ref.repoName, commitHash);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Persist all extracted data into Neo4j.
 *
 * Takes the outputs of Stage 2 (manifests, file contexts, cache hits)
 * and Stage 3 (extracted functions, schemas) and writes everything to
 * the graph.
 *
 * Returns aggregate persistence metrics.
 */
export async function writeToGraph(
    extractedFunctions: ExtractedFunctionData[],
    embeddings: (number[] | null)[],
    extractedSchemas: ExtractedSchemaData[],
    manifestResults: ManifestResult[],
    analysisResults: StaticAnalysisResult[],
    cacheHitResults: CacheHitResult[],
    task?: ProgressReporter,
    scanMode: ScanMode = 'semantic',
): Promise<PersistenceResult> {
    let functionsIngested = 0;
    let resourcesLinked = 0;
    let envVarsLinked = 0;
    let schemasCreated = 0;
    let apiEndpointsLinked = 0;
    let dataContractsLinked = 0;

    // ── Persist file contexts (SourceFile nodes + routing) ───────────────
    const persistedFiles = new Set<string>();
    for (const result of analysisResults) {
        if (!persistedFiles.has(result.fileContext.relativePath)) {
            await persistFileContext(result.fileContext, scanMode);
            persistedFiles.add(result.fileContext.relativePath);
        }
    }

    // ── Persist manifests ────────────────────────────────────────────
    for (const manifest of manifestResults) {
        await persistManifest(manifest, scanMode);
    }

    // ── Persist extracted functions ──────────────────────────────────
    for (let i = 0; i < extractedFunctions.length; i++) {
        const data = extractedFunctions[i];
        const embedding = embeddings[i] ?? null;

        const result = await persistFunction(data, embedding, scanMode);
        functionsIngested++;
        apiEndpointsLinked += result.apiEndpointsLinked;
        dataContractsLinked += result.dataContractsLinked;
        telemetryCollector.incrementFunctionsIngested();

        if (data.analysis.infrastructure) {
            resourcesLinked += data.analysis.infrastructure.length;
        }
        if (data.chunk.envVars) {
            envVarsLinked += data.chunk.envVars.length;
        }
    }

    // ── Persist unchanged function links ─────────────────────────────
    // Collect all unchanged function refs from both analysis results
    // (function-level cache hits) and cache hit results (file-level cache hits).
    const allUnchangedFunctions: UnchangedFunctionRef[] = [];
    for (const result of analysisResults) {
        allUnchangedFunctions.push(...result.unchangedFunctions);
    }
    for (const cacheHit of cacheHitResults) {
        allUnchangedFunctions.push(...cacheHit.unchangedFunctions);
    }
    if (allUnchangedFunctions.length > 0) {
        const fileContext = extractedFunctions[0]?.fileContext 
            ?? analysisResults[0]?.fileContext 
            ?? cacheHitResults[0]?.fileContext;
        
        if (fileContext) {
            await persistUnchangedFunctionLinks(fileContext, allUnchangedFunctions);
        }
    }

    // ── Persist schemas ─────────────────────────────────────────────
    for (const schemaData of extractedSchemas) {
        const count = await persistSchemas(schemaData, scanMode);
        schemasCreated += count;
    }

    return {
        functionsIngested,
        resourcesLinked,
        envVarsLinked,
        schemasCreated,
        apiEndpointsLinked,
        dataContractsLinked,
    };
}
