/**
 * Gravity Transformer — Converts raw GravityAnalysisResult into display-ready DashboardSections.
 *
 * Isomorphic — no Node.js / Bun APIs.
 */

import type { GravityAnalysisResult, GravityServiceRef } from '@coderadius/shared-types';
import type { NavigableSection } from '@coderadius/types';
import { buildMultiServiceRepoSet, getItemQualification } from './utils';

export function transformGravity(result: GravityAnalysisResult): {
    sections: NavigableSection[];
    navItem: {
        id: string; label: string; icon: string;
        pageTitle: string; pageSubtitle: string;
        headerStats: { label: string; value: string | number; color?: string }[];
    };
    headerStats: { label: string; value: string | number; color?: string }[];
} {
    const sections = buildGravitySections(result);

    const allNodes = [...result.dataMonoliths, ...result.serviceBottlenecks];
    const tierCounts = { seismic: 0, critical: 0, high: 0 };
    for (const node of allNodes) {
        const score = node.spofScore;
        if (score >= 100) tierCounts.seismic++;
        else if (score >= 50) tierCounts.critical++;
        else if (score >= 15) tierCounts.high++;
    }

    const uniqueServices = new Set<string>();
    for (const node of allNodes) {
        for (const srv of [...(node.writeServices ?? []), ...(node.readServices ?? []), ...(node.dependentServices ?? [])]) {
            uniqueServices.add(srv.name);
        }
    }

    const headerStats: { label: string; value: string | number; color?: string }[] = [];
    if (tierCounts.seismic > 0) headerStats.push({ label: 'Seismic', value: tierCounts.seismic, color: 'red' });
    if (tierCounts.critical > 0) headerStats.push({ label: 'Critical', value: tierCounts.critical, color: 'yellow' });
    if (tierCounts.high > 0) headerStats.push({ label: 'High', value: tierCounts.high });
    if (uniqueServices.size > 0) headerStats.push({ label: 'Services at Risk', value: uniqueServices.size, color: 'blue' });

    const navItem = {
        id: 'gravity', label: 'SPOFs', icon: 'Flame',
        pageTitle: 'SPOFs',
        pageSubtitle: 'Single points of failure and coupling bottlenecks.',
        headerStats,
    };

    return { sections, navItem, headerStats };
}

function buildGravitySections(result: GravityAnalysisResult): NavigableSection[] {
    const sections: NavigableSection[] = [];

    // Apply the same monorepo-aware qualifier rule used by every other table:
    // count repos that host >=2 services, then set `context` on every ref so
    // the Leaderboard renders `repo / name` uniformly. The Cypher query
    // populates `repoName` on each GravityServiceRef so we can compute it
    // entirely client-side without altering UI rendering code.
    const allRefs: GravityServiceRef[] = [
        ...result.dataMonoliths.flatMap(n => [
            ...(n.writeServices ?? []),
            ...(n.readServices ?? []),
            ...(n.dependentServices ?? []),
        ]),
        ...result.serviceBottlenecks.flatMap(n => [
            ...(n.writeServices ?? []),
            ...(n.readServices ?? []),
            ...(n.dependentServices ?? []),
        ]),
    ];
    const multiServiceRepos = buildMultiServiceRepoSet(allRefs.map(r => r.repoName));
    const qualifyRefs = (refs: GravityServiceRef[] | undefined): GravityServiceRef[] | undefined => {
        if (!refs) return refs;
        return refs.map(r => ({
            ...r,
            context: getItemQualification(r.name, r.repoName, r.repoName ? multiServiceRepos.has(r.repoName) : false) ?? r.context ?? null,
        }));
    };

    const mapNodeToLeaderboard = (node: any) => {
        return {
            title: node.name,
            nodeType: node.type,
            urn: node.urn,
            score: Math.round(node.spofScore),
            metrics: [], // we don't use generic metrics for Gravity UI anymore
            teams: node.teams,
            repository: node.repository,
            writeServices: qualifyRefs(node.writeServices),
            readServices: qualifyRefs(node.readServices),
            dependentServices: qualifyRefs(node.dependentServices),
            technology: node.technology,
            discoverySource: node.discoverySource
        };
    };

    return [{
        type: 'tabs',
        navId: 'gravity',
        tabs: [
            {
                id: 'data-monoliths',
                label: 'Data Monoliths',
                sections: [{
                    type: 'leaderboard',
                    title: '',
                    items: result.dataMonoliths.map(n => mapNodeToLeaderboard(n)),
                    navId: 'gravity'
                }]
            },
            {
                id: 'service-bottlenecks',
                label: 'Service Bottlenecks',
                sections: [{
                    type: 'leaderboard',
                    title: '',
                    items: result.serviceBottlenecks.map(n => mapNodeToLeaderboard(n)),
                    navId: 'gravity'
                }]
            }
        ]
    } as any];
}
