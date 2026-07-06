/**
 * Lineage Transformer — Converts raw LineageAnalysisResult into display-ready DashboardConfig.
 *
 * Isomorphic — no Node.js / Bun APIs.
 */

import type { LineageAnalysisResult } from '@coderadius/shared-types';
import type { DashboardConfig, DashboardSection, TreeNode } from '@coderadius/types';

/**
 * Transforms a raw LineageAnalysisResult into a complete DashboardConfig
 * ready for rendering by the App component.
 */
export function transformLineage(result: LineageAnalysisResult): DashboardConfig {
    const sections: DashboardSection[] = [];

    if (result.journey.length === 0) {
        sections.push({
            type: 'alerts',
            title: 'Lineage Result',
            alerts: [{
                type: result.summary.requiresDeepScan ? 'warning' : 'info',
                title: 'No lineage path found',
                message: result.summary.requiresDeepScan
                    ? 'Re-run with --depth contracts to capture fine-grained lineage.'
                    : 'This field does not appear to cross any service boundaries.'
            }]
        });
    } else {
        // Group steps by service (consecutive merge)
        interface ServiceGroup {
            serviceName: string;
            serviceUrn: string | null;
            teamOwner: string | null;
            steps: typeof result.journey;
        }
        const groups: ServiceGroup[] = [];
        for (const step of result.journey) {
            const last = groups[groups.length - 1];
            if (last && last.serviceName === step.serviceName) {
                last.steps.push(step);
            } else {
                groups.push({
                    serviceName: step.serviceName,
                    serviceUrn: step.serviceUrn,
                    teamOwner: step.teamOwner,
                    steps: [step],
                });
            }
        }

        const nodes: TreeNode[] = groups.map((group, gi) => {
            const meta: string[] = [];
            const repo = group.steps[0]?.repository;
            if (repo) meta.push(`repo: ${repo.url ?? repo.name}`);
            if (group.serviceUrn) meta.push(group.serviceUrn);
            if (group.teamOwner) meta.push(`team: ${group.teamOwner}`);

            const children: TreeNode[] = group.steps.map(step => {
                const verbText = step.action === 'PRODUCES' ? 'PRODUCES' : step.action;
                const verbColor = step.action === 'PRODUCES' ? 'green' : 'blue';

                let label = `${step.functionName}()`;
                if (step.bridgeResource) {
                    label += ` → [${step.bridgeResource.type}] ${step.bridgeResource.name ?? step.bridgeResource.type}`;
                } else {
                    label += ` → schema ${step.structureName ?? 'unknown'}`;
                }

                return {
                    label,
                    isFunction: true,
                    badges: [{ text: verbText, color: verbColor as any }]
                };
            });

            // Add the bridge arrow implicitly via the last item if there's a next group
            if (gi < groups.length - 1) {
                const lastStep = group.steps[group.steps.length - 1];
                const bridge = lastStep.bridgeResource;
                if (bridge) {
                    children.push({
                        label: `── ▼ ── [${bridge.type}] ${bridge.name ?? bridge.type}`,
                        badges: [{ text: 'BRIDGE', color: 'magenta' }]
                    });
                }
            }

            return {
                label: group.serviceName,
                meta,
                children
            };
        });

        sections.push({
            type: 'tree',
            title: 'Semantic Journey',
            nodes
        });
    }

    return {
        title: 'Semantic Data Lineage',
        headerStats: [
            { label: 'Data Field', value: result.targetField.name, color: 'blue' },
            { label: 'Schema', value: result.targetField.structure, color: 'magenta' },
            { label: 'Hops', value: result.summary.totalHops, color: result.summary.totalHops > 3 ? 'red' : 'yellow' },
            { label: 'Services', value: result.summary.servicesTraversed, color: 'teal' }
        ],
        generatedAt: new Date().toISOString(),
        sections
    };
}
