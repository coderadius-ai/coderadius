import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the Neo4j runner ────────────────────────────────────────────────────
const mockRun = vi.fn();
vi.mock('../../../src/graph/mutations/_run.js', () => ({
    run: (...args: any[]) => mockRun(...args),
    groundingParams: () => ({}),
    groundingWriteClause: () => '',
}));

// ── Mock the URN helpers (not used by reclassify but imported by the module) ─
vi.mock('../../../src/graph/urn.js', () => ({
    buildUrn: vi.fn((...parts: string[]) => `cr:${parts.join(':')}`),
    urnPrefix: vi.fn(),
    GQL_SUBSCRIPTION_METHOD: 'SUBSCRIPTION',
}));

import { reclassifyConsumedAPIs } from '../../../src/graph/mutations/api-contracts.js';

describe('reclassifyConsumedAPIs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return empty when no services have IMPLEMENTS_ENDPOINT edges (guard fires)', async () => {
        // Guard query returns no eligible services
        mockRun.mockResolvedValueOnce({ records: [] });

        const result = await reclassifyConsumedAPIs('abc123');

        expect(result).toEqual([]);
        // Should have called run exactly once (guard query only)
        expect(mockRun).toHaveBeenCalledTimes(1);
        // Verify the guard query searches for IMPLEMENTS_ENDPOINT
        expect(mockRun.mock.calls[0][0]).toContain('IMPLEMENTS_ENDPOINT');
    });

    it('should reclassify unimplemented specs as CONSUMES_API', async () => {
        // Guard query returns one eligible service
        mockRun.mockResolvedValueOnce({
            records: [{ get: (key: string) => 'cr:service:acme:adapter' }],
        });

        // Reclassification query for that service finds 2 consumed specs
        mockRun.mockResolvedValueOnce({
            records: [
                {
                    get: (key: string) => {
                        const data: Record<string, string> = {
                            service: 'adapter-service',
                            apiTitle: 'Stripe API',
                            apiUrn: 'cr:api:stripe',
                        };
                        return data[key];
                    },
                },
                {
                    get: (key: string) => {
                        const data: Record<string, string> = {
                            service: 'adapter-service',
                            apiTitle: 'PayPal API',
                            apiUrn: 'cr:api:paypal',
                        };
                        return data[key];
                    },
                },
            ],
        });

        const result = await reclassifyConsumedAPIs('abc123');

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            service: 'adapter-service',
            apiTitle: 'Stripe API',
            apiUrn: 'cr:api:stripe',
        });
        expect(result[1]).toEqual({
            service: 'adapter-service',
            apiTitle: 'PayPal API',
            apiUrn: 'cr:api:paypal',
        });

        // Verify the reclassification query deletes EXPOSES_API and creates CONSUMES_API
        const reclassifyQuery = mockRun.mock.calls[1][0];
        expect(reclassifyQuery).toContain('DELETE exposed');
        expect(reclassifyQuery).toContain('CONSUMES_API');
        expect(reclassifyQuery).toContain('implementedCount = 0');
        // Genuine-implementation signal: same-service ownership + a code→contract
        // rewire flag (rejects matchmaker-fuzzy edges and cross-service bleed).
        expect(reclassifyQuery).toContain('(s)-[:CONTAINS]->(f:Function)');
        expect(reclassifyQuery).toContain('impl.rewired = true');
        expect(reclassifyQuery).toContain('impl.rewired_from_code = true');
    });

    it('should skip code-inferred APIInterfaces (source = code)', async () => {
        // Guard query returns one eligible service
        mockRun.mockResolvedValueOnce({
            records: [{ get: (key: string) => 'cr:service:acme:api' }],
        });

        // Reclassification query finds nothing (code-inferred APIs are excluded by the filter)
        mockRun.mockResolvedValueOnce({ records: [] });

        const result = await reclassifyConsumedAPIs('abc123');

        expect(result).toEqual([]);
        // Verify the query filters out source='code'
        const reclassifyQuery = mockRun.mock.calls[1][0];
        expect(reclassifyQuery).toContain("api.apiSource <> 'code'");
    });

    it('should process multiple eligible services independently', async () => {
        // Guard query returns two eligible services
        mockRun.mockResolvedValueOnce({
            records: [
                { get: (key: string) => 'cr:service:acme:adapter' },
                { get: (key: string) => 'cr:service:acme:gateway' },
            ],
        });

        // First service: 1 consumed spec
        mockRun.mockResolvedValueOnce({
            records: [{
                get: (key: string) => {
                    const data: Record<string, string> = {
                        service: 'adapter-service',
                        apiTitle: 'Stripe API',
                        apiUrn: 'cr:api:stripe',
                    };
                    return data[key];
                },
            }],
        });

        // Second service: no consumed specs
        mockRun.mockResolvedValueOnce({ records: [] });

        const result = await reclassifyConsumedAPIs('abc123');

        expect(result).toHaveLength(1);
        expect(result[0].apiTitle).toBe('Stripe API');
        // 1 guard query + 2 service queries
        expect(mockRun).toHaveBeenCalledTimes(3);
    });
});
