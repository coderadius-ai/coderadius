/**
 * Deployment Unit — Graph Mutations
 *
 * A DeploymentUnit represents a runtime boundary within a monolith:
 * a Helm release, a k8s Deployment, an nginx vhost, or a Backstage
 * Component that shares code with other components in the same repo.
 *
 * Ontology:
 *   Service -[:DEPLOYED_AS]-> DeploymentUnit
 *   DeploymentUnit -[:EXPOSES]-> APIEndpoint
 *   Team -[:OWNS]-> DeploymentUnit (inherited from parent Service)
 *
 * DeploymentUnits are NOT code ownership boundaries. Functions are
 * always owned by the parent Service node, never by a DeploymentUnit.
 * DeploymentUnits model the Day-2 runtime topology (which ingress
 * routes stop working when a dependency fails).
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding } from '../grounding.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DeploymentUnit Mutations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Merge a DeploymentUnit node scoped to its qualified repository name.
 * URN: cr:deploymentunit:{qualifiedRepoName}:{name}
 */
export async function mergeDeploymentUnit(
    qualifiedRepoName: string,
    name: string,
    description: string | undefined,
    commitHash: string,
) {
    const urn = buildUrn('deploymentunit', qualifiedRepoName, name);
    // DeploymentUnit comes from Helm / k8s / Backstage component parsing.
    const prov = astGrounding('deployment-extractor@v1');
    await run(
        `MERGE (du:DeploymentUnit {id: $urn})
         ON CREATE SET du.name = $name,
                       du.description = $description,
                       du.valid_from_commit = $commitHash,
                       du.valid_to_commit = null,
                       du.createdAt = timestamp()
         ON MATCH SET  du.valid_from_commit = coalesce(du.valid_from_commit, $commitHash),
                       du.valid_to_commit = null,
                       du.description = $description
         ${groundingWriteClause('du')}`,
        { urn, name, description: description ?? null, commitHash, ...groundingParams(prov, commitHash) },
    );
}

/**
 * Link a Service to one of its deployment facets.
 *
 * Service -[:DEPLOYED_AS]-> DeploymentUnit
 *
 * This edge means: "the Service codebase is deployed as this runtime unit."
 * The DeploymentUnit inherits the Service's team ownership and repository.
 */
export async function linkServiceDeployedAs(
    qualifiedRepoName: string,
    serviceName: string,
    deploymentUnitName: string,
    commitHash: string,
) {
    const sUrn = buildUrn('service', qualifiedRepoName, serviceName);
    const duUrn = buildUrn('deploymentunit', qualifiedRepoName, deploymentUnitName);
    await run(
        `MATCH (s:Service {id: $sUrn}), (du:DeploymentUnit {id: $duUrn})
         MERGE (s)-[rel:DEPLOYED_AS]->(du)
         ON CREATE SET rel.valid_from_commit = $commitHash,
                       rel.valid_to_commit = null
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null`,
        { sUrn, duUrn, commitHash },
    );
}

/**
 * Link a DeploymentUnit to the Backstage System it belongs to.
 *
 * System -[:CONTAINS]-> DeploymentUnit
 *
 * Preserves the original System membership from catalog-info.yaml
 * even though the Component was demoted from Service to DeploymentUnit.
 */
export async function linkSystemContainsDeploymentUnit(
    systemName: string,
    qualifiedRepoName: string,
    deploymentUnitName: string,
    commitHash: string,
) {
    const sysUrn = buildUrn('system', systemName);
    const duUrn = buildUrn('deploymentunit', qualifiedRepoName, deploymentUnitName);
    await run(
        `MATCH (sys:System {id: $sysUrn}), (du:DeploymentUnit {id: $duUrn})
         MERGE (sys)-[rel:CONTAINS]->(du)
         ON CREATE SET rel.valid_from_commit = $commitHash,
                       rel.valid_to_commit = null
         ON MATCH SET  rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                       rel.valid_to_commit = null`,
        { sysUrn, duUrn, commitHash },
    );
}
