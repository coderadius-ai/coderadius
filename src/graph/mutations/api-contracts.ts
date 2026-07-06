/**
 * API Contracts — OpenAPI, Emergent Endpoints, Edge Resolution
 *
 * APIInterface, APIEndpoint, PhysicalResource, and endpoint welding.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn, urnPrefix } from '../urn.js';
import { astGrounding, heuristicGrounding, type GroundingFields } from '../grounding.js';
import { groupEmergentDuplicates, type EmergentEndpointRow } from '../../ingestion/processors/api-path-utils.js';
import type { HttpMethod } from '@coderadius/shared-types';

const commitHash = "SYSTEM";

// ═══════════════════════════════════════════════════════════════════════════════
// API Contracts (OpenAPI)
// ═══════════════════════════════════════════════════════════════════════════════

export async function mergeAPIInterface(
    apiUrn: string,
    title: string,
    version: string,
    commitHash: string,
    apiSource: 'openapi' | 'sdl' | 'code' | 'env-var' = 'openapi',
    direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND',
    grounding?: GroundingFields,
) {
    // direction default INBOUND: an OpenAPI / SDL spec describes what the
    // service exposes. The reclassifyExposedAsConsumed step is responsible
    // for flipping the field to OUTBOUND when the same spec is reinterpreted
    // as a consumer contract (no functions implement its endpoints).
    //
    // NOTE: `apiSource` ('openapi'|'sdl'|'code') is the spec-format discriminator
    // and is stored as `api.apiSource`. The grounding-tier `source` (ast/llm/
    // composite/etc.) goes into `api.source` via groundingWriteClause.
    await run(
        `MERGE (api:APIInterface {id: $apiUrn})
     ON CREATE SET api.valid_from_commit = $commitHash, api.valid_to_commit = null, api.apiSource = $apiSource, api.direction = $direction
     ON MATCH SET api.valid_from_commit = coalesce(api.valid_from_commit, $commitHash), api.valid_to_commit = null, api.apiSource = coalesce(api.apiSource, $apiSource), api.direction = coalesce(api.direction, $direction)
     SET api.title = $title, api.version = $version
     ${groundingWriteClause('api')}`,
        { apiUrn, title, version, commitHash, apiSource, direction, ...groundingParams(grounding, commitHash) },
    );
}

export async function mergeAPIEndpoint(apiUrn: string, endpointUrn: string, path: string, method: HttpMethod, operationId: string | null, summary: string, embedding: number[] | null | undefined, commitHash: string, epSource?: 'openapi' | 'code' | 'emergent', grounding?: GroundingFields) {
    // `epSource` is the endpoint-discovery discriminator (openapi/code/emergent),
    // stored as `ep.epSource`. The grounding `source` goes into `ep.source` via
    // groundingWriteClause.
    await run(
        `MATCH (api:APIInterface {id: $apiUrn})
     MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash), ep.valid_to_commit = null
     SET ep.name = $path, ep.path = $path, ep.method = $method, ep.apiKind = 'rest', ep.operationId = $operationId, ep.summary = $summary, ep.embedding = coalesce($embedding, ep.embedding), ep.epSource = coalesce($epSource, ep.epSource)
     ${groundingWriteClause('ep')}
     WITH ep, api
     MERGE (api)-[rel:HAS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { apiUrn, endpointUrn, path, method, operationId, summary, embedding: embedding ?? null, commitHash, epSource: epSource ?? null, ...groundingParams(grounding, commitHash) },
    );
}

export async function linkServiceExposesAPI(qualifiedRepoName: string, serviceName: string, apiUrn: string, commitHash: string) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    await run(
        `MATCH (s:Service {id: $sUrn}), (api:APIInterface {id: $apiUrn})
     MERGE (s)-[rel:EXPOSES_API]->(api)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { sUrn, apiUrn , commitHash },
    );
}

export async function linkServiceConsumesAPI(
    serviceUrn: string,
    apiUrn: string,
    sourceEnvKey: string,
    commitHash: string,
): Promise<void> {
    await run(
        `MATCH (s:Service {id: $serviceUrn}), (api:APIInterface {id: $apiUrn})
         MERGE (s)-[rel:CONSUMES_API]->(api)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                       rel.sourceEnvKey = $sourceEnvKey, rel.source = 'env-var'
         ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                      rel.valid_to_commit = null,
                      rel.sourceEnvKey = coalesce(rel.sourceEnvKey, $sourceEnvKey)`,
        { serviceUrn, apiUrn, sourceEnvKey, commitHash },
    );
}

export async function pruneStaleEnvVarAPIs(commitHash: string): Promise<number> {
    const result = await run(
        `MATCH (api:APIInterface)
         WHERE api.apiSource = 'env-var'
           AND api.valid_to_commit IS NULL
           AND api.lastSeenCommit <> $commitHash
         SET api.valid_to_commit = $commitHash
         WITH api
         OPTIONAL MATCH (api)-[:DEPLOYED_AT]->(d:APIDeployment)
           WHERE d.valid_to_commit IS NULL
         SET d.valid_to_commit = $commitHash
         WITH api
         OPTIONAL MATCH ()-[rel:CONSUMES_API]->(api)
           WHERE rel.valid_to_commit IS NULL
         SET rel.valid_to_commit = $commitHash
         RETURN count(DISTINCT api) AS pruned`,
        { commitHash },
    );
    const raw = result.records[0]?.get('pruned');
    return raw?.toNumber?.() ?? Number(raw) ?? 0;
}

// `mergeAPIServerUrl` removed: superseded by `mergeAPIDeployment` in
// `src/graph/mutations/api-deployment.ts`. POC mode in-place rename of the
// underlying node label from `:PhysicalResource` to `:APIDeployment` with
// richer parsed properties (scheme/host/port/basePath/environment/visibility).

// ─── Code-Inferred API Interfaces (no OpenAPI spec) ──────────────────────────

/**
 * MERGE a synthetic APIInterface for a service that exposes endpoints via code
 * (e.g. NestJS controllers, Slim routes) with no accompanying OpenAPI spec.
 *
 * Creates: (Service)-[:EXPOSES_API]->(APIInterface {source:'code'})
 *
 * Returns the deterministic URN for linking code-exposed endpoints.
 */
export async function mergeCodeInferredAPIInterface(qualifiedRepoName: string, serviceName: string, commitHash: string): Promise<string> {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    const apiUrn = buildUrn('api', 'code-inferred', qualifiedRepoName, serviceName);
    // direction INBOUND: code-inferred APIs come from route declarations
    // (Slim, Express, NestJS controllers) which are by definition exposed.
    // Grounding: ast/exact — route declarations are AST-derived.
    const prov = astGrounding('code-route-extractor@v1');
    await run(
        `MERGE (api:APIInterface {id: $apiUrn})
     ON CREATE SET api.valid_from_commit = $commitHash, api.valid_to_commit = null, api.title = $title, api.apiSource = 'code', api.version = 'code-inferred', api.direction = 'INBOUND', api.createdAt = timestamp()
     ON MATCH SET api.valid_from_commit = coalesce(api.valid_from_commit, $commitHash), api.valid_to_commit = null, api.apiSource = 'code', api.direction = coalesce(api.direction, 'INBOUND')
     ${groundingWriteClause('api')}
     WITH api
     MATCH (s:Service {id: $sUrn})
     MERGE (s)-[rel:EXPOSES_API]->(api)`,
        { apiUrn, sUrn, title: `${serviceName} (Code-Inferred)`, commitHash, ...groundingParams(prov, commitHash) },
    );
    return apiUrn;
}

/**
 * MERGE an APIEndpoint node exposed by code (not OpenAPI).
 * Links the endpoint to its synthetic APIInterface via [:HAS_ENDPOINT].
 * Links the implementing function via [:IMPLEMENTS_ENDPOINT].
 *
 * Returns the deterministic endpoint URN.
 */
