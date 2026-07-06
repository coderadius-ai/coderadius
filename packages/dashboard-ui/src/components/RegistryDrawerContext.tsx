/**
 * RegistryDrawerContext — lightweight React context to wire DataTable row-click
 * to the System Registry drawer without prop-drilling through Tabs/SectionRenderer.
 *
 * Provider: App.tsx (only when activeNavId === 'inventory')
 * Consumer: DataTable (reads onRowClick + selectedRowId from context)
 */

import { createContext, useContext } from 'react';

export interface RegistryDrawerContextValue {
    onRowClick: (data: Record<string, unknown>) => void;
    selectedRowId: string | undefined;
}

export const RegistryDrawerContext = createContext<RegistryDrawerContextValue | null>(null);

/** Returns the context value, or null when outside a provider (tables not in the registry). */
export function useRegistryDrawerContext(): RegistryDrawerContextValue | null {
    return useContext(RegistryDrawerContext);
}
