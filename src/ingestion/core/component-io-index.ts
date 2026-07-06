// ═══════════════════════════════════════════════════════════════════════════════
// ComponentIoIndex — FQCN → operations → resolved invocations
//
// Indexes ComponentDefinition[] from every ParsedFileResult and
// provides O(1) lookup by FQCN+operation. Resolves invocations for an
// operation through ValueResolutionIndex in **value-only mode**, so the
// propagator can read static-resolved literal arguments WITHOUT
// poisoning the VRI memo cache with a `diBinding=undefined` entry.
//
// Used exclusively by DiIoPropagator. Other readers should go through the
// ValueResolutionIndex directly in 'full' mode.
// ═══════════════════════════════════════════════════════════════════════════════

import type { ValueResolutionIndex } from './value-resolution/index.js';
import type { ResolvedInvocationArg } from './value-resolution/types.js';
import type { ComponentDefinition } from './languages/types.js';
import type { CodeChunk } from '../../graph/types.js';

interface IndexedOperation {
    name: string;                                 // already lowercased by plugin if case-insensitive
    range: { startLine: number; endLine: number };
    /** File the operation lives in (component.file). */
    filePath: string;
    /** Owner FQCN — same as ComponentDefinition.fqcn. */
    ownerFqcn: string;
    /** Cached source slice (computed lazily when first asked). */
    sourceSlice?: string;
}

export class ComponentIoIndex {
    /** FQCN → operations[] (one entry per method). */
    private readonly byFqcn = new Map<string, IndexedOperation[]>();
    /** interfaceFqcn → Set<concrete FQCN>. */
    private readonly implementersByInterface = new Map<string, Set<string>>();
    /** filePath → fileContent (lazily populated; used for source-slice extraction). */
    private readonly fileContents: Map<string, string>;
    private readonly vri: ValueResolutionIndex;

    constructor(
        components: ComponentDefinition[],
        fileContents: Map<string, string>,
        vri: ValueResolutionIndex,
    ) {
        this.fileContents = fileContents;
        this.vri = vri;

        for (const comp of components) {
            const ops: IndexedOperation[] = comp.operations.map(op => ({
                name: op.name,
                range: op.range,
                filePath: comp.file,
                ownerFqcn: comp.fqcn,
            }));
            // If two ComponentDefinitions report the same FQCN (e.g. trait
            // partial + class body), keep the longest-method list. Defensive
            // dedup — PHP doesn't legitimately declare a class twice.
            const existing = this.byFqcn.get(comp.fqcn);
            if (!existing || ops.length > existing.length) {
                this.byFqcn.set(comp.fqcn, ops);
            }

            for (const iface of comp.declaredInterfaces) {
                if (!this.implementersByInterface.has(iface)) {
                    this.implementersByInterface.set(iface, new Set());
                }
                this.implementersByInterface.get(iface)!.add(comp.fqcn);
            }
        }
    }

    /** All declared operations on the component, or [] if unknown FQCN. */
    getAllOperations(fqcn: string): string[] {
        const ops = this.byFqcn.get(fqcn);
        return ops ? ops.map(o => o.name) : [];
    }

    /** Components that implement the given interface FQCN. */
    getImplementers(interfaceFqcn: string): string[] {
        const set = this.implementersByInterface.get(interfaceFqcn);
        return set ? [...set] : [];
    }

    /**
     * Resolve invocations inside the body of `fqcn::operation` through VRI
     * in `value-only` mode. Returns `null` when the operation or FQCN is
     * unknown, `[]` when known but no invocations live inside the range.
     */
    getOperationResolvedInvocations(fqcn: string, operation: string): ResolvedInvocationArg[] | null {
        const op = this.findOperation(fqcn, operation);
        if (!op) return null;
        const virtualChunk = this.buildVirtualChunk(op);
        return this.vri.resolveInvocationsForChunk(op.filePath, virtualChunk, { mode: 'value-only' });
    }

    /**
     * Source slice of the operation body. Used by Step 2.4 validation
     * (isHallucinatedTable needs the bound component's source, NOT the
     * consumer chunk's).
     */
    getOperationSource(fqcn: string, operation: string): { filePath: string; sourceSlice: string } | null {
        const op = this.findOperation(fqcn, operation);
        if (!op) return null;
        if (op.sourceSlice !== undefined) {
            return { filePath: op.filePath, sourceSlice: op.sourceSlice };
        }
        const content = this.fileContents.get(op.filePath);
        if (content === undefined) return null;
        const sourceSlice = sliceLines(content, op.range.startLine, op.range.endLine);
        op.sourceSlice = sourceSlice;
        return { filePath: op.filePath, sourceSlice };
    }

    private findOperation(fqcn: string, operation: string): IndexedOperation | null {
        const ops = this.byFqcn.get(fqcn);
        if (!ops) return null;
        // Operation names are already lowercased by the plugin when the
        // language is case-insensitive; the caller normalizes the chained
        // method symmetrically.
        return ops.find(o => o.name === operation) ?? null;
    }

    private buildVirtualChunk(op: IndexedOperation): CodeChunk {
        return {
            name: `${op.ownerFqcn}.${op.name}`,
            filepath: op.filePath,
            language: 'php',
            startLine: op.range.startLine,
            endLine: op.range.endLine,
            sourceCode: '', // VRI doesn't need sourceCode for invocation lookup
        } as CodeChunk;
    }
}

function sliceLines(content: string, startLine: number, endLine: number): string {
    const lines = content.split('\n');
    // startLine/endLine are 1-based, inclusive
    return lines.slice(startLine - 1, endLine).join('\n');
}
