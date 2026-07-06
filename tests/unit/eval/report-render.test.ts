import { describe, it, expect } from 'vitest';
import { renderFieldReport } from '../../eval/scorers/report-render.js';
import type { EvalReport } from '../../eval/scorers/eval-scorer.js';

const ANSI_RE = new RegExp(String.raw`\[[0-9;]*m`, 'g');
const plain = (s: string) => s.replace(ANSI_RE, '');

const report: EvalReport = {
    fixture: 'acme-live-graph',
    timestamp: '2026-06-05T12:00:00.000Z',
    cliVersion: '0.0.0',
    llmModel: 'live-graph',
    nodeScores: [
        {
            category: 'MessageChannel',
            expectedCount: 4,
            actualCount: 9,
            truePositives: ['acme.orders.created', 'acme.shipping.dispatched'],
            falsePositives: ['cache_acl', 'cache_database', 'mailer', 'producer', 'docs', 'message', 'email.bus'],
            falseNegatives: ['ha.orders_normal', 'ha.orders_failed'],
            precision: 2 / 9,
            recall: 0.5,
        },
        {
            category: 'DataContainer',
            expectedCount: 2,
            actualCount: 2,
            truePositives: ['acme_orders', 'acme_payments'],
            falsePositives: [],
            falseNegatives: [],
            precision: 1,
            recall: 1,
        },
    ],
    edgeResult: { expectedCount: 0, foundCount: 0, missingEdges: [] },
    symbolScore: { expectedCount: 0, resolvedCount: 0, unresolvedDiKeys: [], missingPhysicalNames: [] },
    negativeViolations: [
        { category: 'MessageChannel', violatingName: 'cache_acl', matchType: 'exact' },
        { category: 'MessageChannel', violatingName: 'cache_database', matchType: 'exact' },
        { category: 'MessageChannel', violatingName: 'producer.metrics', matchType: 'pattern', matchedPattern: '^producer\\.' },
    ],
    aggregatePrecision: 0.5,
    aggregateRecall: 0.6,
    criticalRegressionCount: 3,
    advisorySkippedCount: 0,
};

describe('renderFieldReport', () => {
    const out = plain(renderFieldReport(report, { width: 100, uri: 'bolt://localhost:7687' }));

    it('never omits FP or FN names, regardless of count', () => {
        for (const name of ['cache_acl', 'cache_database', 'mailer', 'producer', 'docs', 'message', 'email.bus']) {
            expect(out).toContain(name);
        }
        for (const name of ['ha.orders_normal', 'ha.orders_failed']) {
            expect(out).toContain(name);
        }
        expect(out).not.toMatch(/omitted/i);
    });

    it('renders a per-label scoreboard with counts', () => {
        expect(out).toMatch(/MessageChannel\s*│\s*22\.2%\s*│\s*50\.0%\s*│\s*2\s*│\s*7\s*│\s*2/);
        expect(out).toMatch(/DataContainer\s*│\s*100\.0%\s*│\s*100\.0%\s*│\s*2\s*│\s*0\s*│\s*0/);
    });

    it('groups negative violations by label and match type, once', () => {
        expect(out).toMatch(/exact.*2/);
        expect(out).toMatch(/\^producer\\\..*1/);
        // The old duplicated "Regressions / Negatives" pair must not return.
        expect(out).not.toMatch(/Regressions:/);
    });

    it('hides the edges and symbols sections when nothing is asserted', () => {
        expect(out).not.toMatch(/Edges/);
        expect(out).not.toMatch(/Symbol/);
    });

    it('labels with zero errors get no FP/FN detail blocks', () => {
        const dcBlock = out.slice(out.indexOf('DataContainer', out.indexOf('FALSE')));
        expect(dcBlock).not.toMatch(/DataContainer \(/);
    });

    it('header carries fixture, date and target uri', () => {
        expect(out).toContain('acme-live-graph');
        expect(out).toContain('2026-06-05');
        expect(out).toContain('bolt://localhost:7687');
    });

    it('wraps long lists within the requested width', () => {
        for (const line of out.split('\n')) {
            expect(line.length).toBeLessThanOrEqual(100);
        }
    });
});
