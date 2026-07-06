import { describe, it, expect } from 'vitest';
import { buildOverviewSections } from '../../src/cli/commands/query/section-builders/index.js';
import type { AgentHarnessReport } from '../../src/graph/mutations/agentic.js';

describe('Section Builders', () => {
    it('buildOverviewSections should return elements correctly', () => {
        const mockReport: AgentHarnessReport = {
            summary: {
                totalActiveRepositories: 1,
                catalogCount: 0,
                mcpServersConfigured: 0,
                techBlindspotsCount: 0
            },
            matrix: [
                {
                    repoName: 'test-repo',
                    teamName: 'team-a',
                    maturityLevel: 2,
                    maturityLabel: 'Configured',
                    configs: 1,
                    skills: 0,
                    workflows: 0,
                    subagents: 0,
                    livenessCommits: 50,
                    tools: ['mastra']
                }
            ],
            mcpCensus: [],
            catalog: [],
            techBlindspots: [],
            skillRecommendations: [],
            duplicates: [],
            capabilityCoverage: [],
            semanticDuplicates: []
        };

        const sections = buildOverviewSections(mockReport);
        expect(sections.length).toBeGreaterThan(0);
        expect(sections[0].type).toBe('histogram');
        expect(sections[1].type).toBe('executive-briefing');
    });
});
