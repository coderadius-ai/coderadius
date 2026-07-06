import { describe, it, expect } from 'vitest';
import { DiBindingResolver } from '../../../../src/ingestion/core/di-binding-resolver.js';
import { SymbolRegistry } from '../../../../src/ingestion/core/symbol-registry.js';
import type { RawDiBinding } from '../../../../src/ingestion/core/di-binding-providers/types.js';
import type {
    ComponentDefinition,
    DependencyRequirement,
} from '../../../../src/ingestion/core/languages/types.js';

const resolver = new DiBindingResolver();

function rawBinding(over: Partial<RawDiBinding> = {}): RawDiBinding {
    return {
        key: 'acme.publisher',
        boundComponent: 'Acme\\Messaging\\NotificationPublisher',
        autowireEnabled: false,
        sourceFile: 'config/services.yaml',
        sourceHash: 'h',
        ...over,
    };
}

function comp(over: Partial<ComponentDefinition> = {}): ComponentDefinition {
    return {
        fqcn: 'Acme\\Messaging\\NotificationPublisher',
        file: 'src/NotificationPublisher.php',
        operations: [{ name: 'publish', range: { startLine: 10, endLine: 20 } }],
        declaredInterfaces: [],
        ...over,
    };
}

function req(over: Partial<DependencyRequirement> = {}): DependencyRequirement {
    return {
        ownerComponent: 'Acme\\Controller',
        parameterName: 'pub',
        requiredType: 'Acme\\PublisherInterface',
        isAbstractType: true,
        ...over,
    };
}

function run(
    bindings: RawDiBinding[],
    components: ComponentDefinition[] = [],
    deps: DependencyRequirement[] = [],
) {
    const registry = new SymbolRegistry();
    const stats = resolver.resolveAll({
        rawBindings: bindings,
        componentDefinitions: components,
        dependencyRequirements: deps,
        symbolRegistry: registry,
    });
    return { registry, stats };
}

describe('DiBindingResolver — Phase 1 explicit', () => {
    it('registers a single explicit binding as class-only', () => {
        const { registry, stats } = run([rawBinding()]);
        expect(stats.explicit).toBe(1);
        // resolve() drops class-only bindings (sanitizer guard)
        expect(registry.resolve('acme.publisher')).toBeNull();
        // resolveDi requires an operationName + ioTags. ioTags are empty
        // until the propagator runs (Step 2), so this is also null. We
        // verify the binding was registered by inspecting getAll().
        const all = registry.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].boundComponent).toBe('Acme\\Messaging\\NotificationPublisher');
        expect(all[0].physicalName).toBeUndefined();
    });

    it('higher confidence wins on conflict', () => {
        const { registry } = run([
            rawBinding({ key: 'k', boundComponent: 'Acme\\A' }),
            rawBinding({ key: 'k', boundComponent: 'Acme\\B' }),
        ]);
        // Both are 'static' so SymbolRegistry's priority allows overwrite.
        // Last wins (no priority demotion).
        const all = registry.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].boundComponent).toBe('Acme\\B');
    });
});

describe('DiBindingResolver — alias chains', () => {
    it('follows a one-hop alias to its boundComponent', () => {
        const { registry, stats } = run([
            rawBinding({ key: 'acme.publisher', boundComponent: 'Acme\\NotificationPublisher' }),
            rawBinding({
                key: 'Acme\\PublisherInterface',
                boundComponent: undefined,
                aliasTarget: 'acme.publisher',
            }),
        ]);
        expect(stats.aliasChainsResolved).toBeGreaterThanOrEqual(1);
        const aliased = registry.getAll().find(b => b.key === 'Acme\\PublisherInterface');
        expect(aliased).toBeDefined();
        expect(aliased!.boundComponent).toBe('Acme\\NotificationPublisher');
    });

    it('drops an alias whose target is missing', () => {
        const { stats } = run([
            rawBinding({
                key: 'orphan',
                boundComponent: undefined,
                aliasTarget: 'never_registered',
            }),
        ]);
        expect(stats.aliasChainsDropped).toBeGreaterThanOrEqual(1);
    });

    it('detects a 2-cycle and does not loop forever', () => {
        const { stats } = run([
            rawBinding({ key: 'a', boundComponent: undefined, aliasTarget: 'b' }),
            rawBinding({ key: 'b', boundComponent: undefined, aliasTarget: 'a' }),
        ]);
        expect(stats.aliasChainsDropped).toBeGreaterThanOrEqual(1);
    });
});

describe('DiBindingResolver — Phase 2 resource expansion', () => {
    it('expands `App\\: { resource: ../src/ }` into per-FQCN self-bindings', () => {
        const components: ComponentDefinition[] = [
            comp({ fqcn: 'Acme\\Order', file: 'src/Order.php' }),
            comp({ fqcn: 'Acme\\Payment', file: 'src/Payment.php' }),
            comp({ fqcn: 'Other\\Foo', file: 'vendor/Other/Foo.php' }),
        ];
        const { registry, stats } = run([
            rawBinding({
                key: 'Acme\\',
                boundComponent: undefined,
                resourcePrefix: 'Acme\\',
                autowireEnabled: true,
            }),
        ], components);

        expect(stats.resourceExpanded).toBe(2);
        expect(registry.getAll().map(b => b.key).sort()).toEqual(['Acme\\Order', 'Acme\\Payment']);
    });

    it('respects exclude: substring patterns', () => {
        const components: ComponentDefinition[] = [
            comp({ fqcn: 'Acme\\OrderService', file: 'src/OrderService.php' }),
            comp({ fqcn: 'Acme\\Tests\\OrderTest', file: 'src/Tests/OrderTest.php' }),
        ];
        const { registry, stats } = run([
            rawBinding({
                key: 'Acme\\',
                boundComponent: undefined,
                resourcePrefix: 'Acme\\',
                exclude: ['../src/Tests'],
                autowireEnabled: true,
            }),
        ], components);

        expect(stats.resourceExpanded).toBe(1);
        expect(registry.getAll().map(b => b.key)).toEqual(['Acme\\OrderService']);
    });
});

