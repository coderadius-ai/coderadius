import { describe, it, expect } from 'vitest';
import {
    DiIoPropagator,
    BASE_CONFIDENCE_BY_N_TAGS,
    HOP_DECAY,
    MIN_DI_STATIC_CONFIDENCE,
} from '../../../../src/ingestion/core/di-io-propagator.js';
import { ComponentIoIndex } from '../../../../src/ingestion/core/component-io-index.js';
import { SymbolRegistry } from '../../../../src/ingestion/core/symbol-registry.js';
import { ValueResolutionIndex } from '../../../../src/ingestion/core/value-resolution/index.js';
import type { ComponentDefinition } from '../../../../src/ingestion/core/languages/types.js';
import type { CriticalInvocationFact } from '../../../../src/ingestion/core/value-resolution/types.js';

function comp(over: Partial<ComponentDefinition> = {}): ComponentDefinition {
    return {
        fqcn: 'Acme\\NotificationPublisher',
        file: 'src/NotificationPublisher.php',
        operations: [
            { name: 'publish', range: { startLine: 10, endLine: 20 } },
        ],
        declaredInterfaces: [],
        ...over,
    };
}

function invocation(over: Partial<CriticalInvocationFact> = {}): CriticalInvocationFact {
    return {
        filePath: 'src/NotificationPublisher.php',
        language: 'php',
        callee: '$this->bus->publish',
        resourceExpression: '"acme.notifications"',
        resourceRole: 'topic',
        resourceType: 'MessageChannel',
        operation: 'WRITES',
        confidence: 1,
        startLine: 12,
        endLine: 12,
        ...over,
    };
}

function buildContext(opts: {
    components: ComponentDefinition[];
    invocationsByFile: Record<string, CriticalInvocationFact[]>;
    fileContents?: Record<string, string>;
    bindings: Array<{
        key: string;
        boundComponent: string;
        sourceFile?: string;
        sourceHash?: string;
    }>;
}) {
    const registry = new SymbolRegistry();
    for (const b of opts.bindings) {
        registry.register({
            key: b.key,
            value: b.boundComponent,
            category: 'di_service',
            sourceFile: b.sourceFile ?? 'config/services.yaml',
            sourceHash: b.sourceHash ?? 'h1',
            confidence: 'static',
            boundComponent: b.boundComponent,
        });
    }
    const inputs = Object.entries(opts.invocationsByFile).map(([filePath, invs]) => ({
        filePath,
        valueFacts: [],
        criticalInvocations: invs,
    }));
    const vri = new ValueResolutionIndex(inputs, [], registry);
    const fileContents = new Map(Object.entries(opts.fileContents ?? {}));
    const componentIo = new ComponentIoIndex(opts.components, fileContents, vri);
    const propagator = new DiIoPropagator(registry, componentIo);
    return { registry, propagator };
}

