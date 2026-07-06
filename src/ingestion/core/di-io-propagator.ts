// ═══════════════════════════════════════════════════════════════════════════════
// DiIoPropagator — projects I/O from bound components onto DI bindings
//
// For every `SymbolBinding(boundComponent)` registered by the
// DiBindingResolver, walk the bound component's operations and gather
// ResolvedInvocationArg literals that match a real I/O resource. Each match
// becomes a `DiIoTag` on the binding. The DFS follows secondary DI lookups
// (Pattern A/B chained methods) up to `MAX_HOP_DEPTH` with confidence decay
// per hop.
//
// CRITICAL: each ioTag is stamped with the *root*
// operation method, NOT the leaf operation method reached after recursion.
// Reason: callers query `resolveDi(key, file, chainedMethod)` where
// `chainedMethod` is the method invoked on the binding's serviceId (e.g.
// `useCase.execute()` → `chainedMethod='execute'`). If the bound class's
// execute() delegates to publisher.publish() and we stamped `method='publish'`,
// the resolveDi lookup would miss. We attribute leaf-discovered literals
// to the root operation that started the visit.
//
// Confidence model:
//   - MIN_DI_STATIC_CONFIDENCE = 0.85 (threshold for static bypass)
//   - HOP_DECAY = 0.95 (per hop)
//   - BASE_CONFIDENCE_BY_N_TAGS: 1 → 0.97, 2 → 0.90, 3 → 0.80, ≥4 → 0
//
//   Sample effective scores (decay^(hop-1) * base):
//     hop 1 N=1 = 0.97   hop 2 N=1 = 0.922  hop 3 N=1 = 0.876  (all pass 0.85)
//     hop 4 N=1 = 0.832  (drops below 0.85, gated by MAX_HOP_DEPTH=3)
//     hop 2 N=2 = 0.855  (passes); hop 3 N=2 = 0.812 (drops)
//
// Output: populates each binding's `ioTags`, `viaFiles`, and
// `bindingFingerprint` in-place. Returns counters for diagnostics.
// ═══════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { SymbolRegistry, SymbolBinding, DiIoTag } from './symbol-registry.js';
import type { ComponentIoIndex } from './component-io-index.js';
import type { ResolvedInvocationArg } from './value-resolution/types.js';

export const MIN_DI_STATIC_CONFIDENCE = 0.85;
export const HOP_DECAY = 0.95;
export const MAX_HOP_DEPTH = 3;

export const BASE_CONFIDENCE_BY_N_TAGS: Record<number, number> = {
    1: 0.97,
    2: 0.90,
    3: 0.80,
};

export interface DiIoPropagatorStats {
    bindingsVisited: number;
    bindingsWithIoTags: number;
    ioTagsEmitted: number;
    /** Operations skipped because no `complete` invocation produced a literal. */
    operationsWithoutIo: number;
    /** Operations skipped because score < MIN_DI_STATIC_CONFIDENCE. */
    operationsBelowThreshold: number;
    /** Cycle hits (visited set rejected re-entry). */
    cycleSentinelHits: number;
}

export interface DiIoPropagatorOptions {
    /**
     * Map file → content hash. Used in the bindingFingerprint so that a
     * change to a bound component's body taints consumers even when the
     * ioTag shape (channel name / type / op) is unchanged.
     * Optional: when absent, fingerprint falls back to file paths only.
     */
    viaFileHashes?: Map<string, string>;
}

export class DiIoPropagator {
    private readonly viaFileHashes: Map<string, string>;

    constructor(
        private readonly registry: SymbolRegistry,
        private readonly componentIo: ComponentIoIndex,
        opts: DiIoPropagatorOptions = {},
    ) {
        this.viaFileHashes = opts.viaFileHashes ?? new Map();
    }

    /** Mutates the registry in-place. */
    propagateAll(): DiIoPropagatorStats {
        const stats: DiIoPropagatorStats = {
            bindingsVisited: 0,
            bindingsWithIoTags: 0,
            ioTagsEmitted: 0,
            operationsWithoutIo: 0,
            operationsBelowThreshold: 0,
            cycleSentinelHits: 0,
        };

        for (const binding of this.registry.getAll()) {
            if (!binding.boundComponent) continue;
            stats.bindingsVisited++;

            const tags: DiIoTag[] = [];
            const viaFiles = new Set<string>();

            // Iterate root operations of the bound component. Each root
            // gets its OWN visited set so two roots that share a sub-tree
            // both get fully explored.
            const rootOps = this.componentIo.getAllOperations(binding.boundComponent);
            for (const rootOp of rootOps) {
                const visited = new Set<string>();
                this.collectRecursive(
                    binding.boundComponent,
                    rootOp,
                    /* hopCount */ 1,
                    rootOp,             // rootMethod — stamped on every emitted ioTag
                    visited,
                    viaFiles,
                    tags,
                    stats,
                );
            }

            if (tags.length > 0) {
                binding.ioTags = tags;
                binding.viaFiles = [...viaFiles].sort();
                binding.bindingFingerprint = this.computeFingerprint(binding, viaFiles, tags);
                stats.bindingsWithIoTags++;
                stats.ioTagsEmitted += tags.length;
            }
        }

        return stats;
    }

