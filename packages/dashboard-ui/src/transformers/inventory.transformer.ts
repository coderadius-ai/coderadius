/**
 * System Registry transformer.
 *
 * The registry page renders through SystemRegistryView. This transformer only
 * contributes navigation/header metadata for the app shell.
 */

import type { InventoryReport } from '@coderadius/shared-types';
import type { NavigationConfig } from '@coderadius/types';

interface InventoryTransformResult {
    navItem: NavigationConfig['items'][number];
    headerStats: { label: string; value: string | number; color?: string }[];
}

export function transformInventory(report: InventoryReport): InventoryTransformResult {
    const { summary } = report;
    const contractsCount = report.repositories.filter(r => r.ingestionLevel === 'contracts').length;
    const semanticCount = report.repositories.filter(r => r.ingestionLevel === 'semantic').length;
    const structureCount = report.repositories.filter(r => r.ingestionLevel === 'structure').length;

    return {
        navItem: {
            id: 'inventory',
            label: 'System Registry',
            icon: 'LayoutList',
            pageTitle: 'System Registry',
            pageSubtitle: 'Auto-generated service catalog from your architecture graph',
            headerStats: [
                { label: 'Repositories', value: summary.totalRepos },
                { label: 'Services', value: summary.totalServices },
                { label: 'Teams', value: summary.totalTeams },
                {
                    label: 'Contracts',
                    value: contractsCount,
                    tooltip: `${contractsCount} repos with data contract extraction, ${semanticCount} semantic analysis, ${structureCount} structural only`,
                },
            ],
        },
        headerStats: [
            { label: 'Registered', value: `${summary.totalRepos} repos` },
        ],
    };
}