export async function mergeCodeExposedEndpoint(
    apiUrn: string,
    method: HttpMethod,
    path: string,
    functionId: string,
    commitHash: string,
    /** Optional framework metadata (e.g. 'nextjs-app-router'). Additive — never overwrites existing. */
    framework?: string,
): Promise<string> {
    const normalizedMethod = method.toUpperCase();
    const endpointUrn = buildUrn('endpoint', 'code', normalizedMethod, path);
    // Code-exposed endpoints come from deterministic route-extractor AST walks
    // (ast/exact) — except legacy-php filesystem routes, where the URL and the
    // methods are a signal-based convention guess, not an AST-read route string.
    const prov = framework === 'legacy-php'
        ? heuristicGrounding('code-route-extractor@v1')
        : astGrounding('code-route-extractor@v1');
    await run(
        `MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null, ep.name = $path, ep.path = $path, ep.method = $normalizedMethod, ep.apiKind = 'rest', ep.summary = 'Code-inferred', ep.epSource = 'code', ep.createdAt = timestamp(), ep.framework = $framework
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash), ep.valid_to_commit = null, ep.name = $path, ep.path = $path, ep.method = $normalizedMethod, ep.apiKind = 'rest', ep.epSource = 'code', ep.framework = coalesce($framework, ep.framework)
     ${groundingWriteClause('ep')}
     WITH ep
     MATCH (api:APIInterface {id: $apiUrn})
     MERGE (api)-[rel:HAS_ENDPOINT]->(ep)
     WITH ep
     MATCH (f:Function {id: $functionId})
     MERGE (f)-[rel:IMPLEMENTS_ENDPOINT]->(ep)`,
        { endpointUrn, path, normalizedMethod, apiUrn, functionId, commitHash, framework: framework ?? null, ...groundingParams(prov, commitHash) },
    );
    return endpointUrn;
}

// ─── GraphQL Endpoints (Model B: SDL + Code-Inferred + Emergent) ──────────────────────────────

/**
 * MERGE a GraphQL operation endpoint discovered from an SDL file (.graphql / .gql).
 * This is the SDL ground-truth node. It does NOT link to a Function — SDL
 * describes the contract, not the implementation.
 *
 * URN: cr:endpoint:graphql:{apiUrn}:{operation}:{operationName}
 * source: 'sdl' | method: null (GQL operations do not map to HTTP verbs)
 *
 * Note: method is explicitly set to null for all GQL operations — Memgraph removes
 * null properties, but we force-set it for clarity.
 */
