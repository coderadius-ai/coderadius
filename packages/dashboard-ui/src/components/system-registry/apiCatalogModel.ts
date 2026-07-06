/**
 * apiCatalogModel — pure row building for the API catalog tab.
 *
 * Joins each catalog API to its exposing repo (for the clickable OAS spec
 * link) and precomputes the lowercase search index used by the tab filter.
 */
import type { InventoryApi, InventoryApiDeployment, InventoryRepo } from '@coderadius/shared-types';
import { buildFileUrl } from '../../lib/git-url';

/**
 * Chip label for a deployment surface: the environment when classified,
 * otherwise the URL host (the informative part). Unresolved server templates
 * fail URL parsing and are shown verbatim, not hidden.
 */
export function deploymentLabel(deployment: InventoryApiDeployment): string {
    if (deployment.environment !== 'unknown') return deployment.environment;
    try {
        return new URL(deployment.url).host;
    } catch {
        return deployment.url;
    }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Navigable href for a deployment chip, or null when clicking would lead
 * nowhere: unresolved templates (unparseable) and loopback dev surfaces are
 * shown but never linked.
 */
export function deploymentHref(deployment: InventoryApiDeployment): string | null {
    try {
        const url = new URL(deployment.url);
        if (deployment.url.includes('{')) return null;
        if (LOOPBACK_HOSTS.has(url.hostname)) return null;
        return deployment.url;
    } catch {
        return null;
    }
}

export interface ApiRow {
    api: InventoryApi;
    specUrl: string | null;
    searchText: string;
}

export function buildApiRows(apiCatalog: InventoryApi[], repositories: InventoryRepo[]): ApiRow[] {
    const repoByName = new Map(repositories.map(r => [r.name, r]));
    return apiCatalog.map(api => {
        const repo = api.repository ? repoByName.get(api.repository) : undefined;
        return {
            api,
            specUrl: buildFileUrl(repo?.url, api.specPath, repo?.defaultBranch ?? repo?.branch ?? 'main'),
            searchText: [
                api.title,
                api.version,
                api.apiSource,
                ...api.exposers.map(e => e.service),
                api.team,
                api.repository,
                ...api.endpoints.map(e => e.path),
                ...api.deployments.flatMap(d => [d.url, d.environment, d.visibility]),
            ].filter(Boolean).join(' ').toLowerCase(),
        };
    });
}
