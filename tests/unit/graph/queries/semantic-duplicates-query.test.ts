import { describe, it, expect } from 'vitest';
import { buildSemanticDuplicatesQuery } from '../../../../src/graph/queries/semantic-duplicates-query.js';

describe('buildSemanticDuplicatesQuery', () => {
    it('returns a query with default parameters when no opts are supplied', () => {
        const { query, params } = buildSemanticDuplicatesQuery({});
        expect(params).toMatchObject({ threshold: 0.85, topK: 10 });
        expect(query).toContain('vector_search.search');
        expect(query).toContain('LIMIT 50');
        expect(query).not.toContain('$configType');
        // No cross-repo filter when not requested
        expect(query).not.toMatch(/split\(a\.id, ':'\)\[2\]\s*<>\s*split\(b\.id/);
    });

    it('injects configType filter when configType is supplied', () => {
        const { query, params } = buildSemanticDuplicatesQuery({ configType: 'skill' });
        expect(params.configType).toBe('skill');
        // Both endpoints of the pair must share configType
        expect(query).toContain('a.configType = $configType');
        expect(query).toContain('b.configType = $configType');
    });

    it('filters cross-repo pairs only when crossRepoOnly is set (by URN repo segment, NOT service)', () => {
        const { query } = buildSemanticDuplicatesQuery({ crossRepoOnly: true });
        expect(query).toMatch(/split\(a\.id, ':'\)\[2\]\s*<>\s*split\(b\.id, ':'\)\[2\]/);
        // Must NOT gate on service: intra-monorepo cross-service copies are not duplicates.
        expect(query).not.toMatch(/WHERE\s+serviceA\s*<>\s*serviceB/);
    });

    it('raises the limit when caller asks for more rows', () => {
        const { query } = buildSemanticDuplicatesQuery({ limit: 200 });
        expect(query).toContain('LIMIT 200');
    });

    it('combines all filters together', () => {
        const { query, params } = buildSemanticDuplicatesQuery({
            threshold: 0.9,
            topK: 20,
            configType: 'skill',
            crossRepoOnly: true,
            limit: 200,
        });
        expect(params).toMatchObject({ threshold: 0.9, topK: 20, configType: 'skill' });
        expect(query).toContain('a.configType = $configType');
        expect(query).toContain('b.configType = $configType');
        expect(query).toMatch(/split\(a\.id, ':'\)\[2\]\s*<>\s*split\(b\.id, ':'\)\[2\]/);
        expect(query).toContain('LIMIT 200');
    });

    it('emits the renamed scope enum: same-service / cross-service', () => {
        const { query } = buildSemanticDuplicatesQuery({});
        expect(query).toContain("'same-service'");
        expect(query).toContain("'cross-service'");
        // Legacy enum must not leak back in
        expect(query).not.toContain("'intra-team'");
        expect(query).not.toContain("'cross-team'");
    });

    it('resolves service via direct Service edge, direct Repository edge, and URN fallback', () => {
        const { query } = buildSemanticDuplicatesQuery({});
        // Three resolution paths for both endpoints of the pair.
        expect(query).toMatch(/HAS_AGENTIC_CONFIG\]-\(svcDirA:Service\)/);
        expect(query).toMatch(/HAS_AGENTIC_CONFIG\]-\(repoDirA:Repository\)/);
        expect(query).toMatch(/DEFINES\]-\(sfA\)<-\[:STORED_IN\|HAS_CONFIG\]-\(svcStoredA:Service\)/);
        // URN-derived repo segment must be in the coalesce chain so orphan
        // AgenticConfig nodes still group by repo.
        expect(query).toContain("split(a.id, ':')[2]");
        expect(query).toContain("split(b.id, ':')[2]");
    });
});
