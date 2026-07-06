// ═══════════════════════════════════════════════════════════════════════════════
// DiBindingResolver — Expands RawDiBinding[] into a populated SymbolRegistry
//
// Language-neutral; consumes:
//   - RawDiBinding[]              from DI_BINDING_PROVIDERS
//   - DependencyRequirement[]     from any language plugin
//   - ComponentDefinition[]       from any language plugin
//
// Output (side-effect): registers `class-only` DI bindings into the registry
// (i.e. `physicalName` undefined, `boundComponent` set). The downstream
// DiIoPropagator (Step 2) fills in `ioTags`; until then these bindings are
// inert (`resolveDi` returns null because `ioTags` is empty).
//
// Phases:
//   1. Explicit       — every RawDiBinding with `boundComponent` → register.
//                        Alias chains followed: `A: '@b'` resolves to B's binding.
//   2. Resource       — `App\: { resource: '../src/' }` → glob FQCNs from
//                        ComponentDefinition[] under the namespace and
//                        self-bind each one.
//   3. Autowiring     — for each registered binding whose `boundComponent`
//                        declares exactly one interface implemented by no
//                        other component, register interface → component.
//   4. Dep Cross-check— for each `DependencyRequirement{isAbstractType:true}`,
//                        if exactly one component implements `requiredType`,
//                        register requiredType → that component.
// ═══════════════════════════════════════════════════════════════════════════════

import type { SymbolRegistry } from './symbol-registry.js';
import type { RawDiBinding } from './di-binding-providers/types.js';
import type {
    ComponentDefinition,
    DependencyRequirement,
} from './languages/types.js';

export interface DiBindingResolverInput {
    rawBindings: RawDiBinding[];
    componentDefinitions: ComponentDefinition[];
    dependencyRequirements: DependencyRequirement[];
    /** Per-repo SymbolRegistry, mutated in-place. */
    symbolRegistry: SymbolRegistry;
}

export interface DiBindingResolverStats {
    explicit: number;
    resourceExpanded: number;
    autowiringInterface: number;
    dependencyRequirementCrosscheck: number;
    aliasChainsResolved: number;
    /** Aliases whose target was never registered (dropped). */
    aliasChainsDropped: number;
    /** Components matched by multiple interface implementers (skipped). */
    ambiguousInterfaceSkips: number;
}

export class DiBindingResolver {
    /**
     * Run all four phases against the registry. Returns counters that
     * Step 1.6 emits as `traceResolution('INFO', 'di-histogram', ...)`.
     */
    resolveAll(input: DiBindingResolverInput): DiBindingResolverStats {
        const stats: DiBindingResolverStats = {
            explicit: 0,
            resourceExpanded: 0,
            autowiringInterface: 0,
            dependencyRequirementCrosscheck: 0,
            aliasChainsResolved: 0,
            aliasChainsDropped: 0,
            ambiguousInterfaceSkips: 0,
        };

        // Build an index of `aliasTarget → boundComponent` resolution. We
        // resolve alias chains BEFORE registering anything else so a target
        // already in the index can flow into Phase 1 directly.
        const aliasIndex = this.indexAliases(input.rawBindings, stats);

        // Phase 1: explicit bindings (with optional alias resolution).
        for (const raw of input.rawBindings) {
            if (raw.resourcePrefix) continue; // handled in Phase 2
            const boundComponent = this.resolveBoundComponent(raw, aliasIndex);
            if (!boundComponent) continue;
            this.registerClassOnly(input.symbolRegistry, raw, boundComponent);
            stats.explicit++;
        }

        // Implementers index from the component graph (used in Phase 3+4).
        const implementersByInterface = this.indexImplementers(input.componentDefinitions);

        // Phase 2: resource: namespace expansion.
        for (const raw of input.rawBindings) {
            if (!raw.resourcePrefix) continue;
            const expanded = this.expandResource(raw, input.componentDefinitions);
            for (const fqcn of expanded) {
                this.registerClassOnly(input.symbolRegistry, raw, fqcn, fqcn);
                stats.resourceExpanded++;
            }
        }

        // Phase 3: autowiring interface binding.
        for (const raw of input.rawBindings) {
            if (!raw.autowireEnabled) continue;
            const boundComponent = this.resolveBoundComponent(raw, aliasIndex);
            if (!boundComponent) continue;
            const comp = input.componentDefinitions.find(c => c.fqcn === boundComponent);
            if (!comp) continue;
            for (const iface of comp.declaredInterfaces) {
                const impls = implementersByInterface.get(iface);
                if (!impls || impls.size !== 1) {
                    if (impls && impls.size > 1) stats.ambiguousInterfaceSkips++;
                    continue;
                }
                this.registerClassOnly(input.symbolRegistry, raw, boundComponent, iface);
                stats.autowiringInterface++;
            }
        }

        // Phase 4: dependency-requirement cross-check.
        // Guard: the unique implementer must
        // ALREADY be registered via Phase 1/2/3 (i.e. the Symfony container
        // actually knows about it). Without this guard we'd auto-promote
        // any interface with a single implementer in the repo, including
        // classes that live in src/ but aren't wired in services.yaml.
        const registeredComponents = new Set<string>();
        for (const b of input.symbolRegistry.getAll()) {
            if (b.boundComponent) registeredComponents.add(b.boundComponent);
        }
        for (const req of input.dependencyRequirements) {
            if (!req.isAbstractType) continue;
            const impls = implementersByInterface.get(req.requiredType);
            if (!impls || impls.size !== 1) {
                if (impls && impls.size > 1) stats.ambiguousInterfaceSkips++;
                continue;
            }
            const [concrete] = impls;
            if (!registeredComponents.has(concrete)) continue; // not in DI container
            this.registerClassOnly(input.symbolRegistry, {
                key: req.requiredType,
                boundComponent: concrete,
                autowireEnabled: true,
                sourceFile: `<dep-requirement:${req.ownerComponent}>`,
                sourceHash: '',
            }, concrete, req.requiredType);
            stats.dependencyRequirementCrosscheck++;
        }

        return stats;
    }

