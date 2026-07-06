// ═══════════════════════════════════════════════════════════════════════════════
// SymbolRegistry — Global Symbol Table for Cross-File Resolution
//
// A compiler-style symbol table that accumulates bindings from config files,
// DI containers, and manual hints during the discovery phase. Used by the
// sanitizer during semantic extraction to resolve abstract DI keys
// (e.g., 'notpurchasable.publisher') to their physical infrastructure names
// (e.g., 'acme.payment.received').
//
// Context-scoped: instantiated per-ingestion run, never a singleton.
// Merkle-cached: per-file hashes skip re-extraction of unchanged config files.
// ═══════════════════════════════════════════════════════════════════════════════

import { logger } from '../../utils/logger.js';
import type { ResolvedResourceType, ResolvedOperation } from './value-resolution/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SymbolCategory = 'di_service' | 'env_var' | 'constant' | 'config_value';
export type SymbolConfidence = 'manual' | 'static' | 'template' | 'inferred';

/**
 * DiIoTag — projected I/O signature of a bound component's operation.
 *
 * Populated by `DiIoPropagator`. Captures the static
 * value-resolution of one critical invocation found inside the bound
 * component (Symfony service class, Rust struct + impl, etc.).
 *
 * `evidenceSource` is REQUIRED, name-safety validation needs the source
 * slice of the producing operation, not the consumer chunk (see plan §H).
 */
export interface DiIoTag {
    /** Operation name on the bound component that produces this I/O. */
    method: string;
    resourceType: ResolvedResourceType;
    operation: ResolvedOperation;
    /** Static-resolved physical name (table, topic, URL, ...) when known. */
    channelName?: string;
    channelKind?: 'topic' | 'subscription' | 'queue' | 'exchange';
    quality: 'exact' | 'high' | 'medium';
    /** DFS hop count (1 = direct, 2 = one indirection, ...). */
    hopCount: number;
    /** Files traversed in the DFS to land on this I/O (used in fingerprint). */
    viaFiles: string[];
    /**
     * Source slice of the producing operation. The validation in
     * `buildStaticAnalysisFromResolvedInvocations` calls `isHallucinatedTable`
     * against this slice, never the consumer chunk.
     */
    evidenceSource: { filePath: string; sourceSlice: string };
}

export interface SymbolBinding {
    /** The abstract key (e.g., 'notpurchasable.publisher') */
    key: string;
    /** The resolved physical name (e.g., 'acme.payment.received') */
    value: string;
    /**
     * Explicit physical-name marker. When `category === 'di_service'`, a
     * binding without `physicalName` is class-only (serviceId → FQCN with no
     * canonical resource name). The sanitizer guard in `resolve()` drops
     * class-only bindings so an FQCN never gets persisted as a channel name.
     */
    physicalName?: string;
    /**
     * The actual concrete component (class / struct / module) bound to this
     * service via DI. Naming agnostic for polyglot codebases.
     */
    boundComponent?: string;
    /** Projected I/O signatures from the DI propagator. */
    ioTags?: DiIoTag[];
    /** SHA256 fingerprint over (diConfigSource + boundComponent + viaFiles + ioTags shape) — drives cache invalidation. */
    bindingFingerprint?: string;
    /** All files visited during DFS multi-hop projection (canonical order). */
    viaFiles?: string[];
    /** Raw extracted value before deterministic env/template resolution. */
    rawValue?: string;
    /** Resolved value after deterministic env/template resolution. */
    resolvedValue?: string;
    /** Classification of this binding */
    category: SymbolCategory;
    /** Optional technology hint (e.g., 'rabbitmq', 'kafka') */
    technology?: string;
    /** Source file that defined this binding (for debugging) */
    sourceFile: string;
    /** Content hash of the source file that produced this binding. */
    sourceHash?: string;
    /** Version of the extraction prompt/schema used for this binding. */
    extractorVersion?: string;
    /** Confidence level — manual overrides trump LLM-extracted ones */
    confidence: SymbolConfidence;
}

// ─── Serialization (for Neo4j cache) ─────────────────────────────────────────

