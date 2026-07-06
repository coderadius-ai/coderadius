import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../../src/ai/workflows/sanitizer.js';
import type { UnifiedAnalysis } from '../../../../src/ai/agents/unified-analyzer.js';

const SOURCE = `<?php
class ReportAction {
    public function run($sm) {
        $svc = $sm->get('acme_report_service');
        $real = $sm->get('producer_handle');
        $real->publish('acme.report.created', []);
    }
}`;

function analysisWith(channels: string[]): UnifiedAnalysis {
    return {
        has_io: true,
        infrastructure: channels.map((name) => ({
            type: 'MessageChannel',
            name,
            operation: 'WRITES',
            technology: 'rabbitmq',
        })),
    } as unknown as UnifiedAnalysis;
}

const locatorPlugin = {
    recognizesServiceLocatorKey: (name: string, src: string) => {
        // Trivial stub mirroring the contract: only the pure-locator key matches.
        return name === 'acme_report_service' && src.includes(`get('acme_report_service')`);
    },
};

describe('sanitizer × service-locator evidence hook', () => {
    it('drops a channel whose name is a pure service-locator key', () => {
        const out = sanitizeAnalysis(analysisWith(['acme_report_service', 'acme.report.created']), {
            sourceCode: SOURCE,
            plugin: locatorPlugin,
        });
        const names = (out.infrastructure ?? []).map((i) => i.name);
        expect(names).not.toContain('acme_report_service');
        expect(names).toContain('acme.report.created');
    });

    it('without the hook (non-PHP plugin), nothing changes', () => {
        const out = sanitizeAnalysis(analysisWith(['acme_report_service']), {
            sourceCode: SOURCE,
            plugin: {},
        });
        expect((out.infrastructure ?? []).map((i) => i.name)).toContain('acme_report_service');
    });

    it('drops a Database container whose name is a pure locator key', () => {
        const analysis = {
            has_io: true,
            infrastructure: [{ type: 'Database', name: 'acme_report_service', operation: 'READS', technology: 'mysql' }],
        } as unknown as UnifiedAnalysis;
        const out = sanitizeAnalysis(analysis, { sourceCode: SOURCE, plugin: locatorPlugin });
        expect(out.infrastructure ?? []).toHaveLength(0);
    });
});

describe('sanitizer Database branch × shared name-safety (LLM provenance)', () => {
    const diHandlePlugin = {
        recognizesFrameworkDiHandle: (name: string, kind: 'channel' | 'container') =>
            kind === 'container' && name.startsWith('doctrine.'),
    };

    it('drops SQL fragments and spaced names with NO plugin (agnostic guards)', async () => {
        const { sanitizeAnalysis } = await import('../../../../src/ai/workflows/sanitizer.js');
        const analysis = {
            has_io: true,
            infrastructure: [
                { type: 'Database', name: 'SELECT 1', operation: 'READS', technology: 'mysql' },
                { type: 'Database', name: 'from', operation: 'READS', technology: 'mysql' },
                { type: 'Database', name: 'acme_orders', operation: 'READS', technology: 'mysql' },
            ],
        } as never;
        const out = sanitizeAnalysis(analysis, {});
        const names = (out.infrastructure ?? []).map((i: { name: string }) => i.name);
        expect(names).toEqual(['acme_orders']);
    });

    it('drops framework DI ids only via the plugin hook (ecosystem grammar)', async () => {
        const { sanitizeAnalysis } = await import('../../../../src/ai/workflows/sanitizer.js');
        const analysis = () => ({
            has_io: true,
            infrastructure: [
                { type: 'Database', name: 'doctrine.entitymanager.orm_default', operation: 'READS', technology: 'mysql' },
                { type: 'Database', name: 'acme_orders', operation: 'READS', technology: 'mysql' },
            ],
        }) as never;
        const withPlugin = sanitizeAnalysis(analysis(), { plugin: diHandlePlugin });
        expect((withPlugin.infrastructure ?? []).map((i: { name: string }) => i.name))
            .toEqual(['acme_orders']);
        // Without the hook (e.g. a non-PHP ecosystem) the dotted name survives:
        // it could be a legitimate schema-qualified identifier there.
        const withoutPlugin = sanitizeAnalysis(analysis(), {});
        expect((withoutPlugin.infrastructure ?? []).map((i: { name: string }) => i.name))
            .toContain('doctrine.entitymanager.orm_default');
    });
});