export async function mergeSDLGraphQLEndpoint(
    apiUrn: string,
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION',
    operationName: string,
    commitHash: string,
    framework?: string,
): Promise<string> {
    const endpointUrn = buildUrn('endpoint', 'graphql', apiUrn, operation, operationName);
    const name = operationName;
    const path = '/graphql';
    const prov = astGrounding('graphql-sdl-extractor@v1');
    await run(
        `MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null,
                   ep.name = $name, ep.path = $path, ep.method = null, ep.operation = $operation,
                   ep.operationName = $operationName, ep.epSource = 'sdl', ep.apiKind = 'graphql',
                   ep.framework = $framework, ep.createdAt = timestamp()
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash),
                  ep.valid_to_commit = null, ep.name = $name, ep.path = $path, ep.method = null,
                  ep.operation = $operation, ep.operationName = $operationName,
                  ep.epSource = 'sdl', ep.apiKind = 'graphql',
                  ep.framework = coalesce($framework, ep.framework)
     ${groundingWriteClause('ep')}
     WITH ep
     MATCH (api:APIInterface {id: $apiUrn})
     MERGE (api)-[rel:HAS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { endpointUrn, name, path, operation, operationName, apiUrn, commitHash, framework: framework ?? null, ...groundingParams(prov, commitHash) },
    );
    return endpointUrn;
}

/**
 * MERGE a GraphQL operation endpoint inferred from code analysis (LLM or static).
 * Links the endpoint to its APIInterface AND to the implementing Function.
 *
 * URN: cr:endpoint:graphql-code:{apiUrn}:{operation}:{operationName}
 * source: 'code'
 *
 * After rewireGraphQLCodeToSDL runs, this node will be tombstoned (valid_to_commit set)
 * and its IMPLEMENTS_ENDPOINT edge will be rewired to the SDL node.
 */
export async function mergeCodeInferredGraphQLEndpoint(
    apiUrn: string,
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION',
    operationName: string,
    functionId: string,
    commitHash: string,
    framework?: string,
): Promise<string> {
    const endpointUrn = buildUrn('endpoint', 'graphql-code', apiUrn, operation, operationName);
    const name = operationName;
    const path = '/graphql';
    const prov = astGrounding('graphql-code-extractor@v1');
    await run(
        `MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null,
                   ep.name = $name, ep.path = $path, ep.method = null, ep.operation = $operation,
                   ep.operationName = $operationName, ep.epSource = 'code', ep.apiKind = 'graphql',
                   ep.framework = $framework, ep.createdAt = timestamp()
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash),
                  ep.valid_to_commit = null, ep.name = $name, ep.path = $path, ep.method = null,
                  ep.epSource = 'code', ep.apiKind = 'graphql',
                  ep.framework = coalesce($framework, ep.framework)
     ${groundingWriteClause('ep')}
     WITH ep
     MATCH (api:APIInterface {id: $apiUrn})
     MERGE (api)-[rel:HAS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null
     WITH ep
     MATCH (f:Function {id: $functionId})
     MERGE (f)-[rel:IMPLEMENTS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { endpointUrn, name, path, operation, operationName, apiUrn, functionId, commitHash, framework: framework ?? null, ...groundingParams(prov, commitHash) },
    );
    return endpointUrn;
}

/**
 * MERGE the outbound-GraphQL APIInterface that anchors emergent endpoints
 * produced by a single caller service. One APIInterface per
 * (callerService × documentName) — keeps endpoints grouped by the document
 * they were lifted from, which makes downstream welding deterministic.
 *
 * Creates: (Service)-[:CONSUMES_API]->(APIInterface{
 *     direction: 'OUTBOUND', apiKind: 'graphql', apiSource: 'emergent'
 * })
 *
 * Returns the deterministic APIInterface URN. The endpoint merge below uses
 * this URN as the HAS_ENDPOINT parent.
 */
export async function mergeEmergentGraphQLConsumedAPIInterface(
    callerServiceUrn: string,
    documentName: string | undefined,
    commitHash: string,
    grounding?: GroundingFields,
): Promise<string> {
    const docSlug = documentName && documentName.trim() ? documentName.trim() : '_unnamed';
    const apiUrn = buildUrn('api', 'emergent-graphql', callerServiceUrn, docSlug);
    await run(
        `MERGE (api:APIInterface {id: $apiUrn})
     ON CREATE SET api.valid_from_commit = $commitHash, api.valid_to_commit = null,
                   api.title = $title, api.apiSource = 'emergent', api.apiKind = 'graphql',
                   api.direction = 'OUTBOUND', api.documentName = $documentName,
                   api.createdAt = timestamp()
     ON MATCH SET api.valid_from_commit = coalesce(api.valid_from_commit, $commitHash),
                  api.valid_to_commit = null, api.apiSource = 'emergent', api.apiKind = 'graphql',
                  api.direction = 'OUTBOUND'
     ${groundingWriteClause('api')}
     WITH api
     MATCH (s:Service {id: $callerServiceUrn})
     MERGE (s)-[rel:CONSUMES_API]->(api)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH  SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                   rel.valid_to_commit = null`,
        {
            apiUrn,
            callerServiceUrn,
            documentName: documentName ?? null,
            title: documentName ? `${docSlug} (emergent GraphQL outbound)` : 'Emergent GraphQL outbound',
            commitHash,
            ...groundingParams(grounding, commitHash),
        },
    );
    return apiUrn;
}

/**
 * MERGE an emergent GraphQL endpoint: an outbound GraphQL call detected by the LLM.
 * Attached to its parent APIInterface (the per-caller outbound API created by
 * `mergeEmergentGraphQLConsumedAPIInterface`) via HAS_ENDPOINT.
 *
 * URN: cr:endpoint:emergent-graphql:{apiUrn}:{operation}:{operationName}
 * source: 'emergent'
 */
export async function mergeEmergentGraphQLEndpoint(
    apiUrn: string,
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION',
    operationName: string,
    commitHash: string,
    documentName?: string,
    grounding?: GroundingFields,
): Promise<string> {
    const endpointUrn = buildUrn('endpoint', 'emergent-graphql', apiUrn, operation, operationName);
    const name = operationName;
    const path = '/graphql';
    await run(
        `MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null,
                   ep.name = $name, ep.path = $path, ep.method = null, ep.operation = $operation,
                   ep.operationName = $operationName, ep.epSource = 'emergent', ep.apiKind = 'graphql',
                   ep.documentName = $documentName, ep.createdAt = timestamp()
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash),
                  ep.valid_to_commit = null, ep.name = $name, ep.path = $path, ep.method = null,
                  ep.documentName = coalesce(ep.documentName, $documentName)
     ${groundingWriteClause('ep')}
     WITH ep
     MATCH (api:APIInterface {id: $apiUrn})
     MERGE (api)-[rel:HAS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH  SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                   rel.valid_to_commit = null`,
        { endpointUrn, name, path, operation, operationName, apiUrn, commitHash, documentName: documentName ?? null, ...groundingParams(grounding, commitHash) },
    );
    return endpointUrn;
}

/**
 * L0-GQL rewire: for every code-inferred GraphQL endpoint on a service that has
 * a matching SDL twin, rewire all IMPLEMENTS_ENDPOINT edges from code-ep to SDL-ep,
 * then tombstone the code-ep so it no longer appears in candidate sets.
 *
 * Returns the number of rewired functions.
 *
 * Safety: code-ep nodes WITHOUT an SDL twin are NOT tombstoned (their MATCH on
 * sdlEp simply doesn't find a row), remaining as sole sources of truth.
 *
 * Fix (1D): code-inferred and SDL endpoints live under DIFFERENT APIInterface nodes
 * (cr:api:code-inferred:... vs cr:api:...:graphql-sdl). The original query searched
 * for both under the same (api) node — it was structurally dead (always 0 rows).
 * The fixed query joins code-ep and SDL-ep via the owning Service, not a shared api node.
 *
 * Note on filter strategy: we filter by ep.apiKind + ep.epSource rather than
 * parsing ep.id with STARTS WITH. Reason: AD-5 (URN opacity) — Cypher business
 * logic must not depend on the internal structure of URN strings.
 * ep.apiKind='graphql' and ep.epSource='code'/'sdl' are the canonical
 * discriminants written by their respective merge functions and survive any
 * future URN refactoring. (The `source` property holds the grounding tier —
 * 'ast'/'llm'/'composite' — and is not a domain discriminator.)
 */
export async function rewireGraphQLCodeToSDL(serviceUrn: string, commitHash: string): Promise<number> {
    const result = await run(
        `// Find code-inferred GQL endpoints for this service (epSource='code', apiKind='graphql')
         MATCH (s:Service {id: $serviceUrn})-[:EXPOSES_API]->(codeApi:APIInterface)
               -[:HAS_ENDPOINT]->(codeEp:APIEndpoint)
         WHERE codeEp.apiKind = 'graphql' AND codeEp.epSource = 'code'
           AND codeEp.valid_to_commit IS NULL
         // Find the SDL twin via the same service — cross-interface join on operation + operationName
         MATCH (s)-[:EXPOSES_API]->(sdlApi:APIInterface)
               -[:HAS_ENDPOINT]->(sdlEp:APIEndpoint)
         WHERE sdlEp.apiKind = 'graphql' AND sdlEp.epSource = 'sdl'
           AND sdlEp.valid_to_commit IS NULL
           AND sdlEp.operation     = codeEp.operation
           AND sdlEp.operationName = codeEp.operationName
         // Rewire any IMPLEMENTS_ENDPOINT edges from code-ep to SDL-ep
         OPTIONAL MATCH (f:Function)-[oldRel:IMPLEMENTS_ENDPOINT]->(codeEp)
         FOREACH (_ IN CASE WHEN f IS NOT NULL THEN [1] ELSE [] END |
             MERGE (f)-[newRel:IMPLEMENTS_ENDPOINT]->(sdlEp)
             ON CREATE SET newRel.valid_from_commit = $commitHash, newRel.valid_to_commit = null,
                           newRel.rewired_from_code = true
             ON MATCH  SET newRel.valid_to_commit = null, newRel.rewired_from_code = true
         )
         FOREACH (_ IN CASE WHEN f IS NOT NULL THEN [1] ELSE [] END |
             DELETE oldRel
         )
         SET codeEp.valid_to_commit = $commitHash
         RETURN count(DISTINCT codeEp) AS tombstoned`,
        { serviceUrn, commitHash },
    );
    const rec = result.records[0];
    return rec ? (rec.get('tombstoned') as number) : 0;
}

/**
 * Return all live SDL GraphQL endpoint IDs for a given APIInterface URN.
 * Used by the mark-and-sweep lifecycle to find stale SDL operations.
 *
 * Filter: ep.epSource = 'sdl' AND ep.apiKind = 'graphql' (AD-5: do not parse URN strings).
 * The (api:APIInterface {id: $apiUrn}) anchor already scopes to the SDL interface;
 * epSource+apiKind are defense-in-depth.
 */
export async function getExistingSDLGraphQLEndpointIds(apiUrn: string): Promise<string[]> {
    const result = await run(
        `MATCH (api:APIInterface {id: $apiUrn})-[:HAS_ENDPOINT]->(ep:APIEndpoint)
     WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
       AND ep.valid_to_commit IS NULL
     RETURN ep.id AS id`,
        { apiUrn },
    );
    return result.records.map(r => r.get('id') as string);
}

/**
 * Tombstone stale SDL GraphQL endpoint IDs (those no longer in the schema).
 * Only SDL nodes (epSource='sdl', apiKind='graphql') are touched, code and
 * emergent nodes are outside the SDL lifecycle.
 *
 * The $urns list comes from getExistingSDLGraphQLEndpointIds which already
 * scopes to SDL endpoints; the epSource+apiKind guard here is defense-in-depth
 * (AD-5: do not rely solely on URN string parsing for business logic).
 */
export async function markGraphQLEndpointsStale(urns: string[], commitHash: string): Promise<void> {
    if (urns.length === 0) return;
    await run(
        `UNWIND $urns AS urnVal
     MATCH (ep:APIEndpoint {id: urnVal})
     WHERE ep.epSource = 'sdl' AND ep.apiKind = 'graphql'
       AND ep.valid_to_commit IS NULL
     SET ep.valid_to_commit = $commitHash`,
        { urns, commitHash },
    );
}

// ─── Emergent API Endpoints (from LLM-inferred HTTP calls) ───────────────────

/**
 * MERGE an APIEndpoint node discovered by the LLM from source code analysis.
 * These are "emergent" endpoints — not from OpenAPI specs but inferred from
 * actual HTTP calls (e.g. axios.post('/api/users/{id}')).
 *
 * Returns the deterministic URN for linking.
 */
export async function mergeEmergentAPIEndpoint(method: HttpMethod, path: string, rawPath: string | undefined, commitHash: string, grounding?: GroundingFields): Promise<string> {
    const normalizedMethod = method.toUpperCase();
    const endpointUrn = buildUrn('endpoint', 'emergent', normalizedMethod, path);
    await run(
        `MERGE (ep:APIEndpoint {id: $endpointUrn})
     ON CREATE SET ep.valid_from_commit = $commitHash, ep.valid_to_commit = null, ep.name = $path, ep.path = $path, ep.method = $normalizedMethod, ep.apiKind = 'rest', ep.summary = 'LLM-inferred', ep.rawPath = $rawPath, ep.epSource = 'emergent', ep.createdAt = timestamp()
     ON MATCH SET ep.valid_from_commit = coalesce(ep.valid_from_commit, $commitHash), ep.valid_to_commit = null, ep.name = $path, ep.path = $path, ep.method = $normalizedMethod, ep.apiKind = 'rest', ep.rawPath = coalesce($rawPath, ep.rawPath), ep.epSource = 'emergent'
     ${groundingWriteClause('ep')}`,
        { endpointUrn, path, normalizedMethod, rawPath: rawPath ?? null, commitHash, ...groundingParams(grounding, commitHash) },
    );
    return endpointUrn;
}

export interface LinkFunctionCallsEndpointOptions {
    /**
     * Caller-side base URL resolved from env-var at the call site (e.g.
     * `https://payment.acme.com/v2` from `process.env.PAYMENT_URL`). Used by
     * the global resolver's L0a URL-exact welder to match the call against a
     * provider `:APIDeployment.canonicalUrl`.
     */
    observedBaseUrl?: string;
    /**
     * Environment the observed base URL was sourced from: `'production'`,
     * `'staging'`, `'dev'`, `'local'`, `'unknown'`. Derived from the source
     * file name (`.env.production` → `production`, `helm/values-prod.yaml` →
     * `production`).
     */
    observedEnvironment?: string;
    /**
     * Provenance label: `'env-var'`, `'ast-literal'`, `'config-template'`,
     * `'llm'`. Tells downstream consumers how the URL was discovered.
     */
    declaredBy?: string;
}

/**
 * Link a Function to an APIEndpoint via [:CALLS].
 * Represents: "this function makes an HTTP call to this endpoint".
 *
 * Optional caller-side properties (observedBaseUrl, observedEnvironment,
 * declaredBy) feed the URL-match welder in `global-resolver.ts` (Fix #5 L0a).
 */
export async function linkFunctionCallsEndpoint(
    functionId: string,
    endpointUrn: string,
    commitHash: string,
    opts: LinkFunctionCallsEndpointOptions = {},
): Promise<void> {
    await run(
        `MATCH (f:Function {id: $functionId}), (ep:APIEndpoint {id: $endpointUrn})
     MERGE (f)-[rel:CALLS]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                   rel.observedBaseUrl = $observedBaseUrl,
                   rel.observedEnvironment = $observedEnvironment,
                   rel.declaredBy = $declaredBy
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                  rel.valid_to_commit = null,
                  rel.observedBaseUrl = coalesce($observedBaseUrl, rel.observedBaseUrl),
                  rel.observedEnvironment = coalesce($observedEnvironment, rel.observedEnvironment),
                  rel.declaredBy = coalesce($declaredBy, rel.declaredBy)`,
        {
            functionId, endpointUrn, commitHash,
            observedBaseUrl: opts.observedBaseUrl ?? null,
            observedEnvironment: opts.observedEnvironment ?? null,
            declaredBy: opts.declaredBy ?? null,
        },
    );
}

/**
 * L0 Direct Wire — OpenAPI Source of Truth
 *
 * For each (Function)-[:IMPLEMENTS_ENDPOINT]->(code-inferred APIEndpoint) edge
 * where a canonical OpenAPI endpoint exists with the same method+path, re-wire
 * IMPLEMENTS_ENDPOINT to point directly to the OpenAPI node.
 *
 * Uses MERGE (not CREATE) to guarantee idempotence across ingestion runs:
 *   - If the wire-to-OpenAPI edge already exists → ON MATCH updates valid_to_commit
 *   - If not → ON CREATE copies valid_from_commit from old edge via properties()
 *   - Deletes the stale wire-to-code-inferred edge in both cases
 *
 * OpenAPI endpoints are identified by `source = 'openapi'` property (not URN prefix).
 * Code-inferred endpoints are identified by `source = 'code'`.
 *
 * Returns the count of re-wired function→endpoint edges.
 */
export async function rewireImplementsEdgesToOpenApi(
    serviceUrn: string,
    commitHash: string,
): Promise<number> {
    // Multi-tenant safety: the (s:Service {id: $serviceUrn}) anchor is REQUIRED
    // on every side, INCLUDING the IMPLEMENTS_ENDPOINT lookup via [:CONTAINS]→(f).
    // Two services in different industry domains can legitimately expose the same
    // path (e.g. /health, /api/users); furthermore, code-inferred APIEndpoint URNs
    // are NOT service-scoped (cr:endpoint:code:METHOD:PATH), so the same node may
    // be reachable from multiple services. Without the (s)-[:CONTAINS]->(f) anchor
    // we would re-point f's IMPLEMENTS_ENDPOINT edge to OTHER services' OpenAPI
    // endpoints. Do not relax this without introducing alternative isolation.
    //
    // We also tombstone codeEp only when at least one function owned by THIS
    // service was rewired, otherwise the shared codeEp may still be in use by
    // another service. The rewire is then a no-op for the current service.
    //
    // Path comparison is RAW. Producers must canonicalize at write time
    // (normalizeApiPathLossless on both code-pipeline and openapi-extractor).
    const result = await run(
        `MATCH (s:Service {id: $serviceUrn})-[:EXPOSES_API]->(openApi:APIInterface)
              -[:HAS_ENDPOINT]->(openEp:APIEndpoint)
         WHERE openApi.apiSource = 'openapi'
           AND openEp.valid_to_commit IS NULL
         MATCH (s)-[:EXPOSES_API]->(codeApi:APIInterface)
              -[:HAS_ENDPOINT]->(codeEp:APIEndpoint)
         WHERE codeApi.apiSource = 'code'
           AND codeEp.valid_to_commit IS NULL
           AND toUpper(openEp.method) = toUpper(codeEp.method)
           AND openEp.path = codeEp.path
         OPTIONAL MATCH (s)-[:CONTAINS]->(f:Function)-[oldRel:IMPLEMENTS_ENDPOINT]->(codeEp)
         FOREACH (_ IN CASE WHEN f IS NOT NULL THEN [1] ELSE [] END |
             MERGE (f)-[newRel:IMPLEMENTS_ENDPOINT]->(openEp)
             ON CREATE SET newRel = properties(oldRel), newRel.rewired = true
             ON MATCH SET newRel.valid_to_commit = null, newRel.rewired = true
         )
         FOREACH (_ IN CASE WHEN f IS NOT NULL THEN [1] ELSE [] END |
             DELETE oldRel
         )
         WITH s, codeApi, codeEp, count(f) AS rewiredCount
         // Tombstone codeEp only if no other service still has IMPLEMENTS_ENDPOINT
         // edges to it. The HAS_ENDPOINT edge from THIS service's codeApi is severed
         // unconditionally — codeApi owns the relationship, not the node.
         OPTIONAL MATCH (otherF:Function)-[otherImpl:IMPLEMENTS_ENDPOINT]->(codeEp)
         WHERE otherImpl.valid_to_commit IS NULL
         WITH codeEp, rewiredCount, count(otherF) AS otherImplementers
         FOREACH (_ IN CASE WHEN otherImplementers = 0 THEN [1] ELSE [] END |
             SET codeEp.valid_to_commit = $commitHash
         )
         RETURN sum(rewiredCount) AS rewired`,
        { serviceUrn, commitHash },
    );
    const record = result.records[0];
    return record ? Number(record.get('rewired')) : 0;
}

export async function linkFunctionImplementsEndpoint(functionUrn: string, endpointUrn: string, commitHash: string) {
    await run(
        `MATCH (f:Function {id: $functionUrn}), (ep:APIEndpoint {id: $endpointUrn})
     MERGE (f)-[rel:IMPLEMENTS_ENDPOINT]->(ep)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null`,
        { functionUrn, endpointUrn , commitHash },
    );
}

// ─── OAS Reconciliation (Mark & Sweep) ───────────────────────────────────────

/**
 * Load existing APIEndpoint IDs linked to a specific APIInterface.
 * Used for scoped reconciliation — only returns endpoints in this spec's scope.
 */
export async function getExistingEndpointIds(apiUrn: string): Promise<string[]> {
    const result = await run(
        `MATCH (api:APIInterface {id: $apiUrn})-[:HAS_ENDPOINT]->(ep:APIEndpoint)
     RETURN ep.id AS id`,
        { apiUrn , commitHash },
    );
    return result.records.map(r => r.get('id') as string);
}

// `getExistingServerUrlIds` removed: superseded by `getExistingAPIDeploymentIds`
// in `src/graph/mutations/api-deployment.ts`.

/**
 * Delete stale API-related nodes (APIEndpoint or APIDeployment) by their IDs.
 * Uses DETACH DELETE to remove all relationships.
 */
export async function deleteStaleAPINodes(staleIds: string[]): Promise<void> {
    if (staleIds.length === 0) return;
    await run(
        `UNWIND $staleIds AS staleId
         MATCH (n {id: staleId})
         DETACH DELETE n`,
        { staleIds , commitHash },
    );
}

// ─── API Role Reclassification (Code-Endpoint Overlap) ───────────────────────

/**
 * Post-hoc reclassification of consumed API specs.
 *
 * After the Matchmaker creates IMPLEMENTS_ENDPOINT edges from Functions to
 * APIEndpoints, this step inspects every (Service)-[:EXPOSES_API]->(APIInterface)
 * relationship. If NONE of the APIInterface's endpoints is implemented by a
 * function THIS service owns via a genuine code→contract rewire, the spec is
 * reclassified as CONSUMED (the service references these endpoints — e.g. it
 * vendored a provider's OpenAPI copy under an infrastructure/client-adapter dir
 * to call it — but does not serve them).
 *
 * The "genuine implementation" signal is the rewire flag, NOT the bare presence
 * of an IMPLEMENTS_ENDPOINT edge:
 *   - `rewired = true`           — REST: a static code route matched the spec
 *                                  endpoint and was rewired onto it by
 *                                  rewireImplementsEdgesToOpenApi.
 *   - `rewired_from_code = true` — GraphQL: a code resolver was rewired onto the
 *                                  SDL endpoint by rewireGraphQLCodeToSDL.
 * Matchmaker-fuzzy IMPLEMENTS edges (a caller mis-bound as an implementer) and
 * cross-service route-handler bleed (path-only matches landing on another
 * service's vendored copy) carry NEITHER flag and are excluded. The same-service
 * `(s)-[:CONTAINS]->(f)` anchor additionally rejects cross-service bleed.
 *
 * Guard condition: reclassification only fires for services that have at least
 * ONE IMPLEMENTS_ENDPOINT edge anywhere (proving the code analysis pipeline
 * successfully extracted route handlers). Without this guard, services where
 * code analysis failed entirely would have ALL their specs wrongly reclassified.
 *
 * ponytail: ceiling — a provider whose framework has NO static route extractor
 * (so its own spec is only matchmaker-bound, never rewired) would be wrongly
 * reclassified as a consumer of its own API. Acceptable for now (all shipped
 * language plugins extract routes); upgrade path = add a server-URL/host signal
 * if such a provider appears.
 *
 * Returns the list of reclassified APIs for logging/reporting.
 */
export async function reclassifyConsumedAPIs(
    commitHash: string,
): Promise<Array<{ service: string; apiTitle: string; apiUrn: string }>> {
    // Step 1: Find services that have at least one IMPLEMENTS_ENDPOINT edge
    //         (guard: proves code analysis pipeline worked for this service).
    const guardResult = await run(
        `MATCH (s:Service)-[:EXPOSES_API]->(:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
             <-[:IMPLEMENTS_ENDPOINT]-(:Function)
         WHERE s.valid_to_commit IS NULL
           AND ep.valid_to_commit IS NULL
         RETURN DISTINCT s.id AS serviceUrn`,
    );
    const eligibleServices = new Set(
        guardResult.records.map(r => r.get('serviceUrn') as string),
    );

    if (eligibleServices.size === 0) {
        return [];
    }

    // Step 2: For each eligible service, find OpenAPI-sourced APIInterfaces
    //         where ZERO endpoints are genuinely implemented by THIS service
    //         (a same-service function rewired from a static code route / resolver).
    //         These are consumed specs (vendored provider copies, partner APIs).
    const reclassified: Array<{ service: string; apiTitle: string; apiUrn: string }> = [];

    for (const serviceUrn of eligibleServices) {
        const result = await run(
            `MATCH (s:Service {id: $serviceUrn})-[exposed:EXPOSES_API]->(api:APIInterface)
             WHERE api.valid_to_commit IS NULL
               AND (api.apiSource IS NULL OR api.apiSource <> 'code')
             OPTIONAL MATCH (s)-[:CONTAINS]->(f:Function)-[impl:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
                            <-[:HAS_ENDPOINT]-(api)
             WHERE ep.valid_to_commit IS NULL
               AND impl.valid_to_commit IS NULL
               AND (impl.rewired = true OR impl.rewired_from_code = true)
             WITH s, api, exposed, count(DISTINCT ep) AS implementedCount
             WHERE implementedCount = 0
             DELETE exposed
             CREATE (s)-[consumed:CONSUMES_API]->(api)
             SET consumed.valid_from_commit = $commitHash,
                 consumed.valid_to_commit = null,
                 consumed.reclassified = true,
                 consumed.reclassifiedAt = timestamp(),
                 api.direction = 'OUTBOUND'
             RETURN s.name AS service, api.title AS apiTitle, api.id AS apiUrn`,
            { serviceUrn, commitHash },
        );

        for (const rec of result.records) {
            reclassified.push({
                service: rec.get('service') as string,
                apiTitle: rec.get('apiTitle') as string,
                apiUrn: rec.get('apiUrn') as string,
            });
        }
    }

    return reclassified;
}

// ─── Global Edge Resolver Queries ────────────────────────────────────────────

/**
 * Fetch all emergent (LLM-inferred) API endpoints from the graph.
 * These are endpoints discovered from HTTP calls in source code,
 * identified by their `cr:endpoint:emergent:` prefix.
 */
export async function getEmergentEndpoints(): Promise<Array<{ id: string; method: string | null; path: string }>> {
    const emergentPrefix = urnPrefix('endpoint', 'emergent');
    const gqlPrefix    = urnPrefix('endpoint', 'emergent-graphql');
    const result = await run(
        `MATCH (ep:APIEndpoint)
     WHERE (ep.id STARTS WITH $emergentPrefix OR ep.id STARTS WITH $gqlPrefix)
       AND ep.valid_to_commit IS NULL
     RETURN ep.id AS id, ep.method AS method, ep.path AS path`,
        { emergentPrefix, gqlPrefix },
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        method: r.get('method') as string | null,
        path: r.get('path') as string,
    }));
}

