/**
 * Dashboard data layer — ports.
 *
 * Presentational components depend on this interface, never on the raw payload.
 * Today the only adapter is StaticPayloadDataSource (client-side filter over the
 * embedded `window.__RADIUS_DATA__`). When an org-aware API lands, a
 * GraphQLDataSource implements the same port and the swap needs no component
 * changes — the org filter is pushed server-side instead of applied client-side.
 */
import type {
    InventoryReport,
    InventoryOrganization,
    InventoryTenant,
    GovernanceReport,
    TopologyMap,
    DepsReport,
    GravityAnalysisResult,
    AgentHarnessReport,
} from '@coderadius/shared-types';

/** The org-segregation filter. Empty `orgPaths` means no filter (all organizations). */
export interface OrgFilter {
    orgPaths: string[];
}

/**
 * Async-ready resource envelope. With the static adapter `loading` is always
 * false and `error` always null; the shape exists so a future async adapter
 * (GraphQL) can populate loading/error without changing any consumer.
 */
export interface Resource<T> {
    data: T | null;
    loading: boolean;
    error: Error | null;
}

export interface DashboardDataSource {
    /** Org-filtered slices. Today only inventory honours the filter; the rest pass through. */
    getInventory(filter: OrgFilter): Resource<InventoryReport>;
    getGovernance(filter: OrgFilter): Resource<GovernanceReport>;
    getTopology(filter: OrgFilter): Resource<TopologyMap>;
    getDeps(filter: OrgFilter): Resource<DepsReport>;
    getGravity(filter: OrgFilter): Resource<GravityAnalysisResult>;
    getRadar(filter: OrgFilter): Resource<AgentHarnessReport>;
    /** The full, UNFILTERED organization list — drives the switcher itself. */
    getOrganizations(): InventoryOrganization[];
    /** The configured tenant (branding). Never filtered. */
    getTenant(): InventoryTenant | null;
}
