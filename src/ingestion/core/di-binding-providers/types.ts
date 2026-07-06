// ═══════════════════════════════════════════════════════════════════════════════
// DiBindingProvider — Container-Builder Parsers
//
// Distinct from `ConfigValueProvider` (which emits `ValueFact[]`):
// DiBindingProvider parsers read a DI container declaration (Symfony YAML/PHP,
// Laravel ServiceProvider, NestJS module, etc.) and emit raw bindings that
// `DiBindingResolver` then expands into the SymbolRegistry.
//
// Why separate from ConfigValueProvider:
//   - Different output shape (RawDiBinding vs ValueFact)
//   - contentSignatures is REQUIRED here (cheap content-shape gate)
//   - Side effect is "register bindings", not "emit value facts" (semantically
//     distinct: a binding is `serviceId → component`, a fact is `key → value`)
// ═══════════════════════════════════════════════════════════════════════════════

export interface DiBindingProviderContext {
    relativePath: string;
    repoRoot: string;
    repoName: string;
}

/**
 * A raw binding parsed from a single DI container source file, before
 * DiBindingResolver expands it (alias chains, resource: namespace globs,
 * autowiring interface lookups).
 *
 * Naming agnostic: `boundComponent` covers class (PHP/TS/Java),
 * struct + impl (Rust/Go), typeclass (Haskell), module (Python/OCaml).
 */
export interface RawDiBinding {
    /** serviceId (Symfony) or InterfaceFQCN (autowiring). */
    key: string;
    /**
     * Concrete component FQCN the binding resolves to. Undefined for entries
     * that only declare a resource: prefix or an alias (resolver expands them).
     */
    boundComponent?: string;
    /** For `A: '@b'` aliases — target serviceId/FQCN. */
    aliasTarget?: string;
    /**
     * Positional STRING-literal constructor args captured from
     * `return new X(<obj>, 'literal', <obj>)`. Object args (`new Y()`,
     * `$c->get(...)`) are skipped, so `position` is the literal's index in the
     * ORIGINAL arg list (non-contiguous). Used to resolve a wrapper's
     * DI-injected property (e.g. `$this->topic`) to the literal. Undefined when
     * the binding is an alias or has no scalar args.
     */
    ctorScalars?: Array<{ position: number; value: string }>;
    /**
     * Namespace prefix from Symfony `App\: { resource: '../src/' }` syntax.
     * The resolver globs ComponentDefinitions under this prefix and self-binds
     * each FQCN — BUT only those whose file matches `resourcePath`.
     */
    resourcePrefix?: string;
    /**
     * Path glob from the same `resource:` syntax (e.g. `'../src/'` →
     * `'src/'` after normalization). Drives the path-filter in resolver
     * Phase 2 — without it, FQCNs that live outside the configured
     * directory get auto-bound (FP). Resolved relative to the
     * `sourceFile`'s parent directory at extraction time.
     */
    resourcePath?: string;
    /**
     * Tag flag from `_defaults: { autowire: true }` (or per-binding override).
     * Resolver consults this when running interface→concrete autowiring.
     */
    autowireEnabled: boolean;
    /**
     * Glob patterns from `exclude:` clause. Filtered out of resource expansion.
     */
    exclude?: string[];
    /** Path of the file this binding was extracted from. */
    sourceFile: string;
    /** Content hash of the source file (used in bindingFingerprint). */
    sourceHash: string;
}

export interface DiBindingProvider {
    readonly id: string;
    /**
     * REQUIRED (unlike ConfigValueProvider where it is optional). The
     * collector gates `extractDiBindings` behind this regex test for cheap
     * content-shape filtering. See feedback_content_signature_is_the_gate.
     */
    readonly contentSignatures: RegExp[];
    matchFile(relativePath: string, basename: string): boolean;
    extractDiBindings(content: string, ctx: DiBindingProviderContext): RawDiBinding[];
}