/**
 * Fetch all canonical (OpenAPI-sourced AND code-inferred) API endpoints from the graph.
 * These include:
 *   - Endpoints defined in OpenAPI specs (source: 'openapi' or unset), linked via
 *     (APIInterface)-[:HAS_ENDPOINT]->(APIEndpoint)
 *   - Endpoints inferred from code analysis (source: 'code'), linked the same way
 *     via a synthetic code-inferred APIInterface node.
 */
export async function getCanonicalEndpoints(): Promise<Array<{
    id: string;
    method: string | null;
    path: string;
    apiTitle: string | null;
    apiKind: string | null;
    operation: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION' | null;
    operationName: string | null;
}>> {
    const result = await run(
        `MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
     WHERE ep.valid_to_commit IS NULL
     RETURN ep.id AS id, ep.method AS method, ep.path AS path,
            api.title AS apiTitle, ep.apiKind AS apiKind,
            ep.operation AS operation, ep.operationName AS operationName`,
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        method: r.get('method') as string | null,
        path: r.get('path') as string,
        apiTitle: r.get('apiTitle') as string | null,
        apiKind: r.get('apiKind') as string | null,
        operation: r.get('operation') as 'QUERY' | 'MUTATION' | 'SUBSCRIPTION' | null,
        operationName: r.get('operationName') as string | null,
    }));
}

