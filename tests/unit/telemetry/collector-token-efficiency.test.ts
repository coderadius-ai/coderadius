/**
 * Unit Tests — Token-efficiency rows in the funnel report
 *
 *   - Cache Rate row = cachedTokens / inputTokens
 *   - Static Bypass row = staticBypasses vs live LLM invocations
 *   - the static path must NOT inflate llmInvocations
 */

import { describe, it, expect, beforeEach } from 'vitest';

let collector: any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(async () => {
    const mod = await import('../../../src/telemetry/collector.js');
    collector = mod.telemetryCollector;
    collector.reset();
});

describe('Token-efficiency funnel rows', () => {
    it('tracks staticBypasses independently of llmInvocations', () => {
        collector.incrementLLMInvocations();
        collector.incrementLLMInvocations();
        collector.incrementStaticBypass();
        collector.incrementStaticBypass();
        collector.incrementStaticBypass();

        const f = collector.getFunnel();
        expect(f.llmInvocations).toBe(2);
        expect(f.staticBypasses).toBe(3);
    });

    it('resets staticBypasses with the rest of the funnel', () => {
        collector.incrementStaticBypass();
        collector.reset();
        expect(collector.getFunnel().staticBypasses).toBe(0);
    });

    it('prints Cache Rate in the TOKEN USAGE section', () => {
        collector.incrementTotalFunctionsParsed(10);
        collector.addTokensForPhase('static_analysis', {
            promptTokens: 1_000_000,
            completionTokens: 30_000,
            cachedInputTokens: 270_000,
        });

        const report = stripAnsi(collector.generateFunnelReport());
        expect(report).toContain('Cache Rate');
        expect(report).toContain('27.0%');
    });

    it('prints Static Bypass with the share of resolved functions', () => {
        collector.incrementTotalFunctionsParsed(10);
        // 6 static + 2 live = 8 resolved → 75% bypass
        for (let i = 0; i < 6; i++) collector.incrementStaticBypass();
        collector.incrementLLMInvocations();
        collector.incrementLLMInvocations();

        const report = stripAnsi(collector.generateFunnelReport());
        expect(report).toContain('Static Bypass');
        expect(report).toContain('75.0%');
    });

    it('omits the Static Bypass row when no static resolution happened', () => {
        collector.incrementTotalFunctionsParsed(10);
        collector.incrementLLMInvocations();

        const report = stripAnsi(collector.generateFunnelReport());
        expect(report).not.toContain('Static Bypass');
    });
});