    // ─── Phase implementations ──────────────────────────────────────────

    private indexAliases(
        bindings: RawDiBinding[],
        stats: DiBindingResolverStats,
    ): Map<string, string> {
        // key → boundComponent through any chain of aliases.
        const directBoundComponent = new Map<string, string>();
        for (const b of bindings) {
            if (b.boundComponent) directBoundComponent.set(b.key, b.boundComponent);
        }

        const aliasMap = new Map<string, string>(); // alias key → target key
        for (const b of bindings) {
            if (b.aliasTarget) aliasMap.set(b.key, b.aliasTarget);
        }

        const resolved = new Map<string, string>();
        for (const [aliasKey] of aliasMap) {
            const out = this.followAlias(aliasKey, aliasMap, directBoundComponent, new Set());
            if (out) {
                resolved.set(aliasKey, out);
                stats.aliasChainsResolved++;
            } else {
                stats.aliasChainsDropped++;
            }
        }
        // Direct bindings shadow alias-resolved ones (same key wins explicitly).
        for (const [k, v] of directBoundComponent) {
            resolved.set(k, v);
        }
        return resolved;
    }

    private followAlias(
        key: string,
        aliasMap: Map<string, string>,
        direct: Map<string, string>,
        visited: Set<string>,
    ): string | null {
        if (visited.has(key)) return null;
        visited.add(key);
        const direct1 = direct.get(key);
        if (direct1) return direct1;
        const next = aliasMap.get(key);
        if (!next) return null;
        return this.followAlias(next, aliasMap, direct, visited);
    }

    private resolveBoundComponent(
        raw: RawDiBinding,
        aliasIndex: Map<string, string>,
    ): string | null {
        if (raw.boundComponent) return raw.boundComponent;
        if (raw.aliasTarget) {
            return aliasIndex.get(raw.key) ?? null;
        }
        return null;
    }

    private expandResource(
        raw: RawDiBinding,
        components: ComponentDefinition[],
    ): string[] {
        const prefix = raw.resourcePrefix!;
        const normalizedPrefix = prefix.endsWith('\\') ? prefix.slice(0, -1) : prefix;
        const out: string[] = [];
        for (const c of components) {
            // Namespace prefix filter
            if (!c.fqcn.startsWith(`${normalizedPrefix}\\`)) continue;
            // No-static-false-positives guard: when the binding declared a
            // resource: path, the component's file MUST live under that
            // path. Without this check we'd auto-bind any FQCN in the
            // namespace even when it lives in vendor/ or elsewhere outside
            // the configured directory.
            if (raw.resourcePath && !c.file.startsWith(raw.resourcePath)) continue;
            if (this.matchesExclude(c.file, raw.exclude)) continue;
            out.push(c.fqcn);
        }
        return out;
    }

    private matchesExclude(file: string, exclude: string[] | undefined): boolean {
        if (!exclude || exclude.length === 0) return false;
        for (const pattern of exclude) {
            // Conservative: substring match on a normalized path. The Symfony
            // exclude: syntax accepts globs (`{Tests,Migrations}`); we treat
            // the literal pattern as a substring for the POC. False positives
            // here cause Phase-2 to undercount, which means LLM falls back —
            // a recall-preserving failure mode.
            const stripped = pattern.replace(/^\.\.\//, '').replace(/\/\*+$/, '');
            if (!stripped) continue;
            if (file.includes(stripped)) return true;
        }
        return false;
    }

    private indexImplementers(
        components: ComponentDefinition[],
    ): Map<string, Set<string>> {
        const out = new Map<string, Set<string>>();
        for (const c of components) {
            for (const iface of c.declaredInterfaces) {
                if (!out.has(iface)) out.set(iface, new Set());
                out.get(iface)!.add(c.fqcn);
            }
        }
        return out;
    }

    private registerClassOnly(
        registry: SymbolRegistry,
        raw: RawDiBinding,
        boundComponent: string,
        keyOverride?: string,
    ): void {
        const key = keyOverride ?? raw.key;
        registry.register({
            key,
            // For class-only bindings we store the boundComponent in `value`
            // for diagnostic visibility; sanitizer is blocked by the
            // !physicalName guard regardless.
            value: boundComponent,
            // physicalName intentionally undefined — this is the marker
            // that distinguishes "DI propagator territory" from
            // "sanitizer-consumable physical name".
            physicalName: undefined,
            boundComponent,
            category: 'di_service',
            sourceFile: raw.sourceFile,
            sourceHash: raw.sourceHash,
            confidence: 'static',
            extractorVersion: 'di-binding-resolver@v1',
        });
    }
}