describe('DiBindingResolver — Phase 3 autowiring interface', () => {
    it('binds interface → component when there is exactly one implementer', () => {
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\NotificationPublisher',
                file: 'src/NotificationPublisher.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const { registry, stats } = run([
            rawBinding({
                key: 'acme.publisher',
                boundComponent: 'Acme\\NotificationPublisher',
                autowireEnabled: true,
            }),
        ], components);

        expect(stats.autowiringInterface).toBe(1);
        // The interface key is now registered as a class-only binding.
        const aliased = registry.getAll().find(b => b.key === 'Acme\\PublisherInterface');
        expect(aliased).toBeDefined();
        expect(aliased!.boundComponent).toBe('Acme\\NotificationPublisher');
    });

    it('skips when more than one implementer exists (ambiguity guard)', () => {
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\PublisherA',
                file: 'src/PublisherA.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
            comp({
                fqcn: 'Acme\\PublisherB',
                file: 'src/PublisherB.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const { registry, stats } = run([
            rawBinding({
                key: 'acme.publisher_a',
                boundComponent: 'Acme\\PublisherA',
                autowireEnabled: true,
            }),
            rawBinding({
                key: 'acme.publisher_b',
                boundComponent: 'Acme\\PublisherB',
                autowireEnabled: true,
            }),
        ], components);

        expect(stats.autowiringInterface).toBe(0);
        expect(stats.ambiguousInterfaceSkips).toBeGreaterThan(0);
        // Interface key is NOT registered (would require LLM disambiguation).
        const aliased = registry.getAll().find(b => b.key === 'Acme\\PublisherInterface');
        expect(aliased).toBeUndefined();
    });

    it('does not autowire when autowireEnabled=false', () => {
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\NotificationPublisher',
                file: 'src/NotificationPublisher.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const { stats } = run([
            rawBinding({ autowireEnabled: false }),
        ], components);
        expect(stats.autowiringInterface).toBe(0);
    });
});

describe('DiBindingResolver — Phase 4 dependency-requirement cross-check', () => {
    it('binds requiredType → unique implementer (when concrete is already registered)', () => {
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\NotificationPublisher',
                file: 'src/NotificationPublisher.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const reqs: DependencyRequirement[] = [
            req({ requiredType: 'Acme\\PublisherInterface', isAbstractType: true }),
        ];
        // Plan v10 §F P0 fix: the concrete component must already be
        // registered (via Phase 1/2/3) before Phase 4 promotes the
        // interface alias. Otherwise we'd auto-bind classes that exist
        // in the repo but live outside the Symfony container.
        const explicitBinding = rawBinding({
            key: 'acme.notification.publisher',
            boundComponent: 'Acme\\NotificationPublisher',
        });
        const { registry, stats } = run([explicitBinding], components, reqs);

        expect(stats.dependencyRequirementCrosscheck).toBe(1);
        const aliased = registry.getAll().find(b => b.key === 'Acme\\PublisherInterface');
        expect(aliased).toBeDefined();
        expect(aliased!.boundComponent).toBe('Acme\\NotificationPublisher');
    });

    it('skips when concrete is NOT registered (no FP from repo-only implementers)', () => {
        // Same shape as above but without the Phase-1 explicit binding.
        // The class exists in src/ but Symfony does NOT know about it.
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\NotificationPublisher',
                file: 'src/NotificationPublisher.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const reqs: DependencyRequirement[] = [
            req({ requiredType: 'Acme\\PublisherInterface', isAbstractType: true }),
        ];
        const { registry, stats } = run([], components, reqs);
        expect(stats.dependencyRequirementCrosscheck).toBe(0);
        expect(registry.getAll().find(b => b.key === 'Acme\\PublisherInterface')).toBeUndefined();
    });

    it('skips when interface has multiple implementers', () => {
        const components: ComponentDefinition[] = [
            comp({ fqcn: 'Acme\\PubA', file: 'a.php', declaredInterfaces: ['Acme\\PubIface'] }),
            comp({ fqcn: 'Acme\\PubB', file: 'b.php', declaredInterfaces: ['Acme\\PubIface'] }),
        ];
        const reqs = [req({ requiredType: 'Acme\\PubIface', isAbstractType: true })];
        const { stats } = run([], components, reqs);
        expect(stats.dependencyRequirementCrosscheck).toBe(0);
    });

    it('skips when requirement is not abstract', () => {
        const components: ComponentDefinition[] = [
            comp({
                fqcn: 'Acme\\NotificationPublisher',
                file: 'a.php',
                declaredInterfaces: ['Acme\\PublisherInterface'],
            }),
        ];
        const reqs = [req({ requiredType: 'Acme\\ConcretePublisher', isAbstractType: false })];
        const { stats } = run([], components, reqs);
        expect(stats.dependencyRequirementCrosscheck).toBe(0);
    });
});

describe('DiBindingResolver — class-only invariant', () => {
    it('never sets physicalName on registered bindings', () => {
        const components: ComponentDefinition[] = [
            comp({ declaredInterfaces: ['Acme\\PublisherInterface'] }),
        ];
        const { registry } = run([
            rawBinding({ autowireEnabled: true }),
            rawBinding({
                key: 'Acme\\',
                boundComponent: undefined,
                resourcePrefix: 'Acme\\',
                autowireEnabled: true,
            }),
        ], components);
        for (const b of registry.getAll()) {
            expect(b.physicalName).toBeUndefined();
        }
    });
});
