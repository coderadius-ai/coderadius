import type { CodeChunk } from '../../../graph/types.js';
import type { GroundingFields } from '../../../graph/grounding.js';

export type ResolvedResourceType = 'Database' | 'MessageChannel' | 'Cache' | 'ObjectStorage' | 'ExternalAPI' | 'Process';
export type ResolvedOperation = 'READS' | 'WRITES' | 'MAPS_TO';

export interface ValueFact {
    filePath: string;
    language: CodeChunk['language'];
    key: string;
    expression: string;
    kind: 'literal' | 'alias' | 'object-property' | 'env' | 'fallback' | 'schema-default' | 'dynamic';
    value?: string;
    envKey?: string;
    fallbackValue?: string;
    targetKey?: string;
    exported?: boolean;
    exportedAs?: string;
    /** @deprecated use `grounding.quality` (confidence float is being phased out, POC migration in progress) */
    confidence: number;
    /** Grounding: source/quality/evidence. Optional during the POC migration; required once all producers populate it. */
    grounding?: GroundingFields;
    startLine: number;
    endLine: number;
}

export interface CriticalInvocationFact {
    filePath: string;
    language: CodeChunk['language'];
    callee: string;
    resourceExpression: string;
    resourceRole: string;
    resourceType: ResolvedResourceType;
    operation: ResolvedOperation;
    /** @deprecated use `grounding.quality` (confidence float is being phased out, POC migration in progress) */
    confidence: number;
    /** Grounding: source/quality/evidence. Optional during the POC migration; required once all producers populate it. */
    grounding?: GroundingFields;
    startLine: number;
    endLine: number;
    evidence?: string;
    /**
     * For invocations on a DI alias, the chained method invoked on the
     * resolved component. Populated by the PHP language
     * plugin via local-var taint and property-fetch resolution:
     *
     *   Pattern A: $svc = $container->get('id'); $svc->publish(...)
     *   Pattern B: $this->publisher->publish(...) (ctor-injected property)
     *
     * Consumed by `SymbolRegistry.resolveDi(key, file, chainedMethod)` to
     * filter ioTags for the specific invoked operation. Undefined means the
     * propagator falls back to LLM (ambiguity guard).
     */
    chainedMethod?: string;
}

export interface ResolvedValue {
    originalExpression: string;
    resolvedValue?: string;
    envKey?: string;
    fallbackValue?: string;
    trace: string[];
    /** @deprecated use `grounding.quality` (confidence float is being phased out, POC migration in progress) */
    confidence: number;
    /** Grounding: source/quality/evidence. Optional during the POC migration; required once all producers populate it. */
    grounding?: GroundingFields;
    complete: boolean;
    dynamic?: boolean;
    failureReason?: 'unknown' | 'ambiguous' | 'dynamic' | 'cycle_detected' | 'depth_exceeded' | 'unresolved_import';
}

export interface ResolvedInvocationArg extends ResolvedValue {
    invocation: CriticalInvocationFact;
    /**
     * DI binding resolution result. Populated by
     * `ValueResolutionIndex.resolveInvocation` when `mode==='full'` and the
     * invocation's `serviceId` key matches a binding in the SymbolRegistry
     * AND the binding has matching ioTags for `invocation.chainedMethod`.
     *
     * Must be undefined when the propagator runs in `'value-only'` mode
     * (avoids memo poisoning, see the DI I/O propagator).
     */
    diBinding?: {
        boundComponent: string;
        ioTags: import('../symbol-registry.js').DiIoTag[];
        bindingFingerprint?: string;
    };
}

/**
 * Resolution mode for `ValueResolutionIndex.resolveInvocationsForChunk`.
 *
 * - `'full'` (default): consults `SymbolRegistry.resolveDi` to populate
 *   `ResolvedInvocationArg.diBinding`. Used by the standard semantic-extractor
 *   pipeline.
 * - `'value-only'`: skips DI registry lookup entirely. Used by the
 *   DiIoPropagator while it is *populating* the registry, to avoid memo
 *   poisoning. Memo cache is keyed by mode so the two modes
 *   never share a memoized result.
 */
export type ValueResolutionMode = 'full' | 'value-only';
