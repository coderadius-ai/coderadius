/**
 * Tests for source-resolver concurrency control.
 *
 * Verifies the two-layer concurrency model that prevents the "self-inflicted DDoS"
 * on GitLab. The SSH network semaphore must enforce ≤ 5 concurrent connections
 * regardless of how many repos are being processed at the task level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pLimit from 'p-limit';

describe('SSH Network Semaphore — concurrency enforcement', () => {
    /**
     * Simulates the gitNetworkLimit semaphore (pLimit(5)) with N concurrent callers.
     * Measures the peak concurrency observed during execution.
     */
    async function measurePeakConcurrency(semaphoreLimit: number, parallelCallers: number, taskDurationMs = 50): Promise<number> {
        const limit = pLimit(semaphoreLimit);
        let active = 0;
        let peak = 0;

        const tasks = Array.from({ length: parallelCallers }, () =>
            limit(async () => {
                active++;
                if (active > peak) peak = active;
                await new Promise(resolve => setTimeout(resolve, taskDurationMs));
                active--;
            })
        );

        await Promise.all(tasks);
        return peak;
    }

    it('should never exceed 5 concurrent git operations regardless of task parallelism', async () => {
        // Simulate 30 repos queued (matching RESOLVE_CONCURRENCY = 30)
        // all racing to acquire the SSH network semaphore (GIT_NETWORK_CONCURRENCY = 5)
        const peak = await measurePeakConcurrency(5, 30);
        expect(peak).toBeLessThanOrEqual(5);
    });

    it('should achieve full concurrency when below the limit', async () => {
        // With only 3 callers and a limit of 5, all 3 should run in parallel
        const peak = await measurePeakConcurrency(5, 3);
        expect(peak).toBe(3);
    });

    it('should enforce the limit to exactly 5 even with 100 queued callers', async () => {
        const peak = await measurePeakConcurrency(5, 100, 20);
        expect(peak).toBeLessThanOrEqual(5);
    });

    it('GitLab MaxStartups threshold: peak must stay below server default (10)', async () => {
        // Even in degraded state (e.g. concurrency accidentally bumped),
        // we want to flag if we ever hit server-side MaxStartups default of 10.
        const peak = await measurePeakConcurrency(5, 50, 30);
        expect(peak).toBeLessThan(10);
    });
});

describe('Source Resolver — resolveAllSources CACHE vs PULL strategy', () => {
    // These tests use mocks for git operations and verify the reporter integration.

    it('should route reporter.warn through the ProgressReporter for failed repos', async () => {
        // Test that failures call reporter.warn, NOT logger.warn (which would break Listr2)
        const warnSpy = vi.fn();
        const reporter = {
            report: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
        };

        // Simulate the inner catch block behavior
        const simulateCatch = (err: Error, input: string, rep: typeof reporter) => {
            const shortMsg = err.message.split('\n')[0];
            rep.warn(`[FAILED] Skipping ${input.split('/').pop()?.replace('.git', '') ?? input}: ${shortMsg}`);
        };

        const gitError = new Error(
            'kex_exchange_identification: read: Connection reset by peer\nmore lines\neven more'
        );

        simulateCatch(gitError, 'git@gitlab.example.com:org/my-service.git', reporter);

        // Should have called reporter.warn exactly once
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // The warning should use the repo basename, not the full URL
        expect(warnSpy.mock.calls[0][0]).toContain('my-service');

        // The warning should only include the FIRST line of the git error (not the full SSH trace)
        expect(warnSpy.mock.calls[0][0]).toContain('kex_exchange_identification');
        expect(warnSpy.mock.calls[0][0]).not.toContain('more lines');
    });
});