    /**
     * Recursive DFS. Every ioTag emitted carries `method = rootMethod`,
     * regardless of how deep we recursed to discover the literal.
     */
    private collectRecursive(
        currentComp: string,
        currentOp: string,
        hopCount: number,
        rootMethod: string,
        visited: Set<string>,
        viaFiles: Set<string>,
        sink: DiIoTag[],
        stats: DiIoPropagatorStats,
    ): void {
        if (hopCount > MAX_HOP_DEPTH) return;

        const key = `${currentComp}::${currentOp}`;
        if (visited.has(key)) {
            stats.cycleSentinelHits++;
            return;
        }
        visited.add(key);

        const resolved = this.componentIo.getOperationResolvedInvocations(currentComp, currentOp);
        if (!resolved || resolved.length === 0) {
            stats.operationsWithoutIo++;
            return;
        }

        // ── Literal I/O on this hop ─────────────────────────────────────
        const literals = resolved.filter(r =>
            r.complete
            && r.resolvedValue !== undefined
            && r.invocation.resourceRole !== 'serviceId'
            && r.invocation.resourceRole !== 'messageClass'
            && r.invocation.resourceRole !== 'parameterId'
            && r.invocation.resourceRole !== 'configRef',
        );

        const n = literals.length;
        if (n > 0) {
            const base = BASE_CONFIDENCE_BY_N_TAGS[n] ?? 0;
            const score = base * Math.pow(HOP_DECAY, hopCount - 1);
            if (score >= MIN_DI_STATIC_CONFIDENCE && base > 0) {
                const quality = qualityForScore(score);
                const operationSource = this.componentIo.getOperationSource(currentComp, currentOp);
                if (operationSource) {
                    viaFiles.add(operationSource.filePath);
                    for (const lit of literals) {
                        sink.push({
                            method: rootMethod, // ROOT method, not leaf
                            resourceType: lit.invocation.resourceType,
                            operation: lit.invocation.operation,
                            channelName: lit.resolvedValue,
                            channelKind: channelKindForRole(lit.invocation.resourceRole),
                            quality,
                            hopCount,
                            viaFiles: [operationSource.filePath],
                            evidenceSource: operationSource,
                        });
                    }
                }
            } else {
                stats.operationsBelowThreshold++;
            }
        }

        // ── Recurse into chained serviceId invocations ──────────────────
        const chainedServiceIds = resolved.filter(r =>
            r.invocation.resourceRole === 'serviceId'
            && r.invocation.chainedMethod
            && r.invocation.resourceExpression,
        );

        for (const sid of chainedServiceIds) {
            // Strip quotes so `'publisher'` matches a
            // binding registered with key `publisher`. Mirror VRI behavior.
            const lookupKey = stripQuotes(sid.invocation.resourceExpression);
            const secondaryBinding = this.registry.getAll().find(b => b.key === lookupKey);
            if (!secondaryBinding?.boundComponent) continue;

            // Continue with rootMethod intact — leaf literals still attribute
            // to the root operation that started this binding's visit.
            this.collectRecursive(
                secondaryBinding.boundComponent,
                sid.invocation.chainedMethod!,
                hopCount + 1,
                rootMethod,
                visited,
                viaFiles,
                sink,
                stats,
            );
        }
    }

    private computeFingerprint(
        binding: SymbolBinding,
        viaFiles: Set<string>,
        tags: DiIoTag[],
    ): string {
        const hash = createHash('sha256');
        // diConfigSourceFile + diConfigSourceHash + boundComponent
        hash.update(binding.sourceFile ?? '');
        hash.update('\0');
        hash.update(binding.sourceHash ?? '');
        hash.update('\0');
        hash.update(binding.boundComponent ?? '');
        hash.update('\0');
        // Include via-file CONTENT hashes (not just
        // paths) so an edit to a bound component's body taints the
        // binding's fingerprint even when the ioTag shape is preserved.
        for (const file of [...viaFiles].sort()) {
            hash.update(file);
            hash.update('\0');
            hash.update(this.viaFileHashes.get(file) ?? '');
            hash.update('\0');
        }
        const shape = tags.map(t =>
            `${t.method}|${t.resourceType}|${t.operation}|${t.channelName ?? ''}|${t.hopCount}`,
        ).sort().join('\n');
        hash.update(shape);
        return hash.digest('hex').slice(0, 16);
    }
}

function qualityForScore(score: number): DiIoTag['quality'] {
    if (score >= 0.95) return 'exact';
    if (score >= 0.88) return 'high';
    return 'medium';
}

function channelKindForRole(role: string): DiIoTag['channelKind'] {
    const lower = role.toLowerCase();
    if (lower.includes('topic')) return 'topic';
    if (lower.includes('subscription')) return 'subscription';
    if (lower.includes('queue')) return 'queue';
    if (lower.includes('exchange')) return 'exchange';
    return undefined;
}

function stripQuotes(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' || first === "'" || first === '`') && first === last) {
            return s.slice(1, -1);
        }
    }
    return s;
}
