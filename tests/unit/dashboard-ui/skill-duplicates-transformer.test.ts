import { describe, expect, it } from 'vitest';
import { buildSkillDuplicatesSections } from '../../../packages/dashboard-ui/src/transformers/harness.transformer';
import type { AgentHarnessReport, SkillDuplicatesView, SkillDuplicateCluster, SkillProjectionPoint } from '@coderadius/shared-types';

function mkCluster(id: string, size: number, avg = 0.92): SkillDuplicateCluster {
    const members = Array.from({ length: size }, (_, i) => ({
        configId: `${id}-m${i}`,
        name: `skill-${id}-${i}`,
        description: `Description for ${id}-${i}`,
        filePath: `.claude/skills/${id}-${i}/SKILL.md`,
        service: `svc-${i}`,
        topics: ['pr-review'],
        technologies: [],
    }));
    return {
        id,
        label: 'pr-review',
        memberIds: members.map(m => m.configId),
        members,
        size,
        similarity: { min: avg - 0.01, max: avg + 0.01, avg },
        services: members.map(m => m.service),
        topics: ['pr-review'],
        technologies: [],
    };
}

function mkProjection(clusterIds: string[]): SkillProjectionPoint[] {
    return clusterIds.flatMap((cid, i) => [
        { configId: `${cid}-m0`, x: 0.2 + i * 0.3, y: 0.5, clusterId: cid },
        { configId: `${cid}-m1`, x: 0.25 + i * 0.3, y: 0.55, clusterId: cid },
    ]);
}

function mkReport(view: Partial<SkillDuplicatesView>): AgentHarnessReport {
    const skillDuplicates: SkillDuplicatesView = {
        clusters: [],
        projection: [],
        threshold: 0.90,
        totalSkills: 0,
        totalCrossRepoClusters: 0,
        ...view,
    };
    return {
        matrix: [],
        mcpCensus: [],
        duplicates: [],
        capabilityCoverage: [],
        catalog: [],
        semanticDuplicates: [],
        techBlindspots: [],
        skillRecommendations: [],
        teamAliasProposals: [],
        skillDuplicates,
    };
}

describe('buildSkillDuplicatesSections', () => {
    it('returns [] when no skills exist at all (tab hidden)', () => {
        const report = mkReport({ totalSkills: 0, clusters: [], projection: [] });
        const sections = buildSkillDuplicatesSections(report);
        expect(sections).toEqual([]);
    });

    it('surfaces stat-strip + empty-state alert when skills exist but no cluster matches threshold', () => {
        const report = mkReport({ totalSkills: 7, clusters: [], projection: [] });
        const sections = buildSkillDuplicatesSections(report);
        expect(sections).toHaveLength(2);
        expect(sections.map(s => s.type)).toEqual(['summary-cards', 'alerts']);
        const alerts = sections[1];
        if (alerts.type !== 'alerts') throw new Error('unreachable');
        expect(alerts.alerts[0].type).toBe('info');
        expect(alerts.alerts[0].title).toMatch(/no cross-repo/i);
    });

    it('returns stat-strip + constellation + cluster-cards for a report with clusters', () => {
        const c1 = mkCluster('c1', 3, 0.94);
        const c2 = mkCluster('c2', 2, 0.91);
        const report = mkReport({
            clusters: [c1, c2],
            projection: mkProjection(['c1', 'c2']),
            totalSkills: 12,
            totalCrossRepoClusters: 2,
            threshold: 0.90,
        });

        const sections = buildSkillDuplicatesSections(report);
        expect(sections).toHaveLength(3);

        const types = sections.map(s => s.type);
        expect(types).toEqual(['summary-cards', 'skill-constellation', 'skill-cluster-cards']);
    });

    it('stat-strip surfaces clusters, skills involved, skills indexed, and threshold', () => {
        const c1 = mkCluster('c1', 3);
        c1.services = ['inventory', 'orders', 'payment'];
        const report = mkReport({
            clusters: [c1],
            projection: mkProjection(['c1']),
            totalSkills: 5,
            totalCrossRepoClusters: 1,
            threshold: 0.90,
        });

        const [stats] = buildSkillDuplicatesSections(report);
        expect(stats.type).toBe('summary-cards');
        if (stats.type !== 'summary-cards') throw new Error('unreachable');
        const labels = stats.cards.map(c => c.label);
        expect(labels).toContain('Clusters');
        expect(labels).toContain('Skills involved');
        expect(labels).toContain('Skills indexed');
        expect(labels).toContain('Threshold');
    });

    it('cluster-cards section preserves the original cluster order from the report', () => {
        const c1 = mkCluster('c1', 4, 0.93);
        const c2 = mkCluster('c2', 2, 0.99);
        const report = mkReport({
            clusters: [c1, c2],
            projection: mkProjection(['c1', 'c2']),
            totalSkills: 6,
            totalCrossRepoClusters: 2,
        });

        const sections = buildSkillDuplicatesSections(report);
        const cardsSection = sections.find(s => s.type === 'skill-cluster-cards');
        expect(cardsSection).toBeDefined();
        if (cardsSection?.type !== 'skill-cluster-cards') throw new Error('unreachable');
        expect(cardsSection.clusters.map(c => c.id)).toEqual(['c1', 'c2']);
    });
});