/**
 * Weld an emergent endpoint into its canonical counterpart.
 *
 * Steps:
 *   1. Move inbound [:CALLS] edges from emergent → canonical.
 *   1b. Carry over documentName (GraphQL outbound metadata).
 *   1c. Rewire CONSUMES_API: for every service that consumes the emergent's
 *       parent APIInterface (the per-caller outbound :APIInterface produced
 *       by `mergeEmergentGraphQLConsumedAPIInterface`), make sure they also
 *       consume the canonical's parent APIInterface (the provider SDL).
 *   2. Delete the orphaned emergent endpoint if no [:CALLS] edges remain.
 *   3. Tombstone the emergent APIInterface if it has no remaining endpoints
 *      (clean-up after the last endpoint welded over).
 */
export interface WeldEmergentToCanonicalOptions {
    /**
     * Welding tier that produced the match. Persisted on the canonical CALLS
     * edge as `weldedBy` for provenance: `'url-exact'`, `'url-host'`,
     * `'label'`, `'scoped'`, `'template'`, `'llm'`.
     */
    weldedBy?: 'url-exact' | 'url-host' | 'label' | 'scoped' | 'template' | 'llm' | 'duplicate';
    /**
     * Confidence tier for the weld: `'exact'` (URL match), `'high'` (host+path),
     * `'medium'` (label / DEPENDS_ON scoped), `'low'` (LLM / template).
     */
    weldConfidence?: 'exact' | 'high' | 'medium' | 'low';
    /** Commit hash to stamp on the new edges. Defaults to module-level `commitHash` constant ('SYSTEM'). */
    commitHash?: string;
}

