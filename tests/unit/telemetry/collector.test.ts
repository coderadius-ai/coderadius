/**
 * Unit Tests — TelemetryCollector
 *
 * Tests the telemetry funnel tracking system:
 *   - Counter increments
 *   - Token-based cost estimation with model pricing
 *   - Report generation
 *   - JSON export
 *   - Reset functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';

let collector: any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

beforeEach(async () => {
    const mod = await import('../../../src/telemetry/collector.js');
    collector = mod.telemetryCollector;
    collector.reset();
});

describe('TelemetryCollector', () => {

    // ═════════════════════════════════════════════════════════════════════════
    // 1. Counter Increments
    // ═════════════════════════════════════════════════════════════════════════

    describe('Funnel Counters', () => {
        it('should track totalFunctionsParsed', () => {
            collector.incrementTotalFunctionsParsed(100);
            collector.incrementTotalFunctionsParsed(50);
            expect(collector.getFunnel().totalFunctionsParsed).toBe(150);
        });

        it('should track droppedUntainted', () => {
            collector.incrementDroppedUntainted(80);
            expect(collector.getFunnel().droppedUntainted).toBe(80);
        });

        it('should track passedGate1/2/3/4/5/6 independently', () => {
            collector.incrementPassedGate(1);
            collector.incrementPassedGate(1);
            collector.incrementPassedGate(2);
            collector.incrementPassedGate(3);
            collector.incrementPassedGate(3);
            collector.incrementPassedGate(3);
            collector.incrementPassedGate(4);
            collector.incrementPassedGate(5);
            collector.incrementPassedGate(6);

            const f = collector.getFunnel();
            expect(f.passedGate1).toBe(2);
            expect(f.passedGate2).toBe(1);
            expect(f.passedGate3).toBe(3);
            expect(f.passedGate4).toBe(1);
            expect(f.passedGate5).toBe(1);
            expect(f.passedGate6).toBe(1);
        });

        it('should track droppedAllGates', () => {
            collector.incrementDroppedAllGates();
            collector.incrementDroppedAllGates();
            expect(collector.getFunnel().droppedAllGates).toBe(2);
        });

        it('should track cacheHits and fileCacheHits', () => {
            collector.incrementCacheHits(10);
            collector.incrementCacheHits(5);
            collector.incrementFileCacheHits(28);
            collector.incrementFileCacheHits(3);

            const f = collector.getFunnel();
            expect(f.cacheHits).toBe(15);
            expect(f.fileCacheHits).toBe(31);
        });

        it('should track llmInvocations and llmRejections', () => {
            collector.incrementLLMInvocations();
            collector.incrementLLMInvocations();
            collector.incrementLLMInvocations();
            collector.incrementLLMRejections();

            const f = collector.getFunnel();
            expect(f.llmInvocations).toBe(3);
            expect(f.llmRejections).toBe(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 2. Legacy MetricsCollector Compat
    // ═════════════════════════════════════════════════════════════════════════

    describe('Legacy MetricsCollector Methods', () => {
        it('should track files processed and skipped', () => {
            collector.incrementFilesProcessed();
            collector.incrementFilesProcessed();
            collector.incrementFilesSkipped(3);

            const report = collector.getReport();
            expect(report.counts.filesProcessed).toBe(2);
            expect(report.counts.filesSkipped).toBe(3);
        });

        it('should track functions ingested/skipped/unchanged', () => {
            collector.incrementFunctionsIngested();
            collector.incrementFunctionsSkipped();
            collector.incrementFunctionsUnchanged(5);

            const report = collector.getReport();
            expect(report.counts.functionsIngested).toBe(1);
            expect(report.counts.functionsSkipped).toBe(1);
            expect(report.counts.functionsUnchanged).toBe(5);
        });

        it('should track errors with messages', () => {
            collector.incrementErrors('Error 1');
            collector.incrementErrors('Error 2');

            const report = collector.getReport();
            expect(report.counts.errors).toBe(2);
            expect(report.errors).toEqual(['Error 1', 'Error 2']);
        });

        it('should track token usage in funnel', () => {
            collector.addTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
            collector.addTokens({ promptTokens: 200, completionTokens: 80, totalTokens: 280 });

            const f = collector.getFunnel();
            expect(f.inputTokens).toBe(300);
            expect(f.outputTokens).toBe(130);
            expect(f.totalTokens).toBe(430);
        });

        it('should derive total token usage when providers omit totalTokens', () => {
            collector.addTokens({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 25 });
            collector.addTokensForPhase('symbol_extraction', { inputTokens: 200, outputTokens: 80, cachedInputTokens: 40 });

            const f = collector.getFunnel();
            expect(f.inputTokens).toBe(300);
            expect(f.outputTokens).toBe(130);
            expect(f.totalTokens).toBe(430);
            expect(f.cachedTokens).toBe(65);
            expect(f.phaseTokens.symbol_extraction.cachedTokens).toBe(40);
        });

        it('should track timing', () => {
            collector.addParsingTime(100);
            collector.addLLMTime(500);

            const report = collector.getReport();
            expect(report.timings.parsing).toBe(100);
            expect(report.timings.llm).toBe(500);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Token-Based Cost Estimation
    // ═════════════════════════════════════════════════════════════════════════

    describe('Token-Based Cost Estimation', () => {
        it('should calculate cost from token counts for known models', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            // gemini-3.1-flash-lite: $0.25/1M input, $1.5/1M output
            collector.addTokens({ inputTokens: 94316, outputTokens: 6226, totalTokens: 100542 });
            // 1 invocation for accounting
            collector.incrementLLMInvocations();
            collector.incrementPassedGate(1);

            const cost = collector.estimateCost();

            // Cost = (94316 * 0.25 / 1M) + (6226 * 1.5 / 1M)
            //      = 0.023579 + 0.009339 = 0.032918
            expect(cost.totalCost).toBeCloseTo(0.032918, 5);
            expect(cost.modelLabel).toBe('Gemini 3.1 Flash Lite');
            expect(cost.inputPricePer1M).toBe(0.25);
            expect(cost.outputPricePer1M).toBe(1.5);
        });

        it('should prefix-match versioned model names', () => {
            collector.setModel('vertex', 'gemini-2.0-flash-001');
            collector.addTokens({ inputTokens: 1000000, outputTokens: 100000, totalTokens: 1100000 });
            collector.incrementLLMInvocations();
            collector.incrementPassedGate(1);

            const cost = collector.estimateCost();
            expect(cost.modelLabel).toBe('Gemini 2.0 Flash');
            // 1M input * $0.10/1M + 100K output * $0.40/1M = $0.10 + $0.04 = $0.14
            expect(cost.totalCost).toBeCloseTo(0.14, 2);
        });

        it('should return zero cost for unknown models', () => {
            collector.setModel('custom', 'my-fine-tuned-llm');
            collector.addTokens({ inputTokens: 50000, outputTokens: 5000, totalTokens: 55000 });
            collector.incrementLLMInvocations();

            const cost = collector.estimateCost();
            expect(cost.totalCost).toBe(0);
            expect(cost.modelLabel).toBe('custom/my-fine-tuned-llm');
        });

        it('should allow manual price override', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            collector.addTokens({ inputTokens: 100000, outputTokens: 10000, totalTokens: 110000 });
            collector.incrementLLMInvocations();
            collector.incrementPassedGate(1);

            const cost = collector.estimateCost({
                inputPricePer1M: 3.0,
                outputPricePer1M: 15.0,
                modelLabel: 'Claude 3.5 Sonnet',
            });

            expect(cost.modelLabel).toBe('Claude 3.5 Sonnet');
            // 100K * 3.0/1M + 10K * 15.0/1M = $0.30 + $0.15 = $0.45
            expect(cost.totalCost).toBeCloseTo(0.45, 2);
        });

        it('should correctly calculate total cost from tokens', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            // Simulate: 62 survivors, 50 cache hits, 12 actual invocations
            for (let i = 0; i < 50; i++) collector.incrementPassedGate(1);
            for (let i = 0; i < 10; i++) collector.incrementPassedGate(2);
            for (let i = 0; i < 2; i++) collector.incrementPassedGate(3);
            collector.incrementCacheHits(50);
            for (let i = 0; i < 12; i++) collector.incrementLLMInvocations();
            collector.addTokens({ inputTokens: 18000, outputTokens: 1200, totalTokens: 19200 });

            const cost = collector.estimateCost();

            // Cost = tokens this run
            const expectedCost = (18000 * 0.25 / 1_000_000) + (1200 * 1.5 / 1_000_000);
            expect(cost.totalCost).toBeCloseTo(expectedCost, 6);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Report Generation
    // ═════════════════════════════════════════════════════════════════════════

    describe('Report Generation', () => {
        it('should generate a unified report with PERFORMANCE, FUNNEL, and ECONOMICS', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            collector.incrementTotalFunctionsParsed(159);
            collector.incrementDroppedUntainted(80);
            collector.incrementDroppedAllGates(17);
            for (let i = 0; i < 57; i++) collector.incrementPassedGate(1);
            for (let i = 0; i < 4; i++) collector.incrementPassedGate(2);
            collector.incrementPassedGate(3);
            collector.incrementFileCacheHits(22);
            for (let i = 0; i < 47; i++) collector.incrementLLMInvocations();
            collector.addTokens({ inputTokens: 94316, outputTokens: 6226, totalTokens: 100542 });

            const report = collector.generateFunnelReport();

            // Contains NO emojis
            expect(report).not.toMatch(/[\u{1F680}\u{1F4B0}\u{2699}\u{23F1}]/u);
            // Contains sections
            expect(report).toContain('PERFORMANCE');
            expect(report).toContain('PIPELINE FUNNEL');
            expect(report).toContain('ECONOMICS');
            // Contains NO minus signs before numbers
            expect(report).not.toContain('-22');
            expect(report).not.toContain('-80');
            // Contains token data
            expect(report).toContain((94316).toLocaleString());
            // Contains model label
            expect(report).toContain('Gemini 3.1 Flash Lite');
        });

        it('should HIDE economics for unknown models', () => {
            collector.setModel('custom', 'my-fine-tuned-llm');
            collector.incrementTotalFunctionsParsed(10);
            collector.incrementLLMInvocations();

            const report = collector.generateFunnelReport();

            expect(report).not.toContain('ECONOMICS');
        });

        it('should handle zero functions without crashing', () => {
            const report = collector.generateFunnelReport();
            expect(report).toContain('Ingestion Report');
        });

        it('should show file cache hits only when > 0', () => {
            collector.incrementTotalFunctionsParsed(10);
            const report1 = collector.generateFunnelReport();
            expect(report1).not.toContain('File Cache Hits');

            collector.incrementFileCacheHits(5);
            const report2 = collector.generateFunnelReport();
            expect(report2).toContain('File Cache Hits');
        });

        it('should report rate-limit retries separately from structured-output retries', () => {
            collector.incrementTotalFunctionsParsed(1);
            collector.incrementRateLimitRetries(3);

            const report = stripAnsi(collector.generateFunnelReport());

            expect(report).toContain('Rate-limit Retries');
            expect(report).toContain('3 (429 quota backoff)');
            expect(report).not.toContain('LLM Retries');
        });

        it('should show errors in report if present', () => {
            collector.incrementErrors('Parse error in file.ts');

            const report = collector.generateFunnelReport();

            expect(report).toContain('Errors (1)');
            expect(report).toContain('Parse error in file.ts');
        });

        it('should align token breakdown columns for large phase values', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            collector.addTokensForPhase('infra_discovery', {
                inputTokens: 574,
                outputTokens: 11,
                totalTokens: 585,
            });
            collector.addTokensForPhase('static_analysis', {
                inputTokens: 8_076_000,
                outputTokens: 131_000,
                totalTokens: 8_207_000,
            });

            const report = stripAnsi(collector.generateFunnelReport());
            const headerLine = report.split('\n').find(line => line.includes('Phase'))!;
            const infraLine = report.split('\n').find(line => line.includes('Infra Discovery'))!;
            const staticLine = report.split('\n').find(line => line.includes('Static Analysis'))!;

            const fmt = (n: number) => n.toLocaleString();
            expect(headerLine.indexOf('Input') + 'Input'.length).toBe(infraLine.indexOf(fmt(574)) + fmt(574).length);
            expect(headerLine.indexOf('Input') + 'Input'.length).toBe(staticLine.indexOf(fmt(8_076_000)) + fmt(8_076_000).length);
            expect(headerLine.indexOf('Output') + 'Output'.length).toBe(infraLine.indexOf(fmt(11)) + fmt(11).length);
            expect(headerLine.indexOf('Output') + 'Output'.length).toBe(staticLine.indexOf(fmt(131_000)) + fmt(131_000).length);
            expect(staticLine).toContain(fmt(8_076_000));
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 5. JSON Export
    // ═════════════════════════════════════════════════════════════════════════

    describe('JSON Export', () => {
        it('should return complete TelemetryReport', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            collector.incrementTotalFunctionsParsed(10);
            collector.incrementPassedGate(1);
            collector.incrementLLMInvocations();
            collector.incrementFilesProcessed();

            const json = collector.toJSON();

            expect(json.funnel).toBeDefined();
            expect(json.funnel.totalFunctionsParsed).toBe(10);
            expect(json.funnel.fileCacheHits).toBe(0);
            expect(json.metrics).toBeDefined();
            expect(json.metrics.counts.filesProcessed).toBe(1);
            expect(json.cost).toBeDefined();
            expect(json.cost.modelLabel).toBe('Gemini 3.1 Flash Lite');
            expect(json.cost.inputPricePer1M).toBe(0.25);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // 6. Reset
    // ═════════════════════════════════════════════════════════════════════════

    describe('Reset', () => {
        it('should clear all counters and model', () => {
            collector.setModel('vertex', 'gemini-3.1-flash-lite');
            collector.incrementTotalFunctionsParsed(100);
            collector.incrementPassedGate(1);
            collector.incrementLLMInvocations();
            collector.incrementFileCacheHits(5);
            collector.incrementFilesProcessed();
            collector.incrementErrors('test');

            collector.reset();

            const f = collector.getFunnel();
            expect(f.totalFunctionsParsed).toBe(0);
            expect(f.passedGate2).toBe(0);
            expect(f.llmInvocations).toBe(0);
            expect(f.fileCacheHits).toBe(0);

            const r = collector.getReport();
            expect(r.counts.filesProcessed).toBe(0);
            expect(r.counts.errors).toBe(0);
            expect(r.errors).toEqual([]);

            const m = collector.getActiveModel();
            expect(m.provider).toBe('');
            expect(m.model).toBe('');
        });
    });
});
