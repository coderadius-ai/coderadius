import { describe, it, expect, vi, beforeEach } from 'vitest';
import { countIdentityDrift, reconcileOwnership } from '../../../../src/ingestion/extractors/ownership-reconciler.js';

// Mock getMemgraphSession
vi.mock('../../../../src/graph/neo4j.js', () => {
    return {
        getMemgraphSession: vi.fn(),
    };
});

import { getMemgraphSession } from '../../../../src/graph/neo4j.js';

describe('Ownership Reconciler', () => {

    describe('countIdentityDrift', () => {
        it('should return false for exact matches (no drift, it is the same)', () => {
            expect(countIdentityDrift('squad-core', 'squad-core')).toBe(false);
            expect(countIdentityDrift('team-ui', 'team-ui')).toBe(false);
        });

        it('should detect substring drift', () => {
             // Substring inclusion
             expect(countIdentityDrift('backend', 'backend-team')).toBe(true);
             expect(countIdentityDrift('core', 'team-core')).toBe(true);
        });

        it('should handle case insensitivity', () => {
             expect(countIdentityDrift('Team-A', 'team-A-core')).toBe(true);
             expect(countIdentityDrift('Team-A', 'team-a-core')).toBe(true);
        });

        it('should detect minor typos with Levenshtein distance < 3', () => {
             expect(countIdentityDrift('team-mutui', 'team-mutu')).toBe(true); // distance 1
             expect(countIdentityDrift('squad-payment', 'squad-paymens')).toBe(true); // distance 2 
        });

        it('should ignore differences beyond Levenshtein distance 2', () => {
             expect(countIdentityDrift('squad-x', 'squad-yyyyy')).toBe(false); // distance 5
             expect(countIdentityDrift('frontend-team', 'backend-team')).toBe(false); // not substring, distance high (8)
        });

        it('should detect structural prefixes (team-, squad-, guild-, tribe-)', () => {
             expect(countIdentityDrift('team-mutui', 'squad-mutui')).toBe(true);
             expect(countIdentityDrift('guild-platform', 'tribe-platform')).toBe(true);
             expect(countIdentityDrift('squad-auth', 'auth')).toBe(true); // 'auth' is a substring of 'squad-auth' too, but also prefix strip
        });
        
        it('should return false for completely unrelated teams', () => {
             expect(countIdentityDrift('platform-infra', 'sales-tools')).toBe(false);
        });
    });

    describe('reconcileOwnership', () => {
        const mockRun = vi.fn();
        const mockClose = vi.fn();

        beforeEach(() => {
            vi.resetAllMocks();
            (getMemgraphSession as any).mockReturnValue({
                run: mockRun,
                close: mockClose,
            });
        });

        it('should return no discrepancies if graph is clean', async () => {
            mockRun.mockResolvedValue({ records: [] }); // Empty records for both queries
            
            const results = await reconcileOwnership();
            
            expect(results).toHaveLength(0);
            expect(mockRun).toHaveBeenCalledTimes(2); // One for orphans, one for conflicts
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('should identify orphan services', async () => {
            mockRun.mockImplementation(async (query: string) => {
                if (query.includes('NOT (:Team)-[:OWNS]')) {
                    return {
                        records: [
                            { get: (key: string) => key === 'serviceName' ? 'payment-gateway' : null }
                        ]
                    };
                }
                return { records: [] };
            });

            const results = await reconcileOwnership();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual({
                type: 'orphan_service',
                targetPathOrName: 'payment-gateway',
                details: 'Service has no OWNS edge from any source.',
            });
        });

        it('should identify conflicting ownership', async () => {
            mockRun.mockImplementation(async (query: string) => {
                if (query.includes('r1.source <> r2.source')) {
                    return {
                        records: [
                            {
                                get: (key: string) => {
                                    const data: any = {
                                        serviceName: 'auth-service',
                                        team1: 'team-backend',
                                        source1: 'backstage',
                                        team2: 'ops-squad',
                                        source2: 'codeowners'
                                    };
                                    return data[key];
                                }
                            }
                        ]
                    };
                }
                return { records: [] };
            });

            const results = await reconcileOwnership();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual({
                type: 'conflicting_ownership',
                targetPathOrName: 'auth-service',
                details: "Conflicting ownership claims: backstage claims 'team-backend', codeowners claims 'ops-squad'.",
            });
        });

        it('should classify conflict as identity_drift if heuristic matches', async () => {
            mockRun.mockImplementation(async (query: string) => {
                if (query.includes('r1.source <> r2.source')) {
                    return {
                        records: [
                            {
                                get: (key: string) => {
                                    const data: any = {
                                        serviceName: 'order-service',
                                        team1: 'team-orders',
                                        source1: 'backstage',
                                        team2: 'squad-orders',
                                        source2: 'codeowners'
                                    };
                                    return data[key];
                                }
                            }
                        ]
                    };
                }
                return { records: [] };
            });

            const results = await reconcileOwnership();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual({
                type: 'identity_drift',
                targetPathOrName: 'order-service',
                details: "Potential identity drift detected: backstage: 'team-orders', codeowners: 'squad-orders'.",
            });
        });

        it('should deduplicate bidirectional conflict records', async () => {
            // A query matching (t1)-[]->(s)<-[]-(t2) returns two rows for the same pair 
            // e.g., (A, B) and (B, A). Reconciler should filter one out.
            mockRun.mockImplementation(async (query: string) => {
                if (query.includes('r1.source <> r2.source')) {
                    return {
                        records: [
                            {
                                get: (key: string) => ({
                                        serviceName: 'inventory-svc',
                                        team1: 'team-backend', source1: 'backstage',
                                        team2: 'team-frontend', source2: 'codeowners'
                                    }[key] as any)
                            },
                            {
                                get: (key: string) => ({
                                        serviceName: 'inventory-svc',
                                        team1: 'team-frontend', source1: 'codeowners',
                                        team2: 'team-backend', source2: 'backstage'
                                    }[key] as any)
                            }
                        ]
                    };
                }
                return { records: [] };
            });

            const results = await reconcileOwnership();

            expect(results).toHaveLength(1); // Not 2!
            expect(results[0].type).toBe('conflicting_ownership');
            expect(results[0].targetPathOrName).toBe('inventory-svc');
        });

        it('should NOT identify a conflict when sources agree precisely on multiple co-owners', async () => {
            mockRun.mockImplementation(async (query: string) => {
                // If the old buggy query is used, it uses "t1.id <> t2.id AND r1.source <> r2.source"
                if (query.includes('t1.id <> t2.id') && query.includes('r1.source <> r2.source')) {
                    return {
                        records: [
                            {
                                get: (key: string) => ({
                                        serviceName: 'payment-api',
                                        team1: 'team-a', source1: 'backstage',
                                        team2: 'team-b', source2: 'codeowners'
                                    }[key] as any)
                            }
                        ]
                    };
                }
                // The new fixed query checks "AND NOT (t1)-[:OWNS {source: r2.source}]->(s)"
                // Return empty, because they properly co-own it in the graph.
                return { records: [] };
            });

            const results = await reconcileOwnership();

            expect(results).toHaveLength(0);
        });
    });
});
