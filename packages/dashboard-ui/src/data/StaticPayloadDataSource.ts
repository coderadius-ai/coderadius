import type {
    RadiusDashboardPayload,
    InventoryReport,
    InventoryOrganization,
    InventoryTenant,
    GovernanceReport,
    TopologyMap,
    DepsReport,
    GravityAnalysisResult,
    AgentHarnessReport,
} from '@coderadius/shared-types';
import type { DashboardDataSource, OrgFilter, Resource } from './types.js';
import { filterInventoryByOrg } from './filterInventoryByOrg.js';

function resolved<T>(data: T | null): Resource<T> {
    return { data, loading: false, error: null };
}

/**
 * Reads the embedded dashboard payload (`window.__RADIUS_DATA__`) synchronously
 * and applies the org filter client-side. The only adapter today.
 *
 * Non-inventory slices pass through unchanged: their DTOs don't carry org
 * lineage, so filtering them is a server-side concern for the future
 * GraphQLDataSource. The port is identical either way, so consumers never change.
 */
export class StaticPayloadDataSource implements DashboardDataSource {
    constructor(private readonly payload: RadiusDashboardPayload) {}

    getInventory(filter: OrgFilter): Resource<InventoryReport> {
        const inventory = this.payload.inventory;
        if (!inventory) return resolved<InventoryReport>(null);
        return resolved(filterInventoryByOrg(inventory, filter.orgPaths));
    }

    getGovernance(): Resource<GovernanceReport> { return resolved(this.payload.governance); }
    getTopology(): Resource<TopologyMap> { return resolved(this.payload.topology); }
    getDeps(): Resource<DepsReport> { return resolved(this.payload.deps); }
    getGravity(): Resource<GravityAnalysisResult> { return resolved(this.payload.gravity); }
    getRadar(): Resource<AgentHarnessReport> { return resolved(this.payload.radar); }

    getOrganizations(): InventoryOrganization[] { return this.payload.inventory?.organizations ?? []; }
    getTenant(): InventoryTenant | null { return this.payload.inventory?.tenant ?? null; }
}
