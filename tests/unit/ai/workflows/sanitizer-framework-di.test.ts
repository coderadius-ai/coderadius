import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../../src/ai/workflows/sanitizer.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import type { UnifiedAnalysis } from '../../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// Sanitizer × framework DI-handle hook (MessageChannel branch)
//
// The framework DI grammar (Symfony doctrine.*/messenger.* namespaces,
// Laminas RabbitMqModule aliases, Messenger *_transport handles) is owned by
// the LANGUAGE PLUGIN, never by the agnostic name-safety module. Two pins:
//
//   1. With the PHP plugin, those shapes are dropped EVEN IF a resolver
//      stamped resolved_via (a DI-shaped name was not resolved to a
//      physical name).
//   2. WITHOUT the hook (any other ecosystem), the same names survive:
//      a Node.js service may legitimately own a Kafka topic named
//      `messenger.events.dispatched`.
// ═════════════════════════════════════════════════════════════════════════════

function channelAnalysis(names: string[], resolvedVia?: string): UnifiedAnalysis {
    return {
        has_io: true,
        infrastructure: names.map((name) => ({
            type: 'MessageChannel',
            name,
            operation: 'WRITES',
            technology: 'rabbitmq',
            ...(resolvedVia ? { resolved_via: resolvedVia } : {}),
        })),
    } as unknown as UnifiedAnalysis;
}

const php = new PHPPlugin();

describe('sanitizer MessageChannel branch × framework DI-handle hook', () => {
    it.each([
        'doctrine.entitymanager.orm_default',
        'messenger.bus.command',
        'rabbitmq.producer.calls',
        'rabbitmq.consumer.import_shipments',
        'email_direct_transport',
    ])('drops %s with the PHP plugin', (name) => {
        const out = sanitizeAnalysis(channelAnalysis([name, 'acme.order.created']), { plugin: php });
        const names = (out.infrastructure ?? []).map((i) => i.name);
        expect(names).not.toContain(name);
        expect(names).toContain('acme.order.created');
    });

    it('drop survives the resolved-trust bypass (resolved_via stamped, shape still DI)', () => {
        const out = sanitizeAnalysis(
            channelAnalysis(['rabbitmq.producer.calls'], 'di_registry'),
            { plugin: php },
        );
        expect(out.infrastructure ?? []).toHaveLength(0);
    });

    it('without the hook, the same shapes SURVIVE (other ecosystems own these names)', () => {
        const out = sanitizeAnalysis(
            channelAnalysis(['messenger.events.dispatched', 'cache.invalidation']),
            { plugin: {} },
        );
        const names = (out.infrastructure ?? []).map((i) => i.name);
        expect(names).toContain('messenger.events.dispatched');
        expect(names).toContain('cache.invalidation');
    });
});
