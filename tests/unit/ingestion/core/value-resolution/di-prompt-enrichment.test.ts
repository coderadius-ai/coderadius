// Integration unit test for Step 1 (plan v10 §C+§I):
// services.yaml → DiBindingResolver → SymbolRegistry → ValueResolutionIndex
// → formatResolvedInvocationContext output contains the boundComponent FQCN.
//
// Deterministic, no LLM. Pins the "prompt enrichment" delivery of Step 1.

import { describe, it, expect } from 'vitest';
import {
    ValueResolutionIndex,
    formatResolvedInvocationContext,
} from '../../../../../src/ingestion/core/value-resolution/index.js';
import { SymbolRegistry } from '../../../../../src/ingestion/core/symbol-registry.js';
import { SymfonyServicesYamlProvider } from '../../../../../src/ingestion/core/di-binding-providers/symfony-services-yaml.js';
import { DiBindingResolver } from '../../../../../src/ingestion/core/di-binding-resolver.js';
import type { CriticalInvocationFact } from '../../../../../src/ingestion/core/value-resolution/types.js';
import type { ComponentDefinition } from '../../../../../src/ingestion/core/languages/types.js';
import type { CodeChunk } from '../../../../../src/graph/types.js';

const SERVICES_YAML = `
services:
  _defaults:
    autowire: true
  acme.notification.publisher:
    class: Acme\\Messaging\\NotificationPublisher
`;

function makeInvocation(over: Partial<CriticalInvocationFact> = {}): CriticalInvocationFact {
    return {
        filePath: 'src/Controller/OrderController.php',
        language: 'php',
        callee: '$this->container->get',
        resourceExpression: 'acme.notification.publisher',
        resourceRole: 'serviceId',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        confidence: 0.25,
        startLine: 50,
        endLine: 50,
        chainedMethod: 'publish',
        ...over,
    };
}

function makeChunk(over: Partial<CodeChunk> = {}): CodeChunk {
    return {
        name: 'placeOrder',
        filepath: 'src/Controller/OrderController.php',
        language: 'php',
        startLine: 1,
        endLine: 200,
        sourceCode: "$this->container->get('acme.notification.publisher')->publish($event);",
        ...over,
    } as CodeChunk;
}

function makeComponent(): ComponentDefinition {
    return {
        fqcn: 'Acme\\Messaging\\NotificationPublisher',
        file: 'src/Messaging/NotificationPublisher.php',
        operations: [
            { name: 'publish', range: { startLine: 14, endLine: 30 } },
        ],
        declaredInterfaces: [],
    };
}

describe('Step 1 prompt enrichment end-to-end', () => {
    it("formatResolvedInvocationContext surfaces the bound FQCN when a Symfony YAML binding matches the invocation's serviceId", () => {
        // 1. Parse services.yaml
        const yamlProvider = new SymfonyServicesYamlProvider();
        const rawBindings = yamlProvider.extractDiBindings(SERVICES_YAML, {
            relativePath: 'config/services.yaml',
            repoRoot: '/tmp/acme',
            repoName: 'acme',
        });
        expect(rawBindings).toHaveLength(1);

        // 2. Populate registry via resolver
        const registry = new SymbolRegistry();
        const resolver = new DiBindingResolver();
        resolver.resolveAll({
            rawBindings,
            componentDefinitions: [makeComponent()],
            dependencyRequirements: [],
            symbolRegistry: registry,
        });
        // The binding is class-only (no physicalName). Sanitizer-facing
        // resolve() must drop it.
        expect(registry.resolve('acme.notification.publisher')).toBeNull();
        // The internal map must hold it.
        expect(registry.getAll().some(b =>
            b.key === 'acme.notification.publisher'
            && b.boundComponent === 'Acme\\Messaging\\NotificationPublisher',
        )).toBe(true);

        // 3. Resolve invocation in 'full' mode through VRI
        const invocation = makeInvocation();
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            registry,
        );
        const resolved = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'full' },
        );
        expect(resolved).toHaveLength(1);
        // Note: diBinding is populated only when the registry has matching
        // ioTags for the chainedMethod (Step 2 populates ioTags). Step 1
        // alone surfaces the bound class via a NEW resolveDi-driven path:
        // we expose `boundComponent` in the prompt even when ioTags is
        // empty IF the resolver registered the binding. Adjust the assertion
        // to verify the binding was registered + the FQCN is reachable.
        // For Step 1 the trace line surfaces only if resolveDi succeeds; in
        // pure Step 1 (no ioTags yet) the line is absent. We assert THAT.
        // The output is still useful: when the propagator (Step 2) adds
        // ioTags, the line appears automatically.
        const block = formatResolvedInvocationContext(resolved);
        expect(block).toBeDefined();
        expect(block).toContain('resource: serviceId');
        // Plan v10 §C Step 1 enrichment: even with empty ioTags the
        // lookup fallback surfaces boundComponent so the LLM sees the
        // resolved FQCN. (Previously this test asserted absence, which
        // contradicted the plan — fixed under finding P1 #6.)
        expect(block).toContain('boundComponent: Acme\\Messaging\\NotificationPublisher');
    });

    it('surfaces boundComponent + chainedMethod once the registry has matching ioTags (simulates Step 2)', () => {
        // Manually pre-populate ioTags as if the propagator had run.
        const registry = new SymbolRegistry();
        registry.register({
            key: 'acme.notification.publisher',
            value: 'Acme\\Messaging\\NotificationPublisher',
            category: 'di_service',
            sourceFile: 'config/services.yaml',
            confidence: 'static',
            boundComponent: 'Acme\\Messaging\\NotificationPublisher',
            ioTags: [{
                method: 'publish',
                resourceType: 'MessageChannel',
                operation: 'WRITES',
                channelName: 'acme.notifications',
                channelKind: 'topic',
                quality: 'high',
                hopCount: 1,
                viaFiles: ['src/Messaging/NotificationPublisher.php'],
                evidenceSource: {
                    filePath: 'src/Messaging/NotificationPublisher.php',
                    sourceSlice: '$this->bus->dispatch(new OrderCreated($order));',
                },
            }],
        });

        const invocation = makeInvocation();
        const index = new ValueResolutionIndex(
            [{
                filePath: invocation.filePath,
                valueFacts: [],
                criticalInvocations: [invocation],
            }],
            [],
            registry,
        );
        const resolved = index.resolveInvocationsForChunk(
            invocation.filePath,
            makeChunk(),
            { mode: 'full' },
        );
        const block = formatResolvedInvocationContext(resolved);
        expect(block).toContain('boundComponent: Acme\\Messaging\\NotificationPublisher');
        expect(block).toContain('chainedMethod: publish');
    });
});
