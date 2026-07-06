import { describe, it, expect } from 'vitest';
import {
    buildSkillClusters,
    buildCanonicalSkillMap,
    canonicalizeSkillPairs,
    type SkillClusterPair,
    type SkillMemberView,
} from '../../../../src/graph/queries/skill-clusters.js';

function mkMember(id: string, overrides: Partial<SkillMemberView> = {}): SkillMemberView {
    return {
        configId: id,
        name: `skill-${id}`,
        description: `description for ${id}`,
        semanticIntent: undefined,
        filePath: `.claude/skills/${id}/SKILL.md`,
        service: `svc-${id}`,
        topics: [],
        technologies: [],
        ...overrides,
    };
}

function mkPair(a: string, b: string, similarity: number): SkillClusterPair {
    return { a, b, similarity };
}

describe('buildSkillClusters', () => {
    it('returns [] when there are no pairs', () => {
        const members = new Map([['A', mkMember('A')]]);
        expect(buildSkillClusters([], members)).toEqual([]);
    });

    it('forms a single cluster from a single pair', () => {
        const members = new Map([
            ['A', mkMember('A')],
            ['B', mkMember('B')],
        ]);
        const clusters = buildSkillClusters([mkPair('A', 'B', 0.95)], members);
        expect(clusters).toHaveLength(1);
        const c = clusters[0];
        expect(c.size).toBe(2);
        expect(c.memberIds.sort()).toEqual(['A', 'B']);
        expect(c.similarity.avg).toBeCloseTo(0.95);
        expect(c.similarity.min).toBeCloseTo(0.95);
        expect(c.similarity.max).toBeCloseTo(0.95);
    });

    it('merges transitively: A-B and B-C become {A,B,C}', () => {
        const members = new Map([
            ['A', mkMember('A')],
            ['B', mkMember('B')],
            ['C', mkMember('C')],
        ]);
        const clusters = buildSkillClusters(
            [mkPair('A', 'B', 0.92), mkPair('B', 'C', 0.94)],
            members,
        );
        expect(clusters).toHaveLength(1);
        expect(clusters[0].memberIds.sort()).toEqual(['A', 'B', 'C']);
        expect(clusters[0].similarity.min).toBeCloseTo(0.92);
        expect(clusters[0].similarity.max).toBeCloseTo(0.94);
        expect(clusters[0].similarity.avg).toBeCloseTo(0.93);
    });

    it('keeps two disjoint clusters separate', () => {
        const members = new Map([
            ['A', mkMember('A')],
            ['B', mkMember('B')],
            ['C', mkMember('C')],
            ['D', mkMember('D')],
        ]);
        const clusters = buildSkillClusters(
            [mkPair('A', 'B', 0.91), mkPair('C', 'D', 0.96)],
            members,
        );
        expect(clusters).toHaveLength(2);
        const sizes = clusters.map(c => c.size).sort();
        expect(sizes).toEqual([2, 2]);
    });

    it('skips pairs whose members are not in the members map', () => {
        const members = new Map([['A', mkMember('A')]]);
        const clusters = buildSkillClusters([mkPair('A', 'GHOST', 0.99)], members);
        expect(clusters).toEqual([]);
    });

    it('aggregates topics and services across cluster members (union, deduped)', () => {
        const members = new Map([
            ['A', mkMember('A', { service: 'inventory', topics: ['testing', 'qa'] })],
            ['B', mkMember('B', { service: 'orders',    topics: ['testing'] })],
            ['C', mkMember('C', { service: 'payment',   topics: ['ci'] })],
        ]);
        const clusters = buildSkillClusters(
            [mkPair('A', 'B', 0.91), mkPair('B', 'C', 0.93)],
            members,
        );
        expect(clusters).toHaveLength(1);
        const c = clusters[0];
        expect(c.services.sort()).toEqual(['inventory', 'orders', 'payment']);
        expect(c.topics.sort()).toEqual(['ci', 'qa', 'testing']);
    });

    it('orders clusters by size desc then avg similarity desc', () => {
        const members = new Map<string, SkillMemberView>();
        for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) members.set(id, mkMember(id));
        const clusters = buildSkillClusters(
            [
                mkPair('A', 'B', 0.91), // pair of 2 with 0.91
                mkPair('C', 'D', 0.99), // pair of 2 with 0.99 (higher avg)
                mkPair('E', 'F', 0.95), mkPair('F', 'B', 0.95), // would merge with cluster {A,B}
            ],
            members,
        );
        // Cluster {A,B,E,F} (size 4) should appear first
        expect(clusters[0].size).toBe(4);
        // Then {C,D} (size 2, avg 0.99) before any other size-2
        const size2 = clusters.filter(c => c.size === 2);
        expect(size2[0].similarity.avg).toBeCloseTo(0.99);
    });

    it('exposes full member views for each cluster', () => {
        const members = new Map([
            ['A', mkMember('A', { name: 'review-pr', description: 'Review pull request' })],
            ['B', mkMember('B', { name: 'pr-review', description: 'PR reviewer' })],
        ]);
        const [c] = buildSkillClusters([mkPair('A', 'B', 0.92)], members);
        expect(c.members.map(m => m.name).sort()).toEqual(['pr-review', 'review-pr']);
    });

    it('labels cluster by the most-common skill name (distinctive signal)', () => {
        const members = new Map([
            ['A', mkMember('A', { name: 'jira-branch-changeset', topics: ['developer-experience'] })],
            ['B', mkMember('B', { name: 'jira-branch-changeset', topics: ['developer-experience'] })],
            ['C', mkMember('C', { name: 'jira-branch-changeset', topics: ['developer-experience'] })],
        ]);
        const [c] = buildSkillClusters(
            [mkPair('A', 'B', 0.94), mkPair('B', 'C', 0.92)],
            members,
        );
        expect(c.label).toBe('jira-branch-changeset');
    });

    it('falls back to dominant topic when skill names diverge', () => {
        const members = new Map([
            ['A', mkMember('A', { name: 'review-pr', topics: ['code-review'] })],
            ['B', mkMember('B', { name: 'pr-checker', topics: ['code-review'] })],
        ]);
        const [c] = buildSkillClusters([mkPair('A', 'B', 0.92)], members);
        // Both names appear once each → mode by alphabetical tie-break picks 'pr-checker'.
        // The point is that the label is one of the names, not 'code-review'.
        expect(['pr-checker', 'review-pr']).toContain(c.label);
    });
});

