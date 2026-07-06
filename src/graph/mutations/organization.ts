/**
 * Organization — Tenant and Organization mutations
 *
 * Tenant: configured top-level enterprise identity (one per deployment).
 * Organization: SINGLE-LEVEL grouping derived from repo.org strings. Orgs may
 * come from GitLab groups, GitHub orgs, or a corporate IDP/LDAP, so the model
 * is one flat level: GitLab subgroup paths collapse into their base group
 * (`group/sub-group/...` → `group`). Repo IDENTITY keeps the full path (see
 * `getQualifiedRepoName`) so same-named repos in different subgroups never
 * collide; only the grouping node is collapsed.
 *
 * All Organization nodes link to the active Tenant via PART_OF.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { buildUrn } from '../urn.js';
import { astGrounding, declaredGrounding } from '../grounding.js';

const INVALID_ORG_VALUES = new Set(['', 'unknown', 'undefined', 'null']);

export function sanitizeOrg(org?: string | null): string | null {
    if (!org) return null;
    const clean = org.trim().toLowerCase();
    if (INVALID_ORG_VALUES.has(clean)) return null;
    return clean;
}

/** Base (first) segment of an org path: the single-level Organization identity. */
export function baseOrgPath(org?: string | null): string | null {
    const clean = sanitizeOrg(org);
    if (!clean) return null;
    return clean.split('/').filter(Boolean)[0] ?? null;
}

export async function mergeTenant(
    slug: string,
    name: string,
    description: string | undefined,
    commitHash: string,
) {
    const urn = buildUrn('tenant', slug);
    const prov = declaredGrounding('tenant-config@v1');
    await run(
        `MERGE (t:Tenant {id: $urn})
         ON CREATE SET t.name = $name, t.slug = $slug, t.description = $description,
                       t.createdAt = timestamp()
         ON MATCH SET  t.name = $name, t.slug = $slug, t.description = coalesce($description, t.description)
         ${groundingWriteClause('t')}`,
        { urn, name, slug, description: description ?? null, commitHash, ...groundingParams(prov, commitHash) },
    );
}

/** MERGE the single-level Organization node for an org path (subgroups collapse). */
export async function mergeOrganization(
    orgPath: string,
    commitHash: string,
) {
    const base = baseOrgPath(orgPath);
    if (!base) return;

    const prov = astGrounding('source-resolver@v1');
    await run(
        `MERGE (o:Organization {id: $urn})
           ON CREATE SET o.name = $base, o.fullPath = $base,
                         o.createdAt = timestamp()
           ON MATCH SET  o.name = $base, o.fullPath = $base
         ${groundingWriteClause('o')}`,
        { urn: buildUrn('organization', base), base, commitHash, ...groundingParams(prov, commitHash) },
    );
}

/**
 * Link every Organization to the configured Tenant.
 *
 * One Tenant per deployment (see file header). Run as a terminal post-pass
 * once every Organization node exists. Idempotent — the PART_OF MERGE is
 * keyed on the (org, tenant) pair.
 */
export async function linkRootOrganizationsToTenant(tenantSlug: string, commitHash: string) {
    const tenantUrn = buildUrn('tenant', tenantSlug);
    await run(
        `MATCH (t:Tenant {id: $tenantUrn})
         MATCH (o:Organization)
         MERGE (o)-[r:PART_OF]->(t)
           ON CREATE SET r.valid_from_commit = $commitHash`,
        { tenantUrn, commitHash },
    );
}

export async function linkRepositoryBelongsToOrg(
    repoUrn: string,
    orgPath: string,
    commitHash: string,
) {
    const base = baseOrgPath(orgPath);
    if (!base) return;

    const orgUrn = buildUrn('organization', base);
    await run(
        `MATCH (r:Repository {id: $repoUrn})
         OPTIONAL MATCH (r)-[old:BELONGS_TO]->(:Organization)
         DELETE old
         WITH r
         MATCH (o:Organization {id: $orgUrn})
         MERGE (r)-[:BELONGS_TO {valid_from_commit: $commitHash}]->(o)`,
        { repoUrn, orgUrn, commitHash },
    );
}

/**
 * Collapse legacy nested Organization nodes into their base group.
 *
 * Earlier versions materialised one node per GitLab subgroup segment with
 * CHILD_OF edges. Single-level is now the model: repos linked to a nested org
 * are relinked to the base org (created if missing), then every nested node
 * is deleted. Idempotent — a graph with only base orgs is a no-op.
 */
export async function collapseNestedOrganizations(commitHash: string) {
    const prov = astGrounding('org-collapse@v1');

    // 1. Relink repos pointing at nested orgs to the base org.
    await run(
        `MATCH (r:Repository)-[:BELONGS_TO]->(o:Organization)
         WHERE o.fullPath CONTAINS '/'
         WITH DISTINCT r, split(o.fullPath, '/')[0] AS base
         MERGE (b:Organization {id: 'cr:organization:' + base})
           ON CREATE SET b.name = base, b.fullPath = base,
                         b.createdAt = timestamp()
         ${groundingWriteClause('b')}
         MERGE (r)-[:BELONGS_TO {valid_from_commit: $commitHash}]->(b)`,
        { commitHash, ...groundingParams(prov, commitHash) },
    );

    // 2. Delete every nested node (their CHILD_OF / stale BELONGS_TO go with them).
    await run(
        `MATCH (o:Organization)
         WHERE o.fullPath CONTAINS '/'
         DETACH DELETE o`,
        {},
    );
}
