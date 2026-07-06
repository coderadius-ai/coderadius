import type { InventoryReport } from '@coderadius/shared-types';

/**
 * Does a repo's org match one of the selected orgs?
 *
 * Organizations are single-level, so this is a case-normalized exact match:
 * `repo.org` is projected from the BELONGS_TO edge (already the base org),
 * while selections come from `Organization.fullPath` (lowercased).
 */
function repoMatchesOrg(repoOrg: string | null, orgPaths: string[]): boolean {
    if (orgPaths.length === 0) return true;
    const o = (repoOrg ?? '').toLowerCase();
    if (!o) return false;
    return orgPaths.some(sel => o === sel.toLowerCase());
}

/**
 * Narrow an InventoryReport to the selected organization(s), client-side.
 *
 * Empty `orgPaths` returns the report unchanged. Cascades repositories ->
 * services (by repository name) -> teams (by membership), and recomputes
 * `summary` so tab counts and header KPIs reflect the scope. `tenant` and
 * `organizations` are preserved: the tenant is branding and the organization
 * list is the switcher's own source, neither should shrink with the filter.
 */
export function filterInventoryByOrg(report: InventoryReport, orgPaths: string[]): InventoryReport {
    if (orgPaths.length === 0) return report;

    const repositories = report.repositories.filter(r => repoMatchesOrg(r.org, orgPaths));
    const repoNames = new Set(repositories.map(r => r.name));
    const services = report.services.filter(s => s.repository.name != null && repoNames.has(s.repository.name));
    const apiCatalog = report.apiCatalog.filter(a => a.repository != null && repoNames.has(a.repository));

    const teamNames = new Set<string>();
    for (const r of repositories) for (const t of r.teams) teamNames.add(t);
    for (const s of services) if (s.team) teamNames.add(s.team);
    const teams = report.teams.filter(t => teamNames.has(t.name));

    return {
        ...report,
        repositories,
        services,
        teams,
        apiCatalog,
        summary: {
            totalRepos: repositories.length,
            totalServices: services.length,
            totalTeams: teams.length,
            totalFiles: repositories.reduce((sum, r) => sum + r.fileCount, 0),
            totalFunctions: repositories.reduce((sum, r) => sum + r.functionCount, 0),
        },
    };
}
