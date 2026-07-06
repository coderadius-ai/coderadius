import { createContext, useContext, useMemo, type ReactNode } from 'react';
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
import type { DashboardDataSource, Resource } from './types.js';
import { useOrgFilter } from './OrgFilterContext.js';

const DataSourceContext = createContext<DashboardDataSource | null>(null);

/** Injects the data source (DI at the composition root). Swap the source = swap the backend. */
export function DataSourceProvider({ source, children }: { source: DashboardDataSource; children: ReactNode }) {
    return <DataSourceContext.Provider value={source}>{children}</DataSourceContext.Provider>;
}

function useDataSource(): DashboardDataSource {
    const ctx = useContext(DataSourceContext);
    if (!ctx) throw new Error('useDataSource must be used inside <DataSourceProvider>');
    return ctx;
}

// ─── Selector hooks ──────────────────────────────────────────────────────────
// Each reads the active org filter and returns an org-scoped Resource. Components
// consume these instead of the raw payload, so the data source stays swappable.

export function useInventory(): Resource<InventoryReport> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getInventory({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

export function useGovernance(): Resource<GovernanceReport> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getGovernance({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

export function useTopology(): Resource<TopologyMap> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getTopology({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

export function useDeps(): Resource<DepsReport> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getDeps({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

export function useGravity(): Resource<GravityAnalysisResult> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getGravity({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

export function useRadar(): Resource<AgentHarnessReport> {
    const source = useDataSource();
    const { selectedOrgPaths } = useOrgFilter();
    return useMemo(() => source.getRadar({ orgPaths: selectedOrgPaths }), [source, selectedOrgPaths]);
}

/** The full, UNFILTERED organization list — drives the switcher itself. */
export function useOrganizations(): InventoryOrganization[] {
    return useDataSource().getOrganizations();
}

/** The configured tenant (branding). Never filtered. */
export function useTenant(): InventoryTenant | null {
    return useDataSource().getTenant();
}
