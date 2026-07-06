import { describe, it, expect } from 'vitest';
import { ValueResolutionIndex } from '../../../../../src/ingestion/core/value-resolution/index.js';
import { SymbolRegistry, type DiIoTag } from '../../../../../src/ingestion/core/symbol-registry.js';
import type { CriticalInvocationFact } from '../../../../../src/ingestion/core/value-resolution/types.js';
import type { CodeChunk } from '../../../../../src/graph/types.js';

function makeInvocation(over: Partial<CriticalInvocationFact> = {}): CriticalInvocationFact {
    return {
        filePath: 'src/Consumer.php',
        language: 'php',
        callee: '$this->bus->dispatch',
        resourceExpression: 'message_bus.sender',
        resourceRole: 'serviceId',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        confidence: 0.95,
        startLine: 10,
        endLine: 10,
        chainedMethod: 'publish',
        ...over,
    };
}

function makeChunk(over: Partial<CodeChunk> = {}): CodeChunk {
    return {
        name: 'send',
        filepath: 'src/Consumer.php',
        language: 'php',
        startLine: 1,
        endLine: 50,
        sourceCode: '$this->bus->dispatch(new OrderCreated($order));',
        ...over,
    } as CodeChunk;
}

function makeIoTag(over: Partial<DiIoTag> = {}): DiIoTag {
    return {
        method: 'publish',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        channelName: 'orders.notifications',
        channelKind: 'topic',
        quality: 'high',
        hopCount: 1,
        viaFiles: ['src/NotificationPublisher.php'],
        evidenceSource: {
            filePath: 'src/NotificationPublisher.php',
            sourceSlice: '$this->bus->dispatch(new OrderCreated($order));',
        },
        ...over,
    };
}

describe('ValueResolutionIndex memo mode isolation (plan v10 §I)', () => {
    it("'value-only' mode does not populate diBinding", () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'message_bus.sender',
            value: 'App\\Messaging\\NotificationPublisher',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
            boundComponent: 'App\\Messaging\\NotificationPublisher',
            ioTags: [makeIoTag()],
        });

        const invocation = makeInvocation();
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            reg,
        );

        const resolved = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'value-only' },
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0].diBinding).toBeUndefined();
    });

    it("'full' mode populates diBinding when registry has the binding", () => {
        const reg = new SymbolRegistry();
        reg.register({
            key: 'message_bus.sender',
            value: 'App\\Messaging\\NotificationPublisher',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
            boundComponent: 'App\\Messaging\\NotificationPublisher',
            ioTags: [makeIoTag()],
        });

        const invocation = makeInvocation();
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            reg,
        );

        const resolved = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'full' },
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0].diBinding).toBeDefined();
        expect(resolved[0].diBinding!.boundComponent).toBe('App\\Messaging\\NotificationPublisher');
        expect(resolved[0].diBinding!.ioTags).toHaveLength(1);
        expect(resolved[0].diBinding!.ioTags[0].method).toBe('publish');
    });

    it("'value-only' result does NOT poison subsequent 'full' resolution", () => {
        // The crux of the plan v10 P0 fix: a 'value-only' resolution must
        // not write a `diBinding=undefined` entry into a shared memo cache
        // that a later 'full' resolution would read.
        const reg = new SymbolRegistry();
        reg.register({
            key: 'message_bus.sender',
            value: 'App\\Messaging\\NotificationPublisher',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
            boundComponent: 'App\\Messaging\\NotificationPublisher',
            ioTags: [makeIoTag()],
        });

        const invocation = makeInvocation();
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            reg,
        );

        // 1st pass: propagator-like resolution in 'value-only' mode.
        const firstPass = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'value-only' },
        );
        expect(firstPass[0].diBinding).toBeUndefined();

        // 2nd pass: standard pipeline resolution in 'full' mode.
        // The memo cache MUST not return the 'value-only' result.
        const secondPass = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'full' },
        );
        expect(secondPass[0].diBinding).toBeDefined();
        expect(secondPass[0].diBinding!.boundComponent).toBe('App\\Messaging\\NotificationPublisher');
    });

    it("'full' mode without chainedMethod uses Step-1 prompt-enrichment fallback", () => {
        // Plan v10 §C P1 fix #6: when chainedMethod is unknown, resolveDi
        // returns null (ambiguity guard for the bypass), but the prompt
        // enrichment still surfaces boundComponent so the LLM sees the
        // resolved FQCN. The resulting diBinding has ioTags=[] which the
        // bypass invariant treats as LLM-fallback territory.
        const reg = new SymbolRegistry();
        reg.register({
            key: 'message_bus.sender',
            value: 'App\\Messaging\\NotificationPublisher',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
            boundComponent: 'App\\Messaging\\NotificationPublisher',
            ioTags: [makeIoTag()],
        });

        const invocation = makeInvocation({ chainedMethod: undefined });
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            reg,
        );

        const resolved = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'full' },
        );
        // Fallback: diBinding populated with boundComponent, ioTags=[].
        expect(resolved[0].diBinding).toBeDefined();
        expect(resolved[0].diBinding!.boundComponent)
            .toBe('App\\Messaging\\NotificationPublisher');
        expect(resolved[0].diBinding!.ioTags).toHaveLength(0);
    });
});