export async function weldEmergentToCanonical(
    emergentId: string,
    canonicalId: string,
    opts: WeldEmergentToCanonicalOptions = {},
): Promise<void> {
    const weldedBy = opts.weldedBy ?? null;
    const weldConfidence = opts.weldConfidence ?? null;
    const weldCommit = opts.commitHash ?? commitHash;
    // Step 1: Move inbound CALLS edges from emergent → canonical.
    // PRESERVE the edge properties of the original (observedBaseUrl, observedEnvironment,
    // declaredBy, ...) via `SET rel += properties(r)`. The carry-over runs BEFORE the
    // explicit set of valid_* / weldedBy / weldConfidence so those win over any stale
    // values the emergent edge might have carried.
    await run(
        `MATCH (f:Function)-[r:CALLS]->(ep_em:APIEndpoint {id: $emergentId})
     MATCH (ep_can:APIEndpoint {id: $canonicalId})
     MERGE (f)-[rel:CALLS]->(ep_can)
     ON CREATE SET rel += properties(r),
                   rel.valid_from_commit = $weldCommit,
                   rel.valid_to_commit = null,
                   rel.weldedBy = $weldedBy,
                   rel.weldConfidence = $weldConfidence
     ON MATCH  SET rel += properties(r),
                   rel.valid_from_commit = coalesce(rel.valid_from_commit, $weldCommit),
                   rel.valid_to_commit = null,
                   rel.weldedBy = coalesce($weldedBy, rel.weldedBy),
                   rel.weldConfidence = coalesce($weldConfidence, rel.weldConfidence)
     WITH r
     DELETE r`,
        { emergentId, canonicalId, weldCommit, weldedBy, weldConfidence },
    );
    // Step 1b: Carry over documentName from emergent → canonical (GQL outbound metadata).
    // The emergent node stores the GraphQL document operation name (e.g. "GetOrderById")
    // which would be lost when the node is deleted. Preserve it on the canonical node
    // so blast-radius queries can surface which document names reference a given operation.
    await run(
        `MATCH (ep_em:APIEndpoint {id: $emergentId}), (ep_can:APIEndpoint {id: $canonicalId})
     WHERE ep_em.documentName IS NOT NULL
     SET ep_can.documentName = coalesce(ep_can.documentName, ep_em.documentName)`,
        { emergentId, canonicalId },
    );
    // Step 1c: Rewire service-level CONSUMES_API edges from the emergent's
    // parent APIInterface (the per-caller outbound :APIInterface) to the
    // canonical's parent APIInterface (the provider's SDL or OpenAPI). The
    // old CONSUMES_API edge to the emergent parent is left in place when
    // the emergent parent still has other endpoints; it is cleaned up in
    // Step 3 once the parent is empty.
    await run(
        `MATCH (emergentApi:APIInterface)-[:HAS_ENDPOINT]->(:APIEndpoint {id: $emergentId})
     MATCH (canonicalApi:APIInterface)-[:HAS_ENDPOINT]->(:APIEndpoint {id: $canonicalId})
     WITH DISTINCT emergentApi, canonicalApi
     WHERE emergentApi <> canonicalApi
     MATCH (callerSvc:Service)-[:CONSUMES_API]->(emergentApi)
     MERGE (callerSvc)-[newRel:CONSUMES_API]->(canonicalApi)
     ON CREATE SET newRel.valid_from_commit = $commitHash,
                   newRel.valid_to_commit = null,
                   newRel.welded_from = emergentApi.id
     ON MATCH SET newRel.valid_to_commit = null,
                  newRel.welded_from = coalesce(newRel.welded_from, emergentApi.id)`,
        { emergentId, canonicalId, commitHash },
    );
    // Step 2: Delete the orphaned emergent endpoint if no edges remain
    // (Memgraph does not support anonymous node patterns like `()-[:CALLS]->(ep_em)`)
    await run(
        `MATCH (ep_em:APIEndpoint {id: $emergentId})
     OPTIONAL MATCH (caller)-[:CALLS]->(ep_em)
     WITH ep_em, caller
     WHERE caller IS NULL
     DETACH DELETE ep_em`,
        { emergentId , commitHash },
    );
    // Step 3: Tombstone empty emergent :APIInterface nodes. After Step 2 the
    // welded endpoint is gone; if its parent emergent APIInterface has no
    // remaining HAS_ENDPOINT it is operational dead weight — detach delete
    // along with the now-orphan CONSUMES_API edges that hung off it.
    // Scoped to apiSource='emergent' so we never touch SDL/OpenAPI interfaces.
    await run(
        `MATCH (emergentApi:APIInterface)
     WHERE emergentApi.apiSource = 'emergent' AND emergentApi.apiKind = 'graphql'
     OPTIONAL MATCH (emergentApi)-[:HAS_ENDPOINT]->(any_ep:APIEndpoint)
     WITH emergentApi, count(any_ep) AS ep_count
     WHERE ep_count = 0
     DETACH DELETE emergentApi`,
        {},
    );
}

/**
 * Collapse duplicate EMERGENT REST endpoints that are the same logical endpoint
 * but landed as distinct nodes (literal ids, `${}`, varying param names →
 * distinct lossless-path URNs). Runs at the END of global resolution, after the
 * emergent→canonical welds have matched everything they can: only leftover
 * emergent endpoints with no OpenAPI/SDL counterpart remain to dedupe here.
 *
 * Grouping is `(method, canonicalizeApiPathForDedup(path))`; the survivor is the
 * most-templated path (see `groupEmergentDuplicates`). Each loser is welded into
 * the survivor with the SAME primitive used for emergent→canonical, so inbound
 * CALLS edges are preserved and the loser node is removed.
 *
 * Returns the number of endpoints collapsed (losers welded away).
 */
export async function weldDuplicateEmergentEndpoints(commitHash: string): Promise<number> {
    const res = await run(
        `MATCH (ep:APIEndpoint)
         WHERE ep.epSource = 'emergent' AND ep.apiKind = 'rest' AND ep.valid_to_commit IS NULL
         RETURN ep.id AS id, ep.method AS method, ep.path AS path`,
        {},
    );
    const rows: EmergentEndpointRow[] = res.records.map(r => ({
        id: r.get('id') as string,
        method: (r.get('method') as string) ?? '',
        path: (r.get('path') as string) ?? '',
    }));
    let welded = 0;
    for (const group of groupEmergentDuplicates(rows)) {
        for (const loserId of group.loserIds) {
            await weldEmergentToCanonical(loserId, group.survivorId, {
                weldedBy: 'duplicate',
                weldConfidence: 'high',
                commitHash,
            });
            welded++;
        }
    }
    return welded;
}

// ─── Cross-spec OpenAPI Weld ─────────────────────────────────────────────────

