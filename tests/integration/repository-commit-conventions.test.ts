import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { mergeRepositoriesBatch, mergeRepository } from '../../src/graph/mutations/code-graph.js';

/**
 * Regression test for COG-35 bug:
 *
 * `extractGitConventions()` was correctly invoked in `enrichRepo()`
 * (source-resolver.ts) but the `governance-scan.workflow.ts` mapping to
 * `RepositoryBatchItem` dropped the `gitConventions` field — so
 * `mergeRepositoriesBatch` always received `undefined` and the Cypher set
 * `commitTicketIdRate` / `commitConventionalRate` / `commitsScanned` to null.
 * This test pins the bug fix: when the workflow passes `gitConventions`
 * through, the three properties are persisted as expected.
 *
 * Additionally pins the rename (`gitTicketIdRate` → `commitTicketIdRate` etc.)
 * and the `coalesce()`-preserves semantics on subsequent runs that may have
 * empty extractor output (shallow clone).
 */
describe('Repository commit-convention persistence (COG-35 regression)', () => {
    const PFX = 'cr://test/commit-conventions/';
    const testRepoName = 'commit-conventions-test-repo';
    const testOrg = 'commit-conventions-test-org';

    async function wipe() {
        const s = getNeo4jSession();
        try {
            await s.run('MATCH (n:Repository) WHERE n.name = $n DETACH DELETE n', { n: testRepoName });
        } finally { await s.close(); }
    }

    async function readRepo(): Promise<Record<string, unknown> | null> {
        const s = getNeo4jSession();
        try {
            const r = await s.run(
                `MATCH (r:Repository {name: $n}) RETURN
                    r.commitTicketIdRate AS commitTicketIdRate,
                    r.commitConventionalRate AS commitConventionalRate,
                    r.commitsScanned AS commitsScanned`,
                { n: testRepoName },
            );
            if (r.records.length === 0) return null;
            const rec = r.records[0];
            return {
                commitTicketIdRate: rec.get('commitTicketIdRate'),
                commitConventionalRate: rec.get('commitConventionalRate'),
                commitsScanned: rec.get('commitsScanned'),
            };
        } finally { await s.close(); }
    }

    beforeAll(async () => { await initSchema(); });
    afterAll(async () => { await wipe(); await closeNeo4j(); });
    beforeEach(async () => { await wipe(); });

    it('mergeRepositoriesBatch persists gitConventions into commit* properties', async () => {
        await mergeRepositoriesBatch([{
            name: testRepoName,
            url: 'https://example.com/test/repo.git',
            commitHash: 'SHA_TEST',
            org: testOrg,
            gitConventions: {
                ticketIdRate: 0.5,
                conventionalCommitRate: 0.75,
                sampleSize: 4,
            },
        }]);

        const repo = await readRepo();
        expect(repo).not.toBeNull();
        expect(repo!.commitTicketIdRate).toBe(0.5);
        expect(repo!.commitConventionalRate).toBe(0.75);
        // commitsScanned comes back as Neo4j Integer or number depending on driver
        const scanned = repo!.commitsScanned;
        const scannedNum = typeof scanned === 'object' && scanned !== null && 'toNumber' in scanned
            ? (scanned as { toNumber: () => number }).toNumber()
            : (scanned as number);
        expect(scannedNum).toBe(4);
    });

    it('mergeRepository (single) persists gitConventions identically to batch', async () => {
        await mergeRepository(
            testRepoName,
            'https://example.com/test/repo.git',
            'SHA_TEST',
            testOrg,
            undefined,        // liveness
            undefined,        // branch
            undefined,        // defaultBranch
            undefined,        // coreBranches
            undefined,        // hostingPlatform
            { ticketIdRate: 1.0, conventionalCommitRate: 0.0, sampleSize: 10 },
        );

        const repo = await readRepo();
        expect(repo).not.toBeNull();
        expect(repo!.commitTicketIdRate).toBe(1.0);
        expect(repo!.commitConventionalRate).toBe(0.0);
        const scanned = repo!.commitsScanned;
        const scannedNum = typeof scanned === 'object' && scanned !== null && 'toNumber' in scanned
            ? (scanned as { toNumber: () => number }).toNumber()
            : (scanned as number);
        expect(scannedNum).toBe(10);
    });

    it('coalesce-preserves existing values on subsequent run with missing gitConventions', async () => {
        // First run: write real values
        await mergeRepositoriesBatch([{
            name: testRepoName,
            url: 'https://example.com/test/repo.git',
            commitHash: 'SHA_A',
            org: testOrg,
            gitConventions: { ticketIdRate: 0.9, conventionalCommitRate: 0.8, sampleSize: 50 },
        }]);

        // Second run: extractor failed (shallow clone) — gitConventions undefined
        await mergeRepositoriesBatch([{
            name: testRepoName,
            url: 'https://example.com/test/repo.git',
            commitHash: 'SHA_B',
            org: testOrg,
            gitConventions: undefined,
        }]);

        const repo = await readRepo();
        expect(repo!.commitTicketIdRate).toBe(0.9);
        expect(repo!.commitConventionalRate).toBe(0.8);
    });
});