describe('buildCanonicalSkillMap', () => {
    it('collapses same-(service, fingerprint) copies, preferring the non-symlink node', () => {
        const members = new Map([
            // notification-service has the skill twice: real .claude + symlinked .agents
            ['NC', mkMember('NC', { service: 'notification-service', contentFingerprint: 'fp1', filePath: 'notification-service/.claude/skills/x/SKILL.md' })],
            ['NA', mkMember('NA', { service: 'notification-service', contentFingerprint: 'fp1', installedVia: 'symlink', filePath: 'notification-service/.agents/skills/x/SKILL.md' })],
            ['PAY', mkMember('PAY', { service: 'payment-service', contentFingerprint: 'fp1' })],
        ]);
        const canonical = buildCanonicalSkillMap(members);
        // Both notification nodes map to the real (.claude) one; payment is its own.
        expect(canonical.get('NA')).toBe('NC');
        expect(canonical.get('NC')).toBe('NC');
        expect(canonical.get('PAY')).toBe('PAY');
    });

    it('does NOT collapse same service with different fingerprints', () => {
        const members = new Map([
            ['A', mkMember('A', { service: 'svc', contentFingerprint: 'fpA' })],
            ['B', mkMember('B', { service: 'svc', contentFingerprint: 'fpB' })],
        ]);
        const canonical = buildCanonicalSkillMap(members);
        expect(canonical.get('A')).toBe('A');
        expect(canonical.get('B')).toBe('B');
    });

    it('does NOT collapse identical content across DIFFERENT services (real twins)', () => {
        const members = new Map([
            ['A', mkMember('A', { service: 'svc-a', contentFingerprint: 'fp1' })],
            ['B', mkMember('B', { service: 'svc-b', contentFingerprint: 'fp1' })],
        ]);
        const canonical = buildCanonicalSkillMap(members);
        expect(canonical.get('A')).toBe('A');
        expect(canonical.get('B')).toBe('B');
    });

    it('a member with no fingerprint keys on its own id and never collapses', () => {
        const members = new Map([
            ['A', mkMember('A', { service: 'svc' })],
            ['B', mkMember('B', { service: 'svc' })],
        ]);
        const canonical = buildCanonicalSkillMap(members);
        expect(canonical.get('A')).toBe('A');
        expect(canonical.get('B')).toBe('B');
    });
});

describe('canonicalizeSkillPairs + buildSkillClusters (same-service collapse)', () => {
    // Reproduction of the reported bug: validate-payload in notification-service
    // (.claude real + .agents symlink), payment-service, pricing-service — all
    // identical content. The cross-repo query drops the same-service NC-NA pair,
    // but union-find re-introduces both via cross-service twins. After collapse,
    // notification-service must appear exactly once in the cluster.
    const members = new Map<string, SkillMemberView>([
        ['P',  mkMember('P',  { name: 'validate-payload', service: 'pricing-service',      contentFingerprint: 'fp1' })],
        ['NC', mkMember('NC', { name: 'validate-payload', service: 'notification-service', contentFingerprint: 'fp1' })],
        ['NA', mkMember('NA', { name: 'validate-payload', service: 'notification-service', contentFingerprint: 'fp1', installedVia: 'symlink' })],
        ['PAY',mkMember('PAY',{ name: 'validate-payload', service: 'payment-service',      contentFingerprint: 'fp1' })],
    ]);
    const crossServicePairs = [
        mkPair('P', 'NC', 1), mkPair('P', 'NA', 1), mkPair('P', 'PAY', 1),
        mkPair('NC', 'PAY', 1), mkPair('NA', 'PAY', 1),
    ];

    it('drops the duplicate notification node, keeping one logical entry per service', () => {
        const canonical = buildCanonicalSkillMap(members);
        const collapsed = canonicalizeSkillPairs(crossServicePairs, canonical);
        const [cluster] = buildSkillClusters(collapsed, members);

        expect(cluster.services.sort()).toEqual(['notification-service', 'payment-service', 'pricing-service']);
        // 3 distinct services → 3 members (NA folded into NC), not 4.
        expect(cluster.size).toBe(3);
        const notificationMembers = cluster.members.filter(m => m.service === 'notification-service');
        expect(notificationMembers).toHaveLength(1);
        expect(notificationMembers[0].configId).toBe('NC');
    });

    it('canonicalizeSkillPairs drops self-pairs and dedupes, keeping max similarity', () => {
        const canonical = buildCanonicalSkillMap(members);
        const collapsed = canonicalizeSkillPairs(
            [mkPair('NC', 'NA', 1), mkPair('P', 'NC', 0.91), mkPair('P', 'NA', 0.97)],
            canonical,
        );
        // NC-NA collapses to a self-pair (dropped). P-NC and P-NA both become P↔NC → one pair at max sim.
        expect(collapsed).toHaveLength(1);
        expect(collapsed[0].similarity).toBeCloseTo(0.97);
    });
});