/**
 * Reconcile vendored OpenAPI specs across repos.
 *
 * Consumer repos commonly vendor a copy of a provider's OpenAPI spec (often
 * in two formats, .json AND .yml) under e.g. `infrastructure/{provider}/oas/`
 * to drive type generation. Each spec file produces a distinct APIInterface
 * (URN includes `relPath`), so the same logical route ends up with two or
 * more APIEndpoint nodes — one per spec file — with identical (method, path).
 *
 * After `reclassifyConsumedAPIs` has demoted the consumer-side APIInterface
 * to CONSUMES_API, this step welds each consumer-side APIEndpoint into the
 * authoritative one (the APIEndpoint owned by the EXPOSES_API APIInterface
 * for the same logical route). Inbound `[:CALLS]` edges are moved; the
 * consumer-side APIEndpoint is then tombstoned so subsequent queries see a
 * single canonical node.
 *
 * Multi-tenant safety:
 *   - The weld requires AT LEAST ONE service to currently EXPOSES_API the
 *     authoritative APIInterface — we never invent a canonical, never weld
 *     two CONSUMES_API together.
 *   - When multiple authoritative candidates exist (>1 EXPOSES_API service
 *     advertises the same path) the weld is SKIPPED for that route to avoid
 *     guessing which provider the consumer meant. These cases are reported
 *     in the result so they can be surfaced by the workflow.
 *
 * Returns counts of welded edges and skipped (ambiguous) routes.
 */
export interface OpenApiCrossSpecResult {
    weldedEdges: number;
    tombstonedEndpoints: number;
    ambiguousRoutes: Array<{ method: string; path: string; candidates: string[] }>;
}

export async function weldOpenApiAcrossSpecs(
    commitHash: string,
): Promise<OpenApiCrossSpecResult> {
    // Step 1: find unambiguous (consumerEp -> authoritativeEp) pairs.
    //   - consumerEp is on a CONSUMES_API APIInterface
    //   - authoritativeEp is on an EXPOSES_API APIInterface
    //   - exactly ONE authoritative candidate exists for the (method, path)
    const pairsResult = await run(
        `MATCH (consumerApi:APIInterface)-[:HAS_ENDPOINT]->(consumerEp:APIEndpoint)
         WHERE consumerApi.apiSource = 'openapi'
           AND consumerEp.epSource = 'openapi'
           AND consumerEp.valid_to_commit IS NULL
           AND EXISTS { MATCH (:Service)-[:CONSUMES_API]->(consumerApi) }
         MATCH (authApi:APIInterface)-[:HAS_ENDPOINT]->(authEp:APIEndpoint)
         WHERE authApi.apiSource = 'openapi'
           AND authEp.epSource = 'openapi'
           AND authEp.valid_to_commit IS NULL
           AND authEp.id <> consumerEp.id
           AND toUpper(authEp.method) = toUpper(consumerEp.method)
           AND authEp.path = consumerEp.path
           AND EXISTS { MATCH (:Service)-[:EXPOSES_API]->(authApi) }
         WITH consumerEp, collect(DISTINCT authEp) AS authCandidates
         RETURN consumerEp.id AS consumerId,
                consumerEp.method AS method,
                consumerEp.path AS path,
                [c IN authCandidates | c.id] AS candidateIds`,
    );

    const ambiguous: OpenApiCrossSpecResult['ambiguousRoutes'] = [];
    const unambiguous: Array<{ consumerId: string; authId: string }> = [];

    for (const rec of pairsResult.records) {
        const candidates = rec.get('candidateIds') as string[];
        const method = rec.get('method') as string;
        const path = rec.get('path') as string;
        const consumerId = rec.get('consumerId') as string;
        if (candidates.length === 1) {
            unambiguous.push({ consumerId, authId: candidates[0] });
        } else if (candidates.length > 1) {
            ambiguous.push({ method, path, candidates });
        }
    }

    let weldedEdges = 0;
    let tombstonedEndpoints = 0;

    for (const { consumerId, authId } of unambiguous) {
        // Move inbound CALLS edges. We do NOT delete the HAS_ENDPOINT edge from
        // the consumer's CONSUMES_API APIInterface — that link is part of the
        // consumer's contract picture, but we tombstone the endpoint node so
        // it stops competing with the authoritative one in matchmaking queries.
        const moveResult = await run(
            `MATCH (f:Function)-[r:CALLS]->(c:APIEndpoint {id: $consumerId})
             MATCH (a:APIEndpoint {id: $authId})
             MERGE (f)-[newRel:CALLS]->(a)
             ON CREATE SET newRel.valid_from_commit = $commitHash,
                           newRel.valid_to_commit = null,
                           newRel.welded_from_spec = true
             ON MATCH SET newRel.valid_to_commit = null,
                          newRel.welded_from_spec = true
             DELETE r
             RETURN count(f) AS moved`,
            { consumerId, authId, commitHash },
        );
        weldedEdges += Number(moveResult.records[0]?.get('moved') ?? 0);

        // Tombstone the consumer-side endpoint.
        await run(
            `MATCH (c:APIEndpoint {id: $consumerId})
             SET c.valid_to_commit = $commitHash,
                 c.welded_into = $authId`,
            { consumerId, authId, commitHash },
        );
        tombstonedEndpoints++;
    }

    return { weldedEdges, tombstonedEndpoints, ambiguousRoutes: ambiguous };
}

/**
 * Level 0 dependency-scoped resolution: for a given emergent endpoint,
 * trace back through the graph to find canonical endpoints exposed by
 * services that the calling service depends on.
 *
 * Traversal: EmergentEndpoint ← [:CALLS] ← Function ← [:CONTAINS] ← Service
 *            → [:DEPENDS_ON] → TargetService → [:EXPOSES_API] → APIInterface
 *            → [:HAS_ENDPOINT] → CanonicalEndpoint
 */
export async function getScopedCandidatesForEmergent(
    emergentId: string,
): Promise<Array<{ id: string; method: string | null; path: string; apiTitle: string | null }>> {
    const result = await run(
        `MATCH (ep_em:APIEndpoint {id: $emergentId})
     OPTIONAL MATCH (f:Function)-[:CALLS]->(ep_em)
     OPTIONAL MATCH (s:Service)-[:CONTAINS]->(f)
     OPTIONAL MATCH (s)-[:DEPENDS_ON]->(target:Service)
     OPTIONAL MATCH (target)-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep_can:APIEndpoint)
     WHERE ep_can IS NOT NULL
       AND ep_can.valid_to_commit IS NULL
     RETURN DISTINCT ep_can.id AS id, ep_can.method AS method, ep_can.path AS path, api.title AS apiTitle`,
        { emergentId, commitHash },
    );
    return result.records
        .filter(r => r.get('id') !== null)
        .map(r => ({
            id: r.get('id') as string,
            method: r.get('method') as string | null,
            path: r.get('path') as string,
            apiTitle: r.get('apiTitle') as string | null,
        }));
}

/**
 * Self-service resolution: for a given emergent endpoint, trace back to the
 * calling function's OWN service and return canonical endpoints exposed by
 * that same service.
 *
 * This handles the case where a service calls its own API endpoints internally
 * (e.g. in single-service ingestion mode or monolithic services).
 *
 * Traversal: EmergentEndpoint ← [:CALLS] ← Function ← [:CONTAINS] ← Service
 *            → [:EXPOSES_API] → APIInterface → [:HAS_ENDPOINT] → CanonicalEndpoint
 */
export async function getSelfServiceCandidatesForEmergent(
    emergentId: string,
): Promise<Array<{ id: string; method: string | null; path: string; apiTitle: string | null }>> {
    const result = await run(
        `MATCH (ep_em:APIEndpoint {id: $emergentId})
     OPTIONAL MATCH (f:Function)-[:CALLS]->(ep_em)
     OPTIONAL MATCH (s:Service)-[:CONTAINS]->(f)
     OPTIONAL MATCH (s)-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep_can:APIEndpoint)
     WHERE ep_can IS NOT NULL
       AND ep_can.id <> $emergentId
       AND ep_can.valid_to_commit IS NULL
     RETURN DISTINCT ep_can.id AS id, ep_can.method AS method, ep_can.path AS path, api.title AS apiTitle`,
        { emergentId, commitHash },
    );
    return result.records
        .filter(r => r.get('id') !== null)
        .map(r => ({
            id: r.get('id') as string,
            method: r.get('method') as string | null,
            path: r.get('path') as string,
            apiTitle: r.get('apiTitle') as string | null,
        }));
}

// ─── URL-match Welder (L0a / L0b) Helpers ────────────────────────────────────

/**
 * Returns distinct observed call metadata captured on `:CALLS` edges pointing
 * at the emergent endpoint. Each row pairs the caller-side URL with the
 * deployment environment hint so the resolver can choose the matching
 * `:APIDeployment` (env-aware) when the provider has multiple surfaces.
 */
