/**
 * Blast Transformer — Converts raw BlastAnalysisResult into display-ready DashboardSections.
 *
 * Isomorphic — no Node.js / Bun APIs.
 */

import type { BlastAnalysisResult, BlastedService } from '@coderadius/shared-types';
import type { DashboardConfig, DashboardSection, TreeNode } from '@coderadius/types';

/**
 * Transforms a raw BlastAnalysisResult into a complete DashboardConfig
 * ready for rendering by the App component.
 */
export function transformBlast(result: BlastAnalysisResult): DashboardConfig {
    const sections: DashboardSection[] = [];
    const f = result.summary.factors;

    const buildBlastTree = (impacts: BlastedService[], title: string): DashboardSection => {
        if (impacts.length === 0) {
            return { type: 'tree', title, nodes: [] };
        }

        const nodes: TreeNode[] = impacts.map(impact => {
            const meta: string[] = [];
            if (impact.repository) meta.push(`repo: ${impact.repository.url ?? impact.repository.name}`);
            if (impact.serviceUrn) meta.push(impact.serviceUrn);
            if (impact.teamOwner) meta.push(`team: ${impact.teamOwner}`);

            const badges = impact.relationships.map(r => {
                const color = ['WRITES', 'PUBLISHES_TO', 'CALLS', 'SPAWNS'].includes(r) ? 'green' : 'blue';
                return { text: r, color: color as any };
            });

            const children: TreeNode[] = impact.functions.map(fn => ({
                label: fn.file ? `${fn.name} → ${fn.file}` : fn.name,
                isFunction: true
            }));

            return {
                label: impact.serviceName,
                meta,
                badges,
                children
            };
        });

        return { type: 'tree', title, nodes };
    };

    sections.push(buildBlastTree(result.upstreamBlasts, 'Upstream Impacts'));
    sections.push(buildBlastTree(result.downstreamBlasts, 'Downstream Impacts'));

    return {
        title: 'Blast Radius Explorer',
        headerStats: [
            { label: 'Target', value: result.target.name, color: 'blue' },
            { label: 'Score', value: result.summary.blastRadiusScore, color: result.summary.blastRadiusScore > 5 ? 'red' : result.summary.blastRadiusScore > 2 ? 'yellow' : 'green' },
            { label: 'Downstream', value: f.downstreamServices, color: 'cyan' },
            { label: 'Upstream', value: f.upstreamServices, color: 'teal' },
            { label: 'Teams', value: f.teamsInvolved, color: f.crossTeamBlast ? 'red' : 'dim' }
        ],
        generatedAt: new Date().toISOString(),
        sections
    };
}