export interface CachedSymbolSource {
    relativePath: string;
    fileHash: string;
    symbols: SymbolBinding[];
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class SymbolRegistry {
    private bindings = new Map<string, SymbolBinding>();
    /**
     * Read-tracking: maps each symbol key to the set of consumer file paths
     * that resolved it during Pass 2/3. Used for targeted cache invalidation.
     */
    private usages = new Map<string, Set<string>>();

    /**
     * Register a symbol binding. Higher-confidence bindings overwrite
     * lower-confidence ones for the same key.
     */
    register(binding: SymbolBinding): void {
        const existing = this.bindings.get(binding.key);
        if (existing) {
            const priority: Record<SymbolConfidence, number> = {
                manual: 3,
                static: 2,
                template: 1,
                inferred: 0,
            };
            if (priority[binding.confidence] < priority[existing.confidence]) {
                logger.debug(`[SymbolRegistry] Skipping "${binding.key}" (${binding.confidence}) — existing has higher confidence (${existing.confidence})`);
                return;
            }
        }
        this.bindings.set(binding.key, binding);
        logger.debug(`[SymbolRegistry] Registered "${binding.key}" → "${binding.value}" [${binding.confidence}] from ${binding.sourceFile}`);
    }

    /**
     * Resolve a key to its physical binding.
     * Optionally records the consumer file for targeted cache invalidation.
     *
     * Sanitizer guard: a `di_service` binding without `physicalName` is
     * class-only (serviceId → FQCN, no canonical resource name) and MUST NOT
     * be consumed by the sanitizer to rewrite an LLM-emitted channel/table
     * name (that would persist the FQCN as a channel). Such bindings return
     * `null` from this method. Use `resolveDi(key, file, op)` to access them
     * for the DI propagator path instead.
     */
    resolve(key: string, consumerFilePath?: string): SymbolBinding | null {
        let binding = this.bindings.get(key) ?? null;

        // Fallback: If LLM extracts a camelCase property (like `ordersTopicSave`),
        // try to match it against UPPER_SNAKE_CASE env variables (like `ORDERS_TOPIC_SAVE`).
        if (!binding && /^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(key)) {
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
            binding = this.bindings.get(snakeKey) ?? null;
            if (binding) {
                logger.debug(`[SymbolRegistry] Fuzzy resolved camelCase "${key}" → "${snakeKey}"`);
            }
        }

        // Class-only DI binding guard: when a di_service
        // binding has a `boundComponent` but no explicit `physicalName`, it
        // is a class-only binding (serviceId → FQCN with no canonical
        // resource name). The sanitizer must NOT consume it: that would
        // persist the FQCN as a channel name. Legacy bindings populate the
        // physical name in `value` (no `boundComponent`); those still
        // resolve normally.
        if (binding && binding.category === 'di_service'
            && binding.boundComponent && !binding.physicalName) {
            return null;
        }

        if (binding && consumerFilePath) {
            if (!this.usages.has(binding.key)) this.usages.set(binding.key, new Set());
            this.usages.get(binding.key)!.add(consumerFilePath);
        }
        return binding;
    }

    /**
     * DI-aware resolver. Returns the raw binding and the subset of its
     * `ioTags` that match `operationName`. Used by the static-bypass path
     * (DI propagator) which needs class-only bindings (no `physicalName`)
     * specifically because that's the whole point of the bypass: the
     * physical name lives inside the bound component's ioTag.
     *
     * Returns `null` when:
     *   - no binding for `key`
     *   - `operationName` is undefined (ambiguity, prefer LLM)
     *   - the binding has no `ioTags` for that operation
     *
     * Records usage for cache invalidation.
     */
    resolveDi(
        key: string,
        consumerFilePath: string | undefined,
        operationName: string | undefined,
    ): { binding: SymbolBinding; ioTags: DiIoTag[] } | null {
        if (!operationName) return null;
        const binding = this.bindings.get(key) ?? null;
        if (!binding) return null;
        if (!binding.ioTags || binding.ioTags.length === 0) return null;
        const matched = binding.ioTags.filter(t => t.method === operationName);
        if (matched.length === 0) return null;

        if (consumerFilePath) {
            if (!this.usages.has(binding.key)) this.usages.set(binding.key, new Set());
            this.usages.get(binding.key)!.add(consumerFilePath);
        }
        return { binding, ioTags: matched };
    }

    /**
     * Resolve a key, scoped to a specific category.
     */
    resolveByCategory(key: string, category: SymbolCategory): SymbolBinding | null {
        const binding = this.bindings.get(key);
        if (binding && binding.category === category) return binding;
        return null;
    }

    /**
     * Bulk-register symbols (e.g., from cache deserialization).
     */
    registerAll(bindings: SymbolBinding[]): void {
        for (const b of bindings) {
            this.register(b);
        }
    }

    /**
     * Get all registered bindings.
     */
    getAll(): SymbolBinding[] {
        return [...this.bindings.values()];
    }

    /**
     * Clear all bindings (used between repos in multi-repo ingestion).
     */
    clear(): void {
        this.bindings.clear();
    }

    get size(): number {
        return this.bindings.size;
    }

    /**
     * Get the read-tracking map: symbol key → set of consumer file paths.
     */
    getUsages(): Map<string, Set<string>> {
        return this.usages;
    }

    /**
     * Serialize the registry (bindings + usages) to JSON for cache persistence.
     */
    serialize(): string {
        const usagesObj: Record<string, string[]> = {};
        for (const [key, files] of this.usages) {
            usagesObj[key] = [...files];
        }
        return JSON.stringify({ bindings: this.getAll(), usages: usagesObj });
    }

    /**
     * Restore a registry from a previously serialized JSON string.
     */
    static deserialize(json: string): SymbolRegistry {
        const registry = new SymbolRegistry();
        const data = JSON.parse(json);
        // Handle both old format (raw array) and new format ({bindings, usages})
        if (Array.isArray(data)) {
            registry.registerAll(data);
        } else {
            registry.registerAll(data.bindings ?? []);
            if (data.usages) {
                for (const [key, files] of Object.entries(data.usages)) {
                    registry.usages.set(key, new Set(files as string[]));
                }
            }
        }
        return registry;
    }
}