export async function getCallerObservedUrlsForEmergent(
    emergentId: string,
): Promise<Array<{
    observedBaseUrl: string;
    observedEnvironment: string | null;
    declaredBy: string | null;
}>> {
    const result = await run(
        `MATCH (:Function)-[r:CALLS]->(ep:APIEndpoint {id: $emergentId})
         WHERE r.valid_to_commit IS NULL AND r.observedBaseUrl IS NOT NULL
         RETURN DISTINCT r.observedBaseUrl AS observedBaseUrl,
                         r.observedEnvironment AS observedEnvironment,
                         r.declaredBy AS declaredBy`,
        { emergentId },
    );
    return result.records.map(r => ({
        observedBaseUrl: r.get('observedBaseUrl') as string,
        observedEnvironment: r.get('observedEnvironment') as string | null,
        declaredBy: r.get('declaredBy') as string | null,
    }));
}

/**
 * Find live canonical `:APIEndpoint` nodes reachable via
 * `(:APIInterface)-[:DEPLOYED_AT]->(:APIDeployment {canonicalUrl})`, filtered
 * by HTTP method. Used by the L0a URL-exact welder.
 */
export async function getCandidatesByDeploymentUrl(
    canonicalBaseUrl: string,
    method: string,
): Promise<Array<{
    id: string;
    method: string | null;
    path: string;
    apiTitle: string | null;
    deploymentEnvironment: string | null;
    deploymentVisibility: string | null;
}>> {
    const result = await run(
        `MATCH (d:APIDeployment {canonicalUrl: $canonicalBaseUrl})
         WHERE d.valid_to_commit IS NULL
         MATCH (api:APIInterface)-[:DEPLOYED_AT]->(d)
         MATCH (api)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
         WHERE ep.valid_to_commit IS NULL AND toUpper(ep.method) = toUpper($method)
         RETURN DISTINCT ep.id AS id, ep.method AS method, ep.path AS path,
                         api.title AS apiTitle,
                         d.environment AS deploymentEnvironment,
                         d.visibility AS deploymentVisibility`,
        { canonicalBaseUrl, method },
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        method: r.get('method') as string | null,
        path: r.get('path') as string,
        apiTitle: r.get('apiTitle') as string | null,
        deploymentEnvironment: r.get('deploymentEnvironment') as string | null,
        deploymentVisibility: r.get('deploymentVisibility') as string | null,
    }));
}

/**
 * Find live canonical `:APIEndpoint` nodes reachable via
 * `(:APIInterface)-[:DEPLOYED_AT]->(:APIDeployment {host})`, filtered by HTTP
 * method. Used by the L0b URL-host welder when the caller's scheme/port
 * differs from the provider's declared deployment (typical when a client
 * targets the internal mesh URL but the OAS declares the public ingress).
 */
export async function getCandidatesByDeploymentHost(
    host: string,
    method: string,
): Promise<Array<{
    id: string;
    method: string | null;
    path: string;
    apiTitle: string | null;
    deploymentEnvironment: string | null;
    deploymentVisibility: string | null;
    deploymentBasePath: string | null;
}>> {
    const result = await run(
        `MATCH (d:APIDeployment {host: $host})
         WHERE d.valid_to_commit IS NULL
         MATCH (api:APIInterface)-[:DEPLOYED_AT]->(d)
         MATCH (api)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
         WHERE ep.valid_to_commit IS NULL AND toUpper(ep.method) = toUpper($method)
         RETURN DISTINCT ep.id AS id, ep.method AS method, ep.path AS path,
                         api.title AS apiTitle,
                         d.environment AS deploymentEnvironment,
                         d.visibility AS deploymentVisibility,
                         d.basePath AS deploymentBasePath`,
        { host, method },
    );
    return result.records.map(r => ({
        id: r.get('id') as string,
        method: r.get('method') as string | null,
        path: r.get('path') as string,
        apiTitle: r.get('apiTitle') as string | null,
        deploymentEnvironment: r.get('deploymentEnvironment') as string | null,
        deploymentVisibility: r.get('deploymentVisibility') as string | null,
        deploymentBasePath: r.get('deploymentBasePath') as string | null,
    }));
}

/**
 * Stable fingerprint of the URL-welding surface for cache invalidation in the
 * global resolver. Two counts are tracked:
 *   - number of live `:APIDeployment` nodes (provider-side surface)
 *   - number of live `:CALLS` edges that carry `observedBaseUrl` (caller-side surface)
 *
 * The resolver mixes these into the existing endpoint-set hash so that re-syncs
 * picking up new deployment data are NOT skipped even when the endpoint set is
 * unchanged.
 */
export async function getUrlWeldSurfaceCounts(): Promise<{
    apiDeploymentCount: number;
    observedCallsCount: number;
}> {
    const r = await run(
        `OPTIONAL MATCH (d:APIDeployment) WHERE d.valid_to_commit IS NULL
         WITH count(d) AS depCount
         OPTIONAL MATCH ()-[c:CALLS]->()
         WHERE c.valid_to_commit IS NULL AND c.observedBaseUrl IS NOT NULL
         RETURN depCount, count(c) AS callsCount`,
    );
    const rec = r.records[0];
    return {
        apiDeploymentCount: rec ? Number(rec.get('depCount')) : 0,
        observedCallsCount: rec ? Number(rec.get('callsCount')) : 0,
    };
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────

/**
 * Get all functions owned by a service (for LLM matchmaking).
 */
export async function getServiceFunctionsForMatchmaking(serviceUrn: string): Promise<Array<{ urn: string; name: string; intent: string | null; embedding: number[] | null }>> {
    const result = await run(
        `MATCH (s:Service {id: $serviceUrn})-[:CONTAINS]->(f:Function)
     WHERE f.valid_to_commit IS NULL
     RETURN f.id AS urn, f.name AS name, f.intent AS intent, f.embedding AS embedding`,
        { serviceUrn , commitHash },
    );
    return result.records.map(r => ({
        urn: r.get('urn') as string,
        name: r.get('name') as string,
        intent: r.get('intent') as string | null,
        embedding: r.get('embedding') as number[] | null,
    }));
}

/**
 * Get all API endpoints exposed by a service (via EXPOSES_API→HAS_ENDPOINT).
 */
export async function getServiceEndpoints(serviceUrn: string): Promise<Array<{ urn: string; path: string; method: string; operationId: string | null; summary: string | null; embedding: number[] | null }>> {
    const result = await run(
        `MATCH (s:Service {id: $serviceUrn})-[:EXPOSES_API]->(api:APIInterface)-[:HAS_ENDPOINT]->(ep:APIEndpoint)
     WHERE ep.valid_to_commit IS NULL
     RETURN ep.id AS urn, ep.path AS path, ep.method AS method, ep.operationId AS operationId, ep.summary AS summary, ep.embedding AS embedding`,
        { serviceUrn , commitHash },
    );
    return result.records.map(r => ({
        urn: r.get('urn') as string,
        path: r.get('path') as string,
        method: r.get('method') as string,
        operationId: r.get('operationId') as string | null,
        summary: r.get('summary') as string | null,
        embedding: r.get('embedding') as number[] | null,
    }));
}

/**
 * Return a Set of function URNs that have active LISTENS_TO edges (message consumers).
 * These functions are broker participants and must be excluded from HTTP endpoint
 * matchmaking to prevent false IMPLEMENTS_ENDPOINT links on AMQP handlers.
 *
 * Only LISTENS_TO is used as the exclusion signal: consumers are never HTTP handlers.
 * PUBLISHES_TO alone does not exclude (a controller can handle HTTP AND publish events).
 */
export async function getBrokerParticipantFunctionUrns(serviceUrn: string): Promise<Set<string>> {
    const result = await run(
        `MATCH (s:Service {id: $serviceUrn})-[:CONTAINS]->(f:Function)
         WHERE EXISTS {
             MATCH (f)-[r:LISTENS_TO]->() WHERE r.valid_to_commit IS NULL
         }
         RETURN f.id AS urn`,
        { serviceUrn, commitHash },
    );
    return new Set(result.records.map(r => r.get('urn') as string));
}
