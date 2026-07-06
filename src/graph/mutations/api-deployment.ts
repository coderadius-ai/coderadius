import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { canonicalizeBaseUrl, parseBaseUrl } from '../../utils/url-normalizer.js';
import type { GroundingFields } from '../grounding.js';

/**
 * Renamed from `:PhysicalResource` (POC mode in-place): the old label was
 * semantically misleading (it modelled only API surfaces, not generic infra)
 * and would have grown into a god-node if extended. Each physical-thing-family
 * now has its own label (`:DatabaseEndpoint`, `:MessageBroker`, `:APIDeployment`).
 */

export type APIDeploymentEnvironment = 'production' | 'staging' | 'dev' | 'local' | 'unknown';
export type APIDeploymentVisibility = 'public' | 'internal' | 'admin' | 'partner' | 'unknown';
export type APIDeploymentSource =
    | 'oas-servers'
    | 'helm-ingress'
    | 'k8s-ingress'
    | 'catalog-link'
    | 'docker-compose'
    | 'declared'
    | 'inferred';
export type APIDeploymentConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface MergeAPIDeploymentInput {
    apiUrn: string;
    baseUrl: string;
    environment?: APIDeploymentEnvironment;
    visibility?: APIDeploymentVisibility;
    declaredBy: APIDeploymentSource;
    confidence: APIDeploymentConfidence;
    cluster?: string;
    grounding?: GroundingFields;
}

/**
 * MERGE an `:APIDeployment` keyed by canonical URL + link it to its
 * `:APIInterface` via `[:DEPLOYED_AT]`.
 *
 * URN: `cr:apideployment:<canonicalUrl>` where canonical = scheme://host[:port][basePath]
 * (lowercased host, default ports stripped, no trailing slash).
 *
 * Returns the deterministic deployment URN.
 */
export async function mergeAPIDeployment(input: MergeAPIDeploymentInput, commitHash: string): Promise<string> {
    const parsed = parseBaseUrl(input.baseUrl);
    const canonical = canonicalizeBaseUrl(input.baseUrl);
    const urn = buildUrn('apideployment', canonical);
    await run(
        `MERGE (d:APIDeployment {id: $urn})
         ON CREATE SET d.valid_from_commit = $commitHash, d.valid_to_commit = null,
                       d.name = $baseUrl, d.canonicalUrl = $canonical,
                       d.scheme = $scheme, d.host = $host, d.port = $port, d.basePath = $basePath,
                       d.environment = $environment, d.visibility = $visibility,
                       d.declaredBy = $declaredBy, d.confidence = $confidence,
                       d.cluster = $cluster, d.createdAt = timestamp()
         ON MATCH SET d.valid_from_commit = coalesce(d.valid_from_commit, $commitHash),
                      d.valid_to_commit = null,
                      d.environment = coalesce($environment, d.environment),
                      d.visibility = coalesce($visibility, d.visibility),
                      d.declaredBy = coalesce($declaredBy, d.declaredBy),
                      d.confidence = coalesce($confidence, d.confidence),
                      d.cluster = coalesce($cluster, d.cluster)
         ${groundingWriteClause('d')}
         WITH d
         MATCH (api:APIInterface {id: $apiUrn})
         MERGE (api)-[rel:DEPLOYED_AT]->(d)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
         ON MATCH  SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null`,
        {
            urn,
            baseUrl: input.baseUrl,
            canonical,
            scheme: parsed?.scheme ?? null,
            host: parsed?.host ?? null,
            port: parsed?.port ?? null,
            basePath: parsed?.basePath ?? null,
            environment: input.environment ?? null,
            visibility: input.visibility ?? null,
            declaredBy: input.declaredBy,
            confidence: input.confidence,
            cluster: input.cluster ?? null,
            apiUrn: input.apiUrn,
            commitHash,
            ...groundingParams(input.grounding, commitHash),
        },
    );
    return urn;
}

/**
 * Return all live `:APIDeployment` IDs linked to a specific `:APIInterface`.
 * Used by the OpenAPI ingestion mark-and-sweep to drop deployment URLs that
 * no longer appear in the spec's `servers:` block.
 */
export async function getExistingAPIDeploymentIds(apiUrn: string): Promise<string[]> {
    const r = await run(
        `MATCH (api:APIInterface {id: $apiUrn})-[:DEPLOYED_AT]->(d:APIDeployment)
         WHERE d.valid_to_commit IS NULL
         RETURN d.id AS id`,
        { apiUrn },
    );
    return r.records.map(rec => rec.get('id') as string);
}
