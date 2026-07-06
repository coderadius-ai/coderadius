import { describe, test, expect } from 'vitest';
import type { AgentHarnessReport, CapabilityEntry, SkillDuplicatesView, SkillDuplicateCluster } from '@coderadius/shared-types';
import { buildSkillLibraryView, STATUS_ORDER } from '../../../packages/dashboard-ui/src/components/agent-harness/skill-library.model';

// validate-payload lives in ONE monorepo (microservices) across 3 services, with
// notification-service holding it in two harness dirs. The backend dedupes to one
// consumer per service; the frontend renders that 1:1 without the old index-zip
// bug (repos[] zipped with a separate teams[], mislabeling teams).
const VALIDATE_PAYLOAD: CapabilityEntry = {
    name: 'validate-payload',
    type: 'skill',
    description: 'Validate request payloads.',
    filePath: 'notification-service/.claude/skills/validate-payload/SKILL.md',
    repos: [{ name: 'microservices', url: null }],
    teams: ['team-checkout', 'team-payments'],
    capabilities: [],
    usageCount: 3,
    consumers: [
        { service: 'notification-service', repo: 'microservices', repoUrl: null, team: 'team-checkout' },
        { service: 'payment-service', repo: 'microservices', repoUrl: null, team: 'team-payments' },
        { service: 'pricing-service', repo: 'microservices', repoUrl: null, team: 'team-checkout' },
    ],
};

// A single-team skill that is NOT duplicated anywhere.
const RETRY_PAYMENT: CapabilityEntry = {
    name: 'retry-payment',
    type: 'skill',
    description: 'Retry failed 3DS payments.',
    filePath: 'order-service/.claude/skills/retry-payment/SKILL.md',
    repos: [{ name: 'microservices', url: null }],
    teams: ['team-checkout'],
    capabilities: [],
    usageCount: 1,
    consumers: [
        { service: 'order-service', repo: 'microservices', repoUrl: null, team: 'team-checkout' },
    ],
};

function mkMember(name: string, service: string, filePath: string) {
    return {
        configId: `${service}:${filePath}`, name, description: '', filePath, service,
        topics: [], technologies: [],
    };
}

// One duplicate cluster covering validate-payload across two services.
const VALIDATE_PAYLOAD_CLUSTER: SkillDuplicateCluster = {
    id: 'cluster-1',
    label: 'validate-payload',
    memberIds: ['notification-service:a', 'payment-service:b'],
    members: [
        mkMember('validate-payload', 'notification-service', 'notification-service/.claude/skills/validate-payload/SKILL.md'),
        mkMember('validate-payload', 'payment-service', 'payment-service/.claude/skills/validate-payload/SKILL.md'),
    ],
    size: 2,
    similarity: { min: 1, max: 1, avg: 1 },
    services: ['notification-service', 'payment-service'],
    topics: [],
    technologies: [],
};

function makeReport(catalog: CapabilityEntry[], clusters: SkillDuplicateCluster[] = []): AgentHarnessReport {
    const skillDuplicates: SkillDuplicatesView = {
        clusters, projection: [], threshold: 0.9, totalSkills: catalog.length, totalCrossRepoClusters: clusters.length,
    };
    return {
        matrix: [{ repoName: 'microservices', repoUrl: null, livenessCommits: 200 }],
        mcpCensus: [],
        duplicates: [],
        capabilityCoverage: [],
        catalog,
        semanticDuplicates: [],
        techBlindspots: [],
        skillRecommendations: [],
        teamAliasProposals: [],
        skillDuplicates,
    } as unknown as AgentHarnessReport;
}

describe('buildSkillLibraryView — status is binary (duplicate | unique)', () => {
    test('STATUS_ORDER is exactly the two real states', () => {
        expect(STATUS_ORDER).toEqual(['duplicate', 'unique']);
    });

    test('a skill in a cross-service duplicate cluster is "duplicate"', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD, RETRY_PAYMENT], [VALIDATE_PAYLOAD_CLUSTER]));
        const skill = view.skills.find(s => s.name === 'validate-payload')!;
        expect(skill.status).toBe('duplicate');
    });

    test('a skill with no duplicate is "unique" (NOT orphan/proposed/canonical)', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD, RETRY_PAYMENT], [VALIDATE_PAYLOAD_CLUSTER]));
        const skill = view.skills.find(s => s.name === 'retry-payment')!;
        expect(skill.status).toBe('unique');
        // Regression: the fake-lifecycle states are gone entirely.
        expect(['orphan', 'proposed', 'canonical']).not.toContain(skill.status as string);
    });

    test('stats expose only totalSkills + duplicated', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD, RETRY_PAYMENT], [VALIDATE_PAYLOAD_CLUSTER]));
        expect(view.stats).toEqual({ totalSkills: 2, duplicated: 1 });
    });

    test('with no clusters, every skill is unique and duplicated=0', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD, RETRY_PAYMENT], []));
        expect(view.skills.every(s => s.status === 'unique')).toBe(true);
        expect(view.stats.duplicated).toBe(0);
    });
});

describe('buildSkillLibraryView — consumers', () => {
    test('renders one consumer row per distinct service (no harness-dir duplicates)', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD]));
        const skill = view.skills.find(s => s.name === 'validate-payload')!;
        expect(skill.consumers.list.map(c => c.service)).toEqual([
            'notification-service',
            'payment-service',
            'pricing-service',
        ]);
        expect(skill.consumers.adopted).toBe(3);
    });

    test('pairs each service with its OWN team (regression: no index-zip mislabel)', () => {
        const view = buildSkillLibraryView(makeReport([VALIDATE_PAYLOAD]));
        const skill = view.skills.find(s => s.name === 'validate-payload')!;
        const byService = Object.fromEntries(skill.consumers.list.map(c => [c.service, c.team]));
        expect(byService['notification-service']).toBe('team-checkout');
        expect(byService['payment-service']).toBe('team-payments');
        expect(byService['pricing-service']).toBe('team-checkout');
    });
});