describe('DiIoPropagator', () => {
    it('emits one ioTag for a hop-1 single-literal publish', () => {
        const { registry, propagator } = buildContext({
            components: [comp()],
            invocationsByFile: {
                'src/NotificationPublisher.php': [invocation()],
            },
            fileContents: {
                'src/NotificationPublisher.php':
                    'class NotificationPublisher {\n'
                    + 'function publish() {\n'
                    + '$this->bus->publish("acme.notifications");\n'
                    + '}\n}\n',
            },
            bindings: [{
                key: 'acme.notification.publisher',
                boundComponent: 'Acme\\NotificationPublisher',
            }],
        });

        const stats = propagator.propagateAll();
        expect(stats.bindingsWithIoTags).toBe(1);
        expect(stats.ioTagsEmitted).toBe(1);

        const binding = registry.getAll()[0];
        expect(binding.ioTags).toHaveLength(1);
        expect(binding.ioTags![0]).toMatchObject({
            method: 'publish',
            resourceType: 'MessageChannel',
            operation: 'WRITES',
            channelName: 'acme.notifications',
            hopCount: 1,
            quality: 'exact',  // score 0.97 → exact
        });
        expect(binding.bindingFingerprint).toBeDefined();
        expect(binding.viaFiles).toContain('src/NotificationPublisher.php');
    });

    it("emits no ioTag when the bound component has no operations", () => {
        const { registry, propagator } = buildContext({
            components: [comp({ operations: [] })],
            invocationsByFile: {},
            bindings: [{
                key: 'acme.publisher',
                boundComponent: 'Acme\\NotificationPublisher',
            }],
        });
        propagator.propagateAll();
        expect(registry.getAll()[0].ioTags).toBeUndefined();
    });

    it('drops N=4+ literals as God Object (score=0)', () => {
        const four = Array.from({ length: 4 }, (_, i) =>
            invocation({
                callee: `$this->bus->publish${i}`,
                resourceExpression: `"acme.ch${i}"`,
                startLine: 12 + i,
                endLine: 12 + i,
            }),
        );
        const { registry, propagator } = buildContext({
            components: [comp()],
            invocationsByFile: {
                'src/NotificationPublisher.php': four,
            },
            fileContents: {
                'src/NotificationPublisher.php': 'class X { function publish() {} }\n',
            },
            bindings: [{
                key: 'acme.publisher',
                boundComponent: 'Acme\\NotificationPublisher',
            }],
        });
        propagator.propagateAll();
        expect(registry.getAll()[0].ioTags).toBeUndefined();
    });

    it('honors cycle sentinel (A→B→A)', () => {
        const { registry, propagator } = buildContext({
            components: [
                comp({
                    fqcn: 'Acme\\A',
                    file: 'src/A.php',
                    operations: [{ name: 'go', range: { startLine: 1, endLine: 5 } }],
                }),
                comp({
                    fqcn: 'Acme\\B',
                    file: 'src/B.php',
                    operations: [{ name: 'go', range: { startLine: 1, endLine: 5 } }],
                }),
            ],
            invocationsByFile: {
                'src/A.php': [invocation({
                    filePath: 'src/A.php',
                    callee: '$this->b->go',
                    resourceExpression: 'b.svc',
                    resourceRole: 'serviceId',
                    chainedMethod: 'go',
                    resolvedValue: undefined,
                    startLine: 2, endLine: 2,
                })],
                'src/B.php': [invocation({
                    filePath: 'src/B.php',
                    callee: '$this->a->go',
                    resourceExpression: 'a.svc',
                    resourceRole: 'serviceId',
                    chainedMethod: 'go',
                    resolvedValue: undefined,
                    startLine: 2, endLine: 2,
                })],
            },
            fileContents: {
                'src/A.php': 'class A {}',
                'src/B.php': 'class B {}',
            },
            bindings: [
                { key: 'a.svc', boundComponent: 'Acme\\A' },
                { key: 'b.svc', boundComponent: 'Acme\\B' },
            ],
        });
        const stats = propagator.propagateAll();
        // No real I/O literals → no ioTags. The cycle sentinel just prevents
        // infinite recursion; no behavioral assertion beyond "doesn't hang".
        expect(stats.cycleSentinelHits).toBeGreaterThan(0);
        for (const b of registry.getAll()) {
            expect(b.ioTags).toBeUndefined();
        }
    });

    it('hop 2 N=1 passes the threshold (0.97 * 0.95 = 0.922 ≥ 0.85)', () => {
        const score = BASE_CONFIDENCE_BY_N_TAGS[1] * HOP_DECAY;
        expect(score).toBeGreaterThanOrEqual(MIN_DI_STATIC_CONFIDENCE);
    });

    it('hop 3 N=1 still passes (0.97 * 0.95^2 = 0.876 ≥ 0.85)', () => {
        const score = BASE_CONFIDENCE_BY_N_TAGS[1] * Math.pow(HOP_DECAY, 2);
        expect(score).toBeGreaterThanOrEqual(MIN_DI_STATIC_CONFIDENCE);
    });

    it('hop 3 N=2 drops below threshold (0.90 * 0.95^2 = 0.812 < 0.85)', () => {
        const score = BASE_CONFIDENCE_BY_N_TAGS[2] * Math.pow(HOP_DECAY, 2);
        expect(score).toBeLessThan(MIN_DI_STATIC_CONFIDENCE);
    });

    it('produces stable bindingFingerprint over deterministic inputs', () => {
        const make = () => {
            const ctx = buildContext({
                components: [comp()],
                invocationsByFile: {
                    'src/NotificationPublisher.php': [invocation()],
                },
                fileContents: {
                    'src/NotificationPublisher.php': 'class X { function publish() {} }\n',
                },
                bindings: [{
                    key: 'acme.publisher',
                    boundComponent: 'Acme\\NotificationPublisher',
                }],
            });
            ctx.propagator.propagateAll();
            return ctx.registry.getAll()[0].bindingFingerprint!;
        };
        expect(make()).toBe(make());
    });

    it('fingerprint changes when sourceHash changes (DI config edit)', () => {
        const factory = (hash: string) => {
            const ctx = buildContext({
                components: [comp()],
                invocationsByFile: {
                    'src/NotificationPublisher.php': [invocation()],
                },
                fileContents: {
                    'src/NotificationPublisher.php': 'class X { function publish() {} }\n',
                },
                bindings: [{
                    key: 'acme.publisher',
                    boundComponent: 'Acme\\NotificationPublisher',
                    sourceHash: hash,
                }],
            });
            ctx.propagator.propagateAll();
            return ctx.registry.getAll()[0].bindingFingerprint!;
        };
        expect(factory('h_v1')).not.toBe(factory('h_v2'));
    });
});
