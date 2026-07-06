import { describe, it, expect } from 'vitest';
import { formatFrameworkSignalContext } from '../../../../../src/ingestion/core/framework-signal-overlay.js';
import type { FrameworkSignal } from '../../../../../src/ingestion/core/languages/types.js';

function signal(overrides: Partial<FrameworkSignal>): FrameworkSignal {
    return {
        framework: 'TypeScript',
        kind: 'message-consumer',
        scope: 'class',
        ownerName: 'OrderConsumer',
        resolvedName: 'acme.orders.created',
        literalArgs: [],
        startLine: 1,
        endLine: 5,
        confidence: 0.8,
        metadata: {},
        ...overrides,
    };
}

describe('formatFrameworkSignalContext — raw decorator surfaced for LLM', () => {
    it('includes raw_decorator= when metadata.decoratorText is present', () => {
        const out = formatFrameworkSignalContext([
            signal({
                metadata: {
                    decoratorText: "@QueueConsumer({ queueName: 'acme.orders.created', concurrency: 4 })",
                    decorator: 'QueueConsumer',
                    capability: 'message-consumer',
                },
            }),
        ]);
        expect(out).toBeDefined();
        expect(out!).toContain('raw_decorator=');
        expect(out!).toContain('QueueConsumer');
        expect(out!).toContain('acme.orders.created');
    });

    it('truncates decorator text past 200 chars', () => {
        const longArgs = 'a'.repeat(500);
        const out = formatFrameworkSignalContext([
            signal({
                metadata: { decoratorText: `@Big('${longArgs}')` },
            }),
        ]);
        expect(out).toBeDefined();
        // Truncation marker present
        expect(out!).toContain('[truncated]');
        // The raw_decorator slice is capped: the section ending at "..." must not contain the full 500 chars
        const rawIdx = out!.indexOf('raw_decorator=');
        const slice = out!.slice(rawIdx, rawIdx + 260);
        expect(slice.length).toBeLessThanOrEqual(260);
    });

    it('does NOT duplicate decoratorText in the generic metadata bits', () => {
        const out = formatFrameworkSignalContext([
            signal({
                metadata: {
                    decoratorText: "@QueueConsumer('acme.orders')",
                    decorator: 'QueueConsumer',
                    capability: 'message-consumer',
                },
            }),
        ]);
        expect(out).toBeDefined();
        // raw_decorator appears once
        const occurrences = (out!.match(/raw_decorator=/g) ?? []).length;
        expect(occurrences).toBe(1);
        // The generic metadata block should NOT also list decoratorText=...
        expect(out!).not.toContain('decoratorText=');
    });

    it('omits raw_decorator when metadata has no decoratorText', () => {
        const out = formatFrameworkSignalContext([
            signal({ metadata: { decorator: 'Custom', capability: 'message-consumer' } }),
        ]);
        expect(out).toBeDefined();
        expect(out!).not.toContain('raw_decorator=');
    });

    it('returns undefined for empty input', () => {
        expect(formatFrameworkSignalContext([])).toBeUndefined();
    });

    it('scrubs sensitive key/value pairs before truncation (Gotcha #2)', () => {
        const out = formatFrameworkSignalContext([
            signal({
                metadata: {
                    decoratorText: "@QueueConsumer({ queueName: 'orders', password: 'super_secret_dev_pass', token: 'ghp_xxx' })",
                    decorator: 'QueueConsumer',
                },
            }),
        ]);
        expect(out).toBeDefined();
        expect(out!).not.toContain('super_secret_dev_pass');
        expect(out!).not.toContain('ghp_xxx');
        expect(out!).toContain('[REDACTED]');
        // Innocuous fields untouched
        expect(out!).toContain('orders');
    });
});
