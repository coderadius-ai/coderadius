import type { DashboardDataSource } from './types.js';

/**
 * Future adapter — NOT implemented.
 *
 * Documents the seam: when an org-aware API exists, this adapter implements the
 * same `DashboardDataSource` port by pushing `OrgFilter.orgPaths` to the server
 * instead of filtering client-side. It maps cleanly onto the existing backend
 * query shape `(node)-[:BELONGS_TO]->(o:Organization) WHERE o.fullPath IN $orgPaths`
 * (see `src/graph/queries/inventory.ts`). Async data-fetching concerns
 * (caching / loading / error, e.g. react-query) belong HERE, not in the static
 * adapter; the `Resource<T>` envelope already carries loading/error so no
 * consumer changes when this lands.
 */
export function createGraphQLDataSource(_endpoint: string): DashboardDataSource {
    throw new Error(
        'GraphQLDataSource is not implemented: the dashboard is served as a static payload today. ' +
        'See the doc comment for the planned org-filter seam (orgPaths pushed server-side).',
    );
}
