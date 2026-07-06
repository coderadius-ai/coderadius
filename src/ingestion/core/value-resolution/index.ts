import path from 'node:path';
import type { CodeChunk } from '../../../graph/types.js';
import { getAllPlugins, getPluginForExtension } from '../languages/registry.js';
import type { FileImportMap, ImportSpecifierBinding } from '../import-graph.js';
import type { SymbolRegistry } from '../symbol-registry.js';
import { astGrounding, compositeGrounding, type GroundingFields } from '../../../graph/grounding.js';
import {
    isNoisyBrokerName as isNameSafetyNoisyBroker,
    isHallucinatedTable as isNameSafetyHallucinatedTable,
    isUnsafeContainerName,
    isDynamicTableStub,
} from '../name-safety.js';
import type {
    CriticalInvocationFact,
    ResolvedInvocationArg,
    ResolvedResourceType,
    ValueFact,
    ValueResolutionMode,
} from './types.js';

export type {
    CriticalInvocationFact,
    ResolvedInvocationArg,
    ResolvedResourceType,
    ValueFact,
    ValueResolutionMode,
} from './types.js';

const MAX_TRACE_STEPS = 12;
const MAX_CROSS_FILE_DEPTH = 8;
const MAX_CONTEXT_INVOCATIONS = 20;
const MAX_CONTEXT_TRACE_LINES = 30;
const MAX_CONTEXT_CHARS = 3_000;
const MIN_STATIC_CONFIDENCE = 0.9;

type FileFacts = {
    facts: ValueFact[];
    invocations: CriticalInvocationFact[];
};

export interface ValueResolutionIndexInput {
    filePath: string;
    valueFacts: ValueFact[];
    criticalInvocations: CriticalInvocationFact[];
}

interface ResolveContext {
    atLine: number;
    chunkStartLine: number;
    chunkEndLine: number;
}

interface ImportTarget {
    filePath: string;
    key: string;
}

type ImportResolution = ImportTarget | { unresolved: true };

export class ValueResolutionIndex {
    private readonly byFile = new Map<string, FileFacts>();
    private readonly globalFacts = new Map<string, ValueFact[]>();
    private readonly importMaps = new Map<string, FileImportMap>();
    private readonly sourceToFile = new Map<string, string>();
    /**
     * Memo cache keyed by `${mode}:${filePath}:${startLine}:${resourceExpression}`.
     * VRI memo isolation: mode is part of the key so
     * `'value-only'` and `'full'` resolutions never share a cached entry. A
     * `'value-only'` resolution must NOT poison the `'full'` cache with a
     * `diBinding=undefined` result; subsequent `'full'` calls must re-run
     * with the DI registry now populated.
     */
    private readonly memo = new Map<string, ResolvedInvocationArg>();
    private readonly symbolRegistry?: SymbolRegistry;

    constructor(
        inputs: ValueResolutionIndexInput[],
        fileImportMaps: FileImportMap[],
        symbolRegistry?: SymbolRegistry,
    ) {
        this.symbolRegistry = symbolRegistry;
        for (const input of inputs) {
            const facts = (input.valueFacts ?? []).slice(0, 500);
            this.byFile.set(input.filePath, {
                facts,
                invocations: (input.criticalInvocations ?? []).slice(0, 500),
            });
            for (const fact of facts) {
                this.indexGlobalFact(fact);
            }
            this.sourceToFile.set(input.filePath, input.filePath);
            this.sourceToFile.set(stripExtension(input.filePath), input.filePath);
        }

        for (const importMap of fileImportMaps) {
            this.importMaps.set(importMap.filePath, importMap);
            this.sourceToFile.set(importMap.filePath, importMap.filePath);
            this.sourceToFile.set(stripExtension(importMap.filePath), importMap.filePath);
        }
    }

    /**
     * Direct registry lookup that bypasses `resolve()`'s class-only guard.
     * Used by the prompt-enrichment fallback in `resolveInvocation` to
     * surface boundComponent to the LLM even when the propagator hasn't
     * populated ioTags yet. NEVER used by the sanitizer path.
     */
    private lookupRawBinding(key: string): { boundComponent?: string; bindingFingerprint?: string } | null {
        if (!this.symbolRegistry) return null;
        for (const b of this.symbolRegistry.getAll()) {
            if (b.key === key) {
                return { boundComponent: b.boundComponent, bindingFingerprint: b.bindingFingerprint };
            }
        }
        return null;
    }

    resolveInvocationsForChunk(
        filePath: string,
        chunk: CodeChunk,
        opts: { mode?: ValueResolutionMode } = {},
    ): ResolvedInvocationArg[] {
        const mode: ValueResolutionMode = opts.mode ?? 'full';
        const fileFacts = this.byFile.get(filePath);
        if (!fileFacts) return [];

        const invocations = fileFacts.invocations.filter(invocation =>
            invocation.startLine >= chunk.startLine && invocation.endLine <= chunk.endLine,
        );

        const resolved: ResolvedInvocationArg[] = [];
        for (const invocation of invocations.slice(0, MAX_CONTEXT_INVOCATIONS)) {
            resolved.push(this.resolveInvocation(invocation, {
                atLine: invocation.startLine,
                chunkStartLine: chunk.startLine,
                chunkEndLine: chunk.endLine,
            }, mode));
        }
        return resolved;
    }

    private resolveInvocation(
        invocation: CriticalInvocationFact,
        context: ResolveContext,
        mode: ValueResolutionMode = 'full',
    ): ResolvedInvocationArg {
        const memoKey = `${mode}:${invocation.filePath}:${invocation.startLine}:${invocation.resourceExpression}`;
        const memo = this.memo.get(memoKey);
        if (memo) return memo;

        const resolved = invocation.resourceRole === 'messageClass'
            ? this.resolveMessageClassInvocation(invocation, context)
            : this.resolveExpression(
                invocation.filePath,
                invocation.resourceExpression,
                context,
                [],
                0,
            );
        const out: ResolvedInvocationArg = {
            ...resolved,
            invocation,
            confidence: Math.min(invocation.confidence, resolved.confidence),
        };

        // DI binding lookup (only in 'full' mode). The
        // propagator uses 'value-only' while *populating* ioTags, otherwise
        // the memo would freeze a pre-binding result.
        if (mode === 'full'
            && this.symbolRegistry
            && invocation.resourceRole === 'serviceId'
        ) {
            // Producer-side `resourceExpression` may carry surrounding
            // quotes (PHP `$container->get('id')` emits `"'id'"` after
            // JSON.stringify in the value-resolution extractor). Strip them
            // for the lookup; DiBindingResolver registers keys unquoted.
            const lookupKey = stripQuotesIfPresent(invocation.resourceExpression);
            // Try the method-aware resolver first (populates ioTags). When
            // the chainedMethod is unknown or no ioTags exist yet, fall
            // back to the raw registry lookup to surface the boundComponent
            // in the LLM prompt (Step 1 enrichment). The
            // resolved fact then carries `diBinding` with `ioTags: []`,
            // which the bypass invariant treats as "LLM-fallback territory".
            const di = invocation.chainedMethod
                ? this.symbolRegistry.resolveDi(lookupKey, invocation.filePath, invocation.chainedMethod)
                : null;
            if (di && di.binding.boundComponent) {
                out.diBinding = {
                    boundComponent: di.binding.boundComponent,
                    ioTags: di.ioTags,
                    bindingFingerprint: di.binding.bindingFingerprint,
                };
            } else {
                // Step 1 prompt-enrichment fallback: read the raw class-only
                // binding directly (resolve() drops it for the sanitizer;
                // we bypass that guard here because we are not the
                // sanitizer — we are emitting LLM prompt context).
                const raw = this.lookupRawBinding(lookupKey);
                if (raw?.boundComponent) {
                    out.diBinding = {
                        boundComponent: raw.boundComponent,
                        ioTags: [],
                        bindingFingerprint: raw.bindingFingerprint,
                    };
                }
            }
        }

        this.memo.set(memoKey, out);
        return out;
    }

    private resolveMessageClassInvocation(
        invocation: CriticalInvocationFact,
        context: ResolveContext,
    ): Omit<ResolvedInvocationArg, 'invocation'> {
        // The language plugin owns its framework's global routing-key
        // namespace AND its name normalization (PHP: backslash → dotted).
        const plugin = getPluginForExtension(path.extname(invocation.filePath));
        for (const routingKey of plugin?.globalValueKeysForMessageClass?.(invocation.resourceExpression) ?? []) {
            const fact = this.findGlobalFact(routingKey);
            if (!fact) continue;
            const resolved = this.resolveExpression(fact.filePath, routingKey, context, [`global:${routingKey}`], 0);
            return {
                ...resolved,
                originalExpression: invocation.resourceExpression,
                trace: [
                    `${invocation.resourceExpression} -> ${routingKey}`,
                    ...resolved.trace,
                ].slice(0, MAX_TRACE_STEPS),
                confidence: resolved.confidence,
            };
        }

        return this.resolveExpression(
            invocation.filePath,
            invocation.resourceExpression,
            context,
            [],
            0,
        );
    }

    private resolveExpression(
        filePath: string,
        expression: string,
        context: ResolveContext,
        stack: string[],
        depth: number,
    ): Omit<ResolvedInvocationArg, 'invocation'> {
        if (depth > MAX_CROSS_FILE_DEPTH) {
            return unresolved(expression, ['depth_exceeded'], 0.25, 'depth_exceeded');
        }

        const literal = extractStringLiteral(expression);
        if (literal !== undefined) {
            return {
                originalExpression: expression,
                resolvedValue: literal,
                trace: [`${expression} -> ${JSON.stringify(literal)}`],
                confidence: 1,
                complete: true,
            };
        }

        const fallback = extractFallback(expression);
        if (fallback) {
            const envKey = extractEnvKey(fallback.left);
            return {
                originalExpression: expression,
                resolvedValue: fallback.value,
                envKey,
                fallbackValue: fallback.value,
                trace: [`${expression} -> fallback/default ${JSON.stringify(fallback.value)}`],
                confidence: envKey ? 0.95 : 0.9,
                complete: true,
            };
        }

        const envKey = extractEnvKey(expression);
        if (envKey) {
            return {
                originalExpression: expression,
                envKey,
                trace: [`${expression} -> env ${envKey}`],
                confidence: 0.65,
                complete: false,
                dynamic: true,
                failureReason: 'dynamic',
            };
        }

        const key = canonicalKey(expression);
        if (!key) return unresolved(expression, [`${expression} -> dynamic`], 0.2, 'dynamic');

        const stackKey = `${filePath}:${key}`;
        if (stack.includes(stackKey)) {
            return unresolved(expression, [`${key} -> cycle_detected`], 0.2, 'cycle_detected');
        }

        const fact = this.findBestFact(filePath, key, context);
        if (fact) {
            return this.resolveFact(fact, expression, context, [...stack, stackKey], depth);
        }

        const globalFact = this.findGlobalFact(key);
        if (globalFact) {
            const globalStackKey = `global:${key}`;
            if (stack.includes(globalStackKey)) {
                return unresolved(expression, [`${key} -> cycle_detected`], 0.2, 'cycle_detected');
            }
            return this.resolveFact(globalFact, expression, context, [...stack, globalStackKey], depth);
        }

        const aliasTarget = this.resolveContainerAlias(filePath, key, context, stack, depth);
        if (aliasTarget) return aliasTarget;

        const imported = this.resolveImportTarget(filePath, key);
        if (imported) {
            if ('unresolved' in imported) {
                return unresolved(expression, [`${key} -> unresolved_import`], 0.2, 'unresolved_import');
            }
            const importedResult = this.resolveExpression(
                imported.filePath,
                imported.key,
                context,
                [...stack, stackKey],
                depth + 1,
            );
            return {
                ...importedResult,
                originalExpression: expression,
                trace: [
                    `${key} -> import ${imported.filePath}:${imported.key}`,
                    ...importedResult.trace,
                ].slice(0, MAX_TRACE_STEPS),
                confidence: importedResult.confidence * 0.95,
            };
        }

        const importedPrefix = this.resolveImportedPrefix(filePath, key);
        if (importedPrefix) {
            if ('unresolved' in importedPrefix) {
                return unresolved(expression, [`${key} -> unresolved_import`], 0.2, 'unresolved_import');
            }
            const importedResult = this.resolveExpression(
                importedPrefix.filePath,
                importedPrefix.key,
                context,
                [...stack, stackKey],
                depth + 1,
            );
            return {
                ...importedResult,
                originalExpression: expression,
                trace: [
                    `${key} -> import ${importedPrefix.filePath}:${importedPrefix.key}`,
                    ...importedResult.trace,
                ].slice(0, MAX_TRACE_STEPS),
                confidence: importedResult.confidence * 0.95,
            };
        }

        return unresolved(expression, [`${key} -> unknown`], 0.25, 'unknown');
    }

    private resolveFact(
        fact: ValueFact,
        originalExpression: string,
        context: ResolveContext,
        stack: string[],
        depth: number,
    ): Omit<ResolvedInvocationArg, 'invocation'> {
        const baseTrace = [`${originalExpression} -> ${fact.filePath}:${fact.key}`];

        if (fact.value !== undefined) {
            return {
                originalExpression,
                resolvedValue: fact.value,
                envKey: fact.envKey,
                fallbackValue: fact.fallbackValue,
                trace: [...baseTrace, `${fact.key} -> ${JSON.stringify(fact.value)}`].slice(0, MAX_TRACE_STEPS),
                confidence: fact.confidence,
                complete: true,
            };
        }

        if (fact.fallbackValue !== undefined) {
            return {
                originalExpression,
                resolvedValue: fact.fallbackValue,
                envKey: fact.envKey,
                fallbackValue: fact.fallbackValue,
                trace: [...baseTrace, `${fact.key} -> fallback/default ${JSON.stringify(fact.fallbackValue)}`].slice(0, MAX_TRACE_STEPS),
                confidence: fact.confidence,
                complete: true,
            };
        }

        if (fact.envKey) {
            return {
                originalExpression,
                envKey: fact.envKey,
                trace: [...baseTrace, `${fact.key} -> env ${fact.envKey}`].slice(0, MAX_TRACE_STEPS),
                confidence: Math.min(fact.confidence, 0.7),
                complete: false,
                dynamic: true,
                failureReason: 'dynamic',
            };
        }

        if (fact.targetKey) {
            const resolved = this.resolveExpression(fact.filePath, fact.targetKey, context, stack, depth + 1);
            return {
                ...resolved,
                originalExpression,
                trace: [...baseTrace, ...resolved.trace].slice(0, MAX_TRACE_STEPS),
                confidence: resolved.confidence * fact.confidence,
            };
        }

        return unresolved(originalExpression, [...baseTrace, `${fact.key} -> dynamic`], fact.confidence * 0.5, 'dynamic');
    }

    /**
     * Tries the longest container prefix first (`this.relayConfig` before
     * bare `this`), so a constructor-injected property alias
     * (`this.relayConfig` -> DI target) resolves ahead of a generic
     * one-level container alias (`this` -> DI container).
     */
    private resolveContainerAlias(
        filePath: string,
        key: string,
        context: ResolveContext,
        stack: string[],
        depth: number,
    ): Omit<ResolvedInvocationArg, 'invocation'> | null {
        const parts = key.split('.');
        if (parts.length < 2) return null;

        for (let split = parts.length - 1; split >= 1; split--) {
            const container = parts.slice(0, split).join('.');
            const rest = parts.slice(split).join('.');
            const aliasFact = this.findBestFact(filePath, container, context);
            if (!aliasFact?.targetKey) continue;

            const targetKey = `${aliasFact.targetKey}.${rest}`;
            const resolved = this.resolveExpression(filePath, targetKey, context, stack, depth + 1);
            return {
                ...resolved,
                originalExpression: key,
                trace: [`${key} -> ${targetKey}`, ...resolved.trace].slice(0, MAX_TRACE_STEPS),
                confidence: resolved.confidence * aliasFact.confidence,
            };
        }
        return null;
    }

    private findBestFact(filePath: string, key: string, context: ResolveContext): ValueFact | null {
        const facts = this.byFile.get(filePath)?.facts ?? [];
        const candidates = facts.filter(fact => fact.key === key || fact.exportedAs === key);
        if (candidates.length === 0) return null;

        const local = candidates
            .filter(fact => fact.startLine >= context.chunkStartLine && fact.startLine <= context.atLine)
            .sort((a, b) => b.startLine - a.startLine)[0];
        if (local) return local;

        const before = candidates
            .filter(fact => fact.startLine <= context.atLine)
            .sort((a, b) => b.startLine - a.startLine)[0];
        if (before) return before;

        return candidates.sort((a, b) => a.startLine - b.startLine)[0] ?? null;
    }

    private indexGlobalFact(fact: ValueFact): void {
        const key = fact.exportedAs ?? fact.key;
        if (!key) return;
        // Only plugin-claimed namespaces enter the global map (e.g. PHP's
        // `SymfonyMessenger.*` routing table). Aggregated over ALL plugins:
        // global facts are often emitted from CONFIG files (messenger.yaml),
        // so the fact's own extension cannot pick the owning plugin. Key
        // namespacing keeps the aggregation collision-free.
        if (!getAllPlugins().some(p => p.recognizesGlobalValueKey?.(key) ?? false)) return;
        const list = this.globalFacts.get(key) ?? [];
        list.push(fact);
        list.sort((a, b) => b.confidence - a.confidence || a.filePath.localeCompare(b.filePath));
        this.globalFacts.set(key, list);
    }

    private findGlobalFact(key: string): ValueFact | null {
        // The map only ever contains plugin-claimed keys (indexGlobalFact),
        // so a plain lookup is the whole check.
        return this.globalFacts.get(key)?.[0] ?? null;
    }

    private resolveImportTarget(filePath: string, key: string): ImportResolution | null {
        const importMap = this.importMaps.get(filePath);
        if (!importMap) return null;

        const parts = key.split('.');
        const local = parts[0];
        const rest = parts.slice(1);

        for (const imp of importMap.imports) {
            if (imp.isExternal) continue;
            const binding = findBinding(imp.specifierBindings, local);
            if (!binding) continue;

            const resolvedFile = this.resolveLocalImport(filePath, imp.source);
            if (!resolvedFile) return { unresolved: true };

            if (binding.kind === 'namespace') {
                if (rest.length === 0) return null;
                return { filePath: resolvedFile, key: rest.join('.') };
            }

            if (binding.kind === 'default') {
                const defaultKey = rest.length > 0 ? `default.${rest.join('.')}` : 'default';
                return { filePath: resolvedFile, key: defaultKey };
            }

            const importedKey = rest.length > 0 ? `${binding.imported}.${rest.join('.')}` : binding.imported;
            return { filePath: resolvedFile, key: importedKey };
        }

        return null;
    }

    private resolveImportedPrefix(filePath: string, key: string): ImportResolution | null {
        const parts = key.split('.');
        if (parts.length < 2) return null;

        const imported = this.resolveImportTarget(filePath, parts[0]);
        if (!imported || 'unresolved' in imported) return imported;

        return {
            filePath: imported.filePath,
            key: `${imported.key}.${parts.slice(1).join('.')}`,
        };
    }

    private resolveLocalImport(fromFile: string, importSource: string): string | null {
        if (this.sourceToFile.has(importSource)) return this.sourceToFile.get(importSource)!;

        const dir = path.posix.dirname(fromFile);
        const resolved = path.posix.normalize(path.posix.join(dir, importSource));
        const candidates = [
            resolved,
            `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
            `${resolved}.php`, `${resolved}.py`, `${resolved}.go`,
            `${resolved}/index.ts`, `${resolved}/index.js`, `${resolved}/__init__.py`,
        ];

        for (const candidate of candidates) {
            if (this.sourceToFile.has(candidate)) return this.sourceToFile.get(candidate)!;
        }

        const baseName = stripExtension(path.posix.basename(resolved));
        for (const [candidate, target] of this.sourceToFile.entries()) {
            if (stripExtension(path.posix.basename(candidate)) === baseName) return target;
        }

        return null;
    }
}

export function buildValueResolutionIndex(
    inputs: ValueResolutionIndexInput[],
    fileImportMaps: FileImportMap[],
    symbolRegistry?: SymbolRegistry,
): ValueResolutionIndex {
    return new ValueResolutionIndex(inputs, fileImportMaps, symbolRegistry);
}

export function formatResolvedInvocationContext(resolved: ResolvedInvocationArg[]): string | undefined {
    const relevant = resolved.slice(0, MAX_CONTEXT_INVOCATIONS);
    if (relevant.length === 0) return undefined;

    const lines: string[] = ['--- Resolved Critical I/O Arguments (static value resolution) ---'];
    let traceLines = 0;

    for (const item of relevant) {
        const inv = item.invocation;
        lines.push(`${inv.callee}(${inv.resourceExpression})`);
        lines.push(`  resource: ${inv.resourceRole} → ${inv.resourceType} ${inv.operation}`);
        if (item.resolvedValue !== undefined) lines.push(`  resolvedValue: ${JSON.stringify(item.resolvedValue)}`);
        if (item.envKey) lines.push(`  envKey: ${item.envKey}`);
        if (item.fallbackValue !== undefined) lines.push(`  fallback/default: ${JSON.stringify(item.fallbackValue)}`);
        lines.push(`  confidence: ${item.confidence.toFixed(2)} (${item.complete ? 'complete' : item.failureReason ?? 'incomplete'})`);

        // When the DI binding registry resolved this
        // invocation to a concrete component, surface it to the LLM so the
        // prompt-only path (Step 1) at least benefits from the FQCN even
        // before the propagator-driven bypass (Step 2) is online.
        if (item.diBinding) {
            lines.push(`  boundComponent: ${item.diBinding.boundComponent}`);
            if (item.invocation.chainedMethod) {
                lines.push(`  chainedMethod: ${item.invocation.chainedMethod}`);
            }
        }

        for (const trace of item.trace) {
            if (traceLines >= MAX_CONTEXT_TRACE_LINES) break;
            lines.push(`  trace: ${trace}`);
            traceLines++;
        }
    }

    lines.push('--- End Resolved Critical I/O Arguments ---');
    const block = lines.join('\n');
    return block.length > MAX_CONTEXT_CHARS ? `${block.slice(0, MAX_CONTEXT_CHARS)}\n...(truncated)` : block;
}

/**
 * Map a ResolvedInvocation's `resourceType` + `resourceRole` to a coarse kind
 * family signal. Used downstream by `resolveDatastoreBinding` to refuse
 * incompatible Datastore bindings (e.g. a SQL `prepare`/`query`/`update` call
 * MUST NOT bind to a MongoDB connection just because it's the only
 * auto-discovered hint).
 *
 * Conservative: returns undefined when the role is opaque or the resource
 * type doesn't pin a single family. The downstream gate treats undefined as
 * "no constraint" — so missing signals never cause regressions, only
 * insufficient evidence.
 */
function inferKindFamilyFromRole(
    type: ResolvedResourceType,
    role: string,
): 'rdbms' | 'document' | 'kv' | 'timeseries' | undefined {
    const r = role.toLowerCase();
    if (type === 'Database') {
        // SQL surface (PHP PDO/Doctrine, TS pg/mysql/Drizzle, Python sqlalchemy,
        // Go database/sql, etc.) — every plugin's SQL extractor uses one of
        // these role names. They are unambiguously relational.
        // 'tableorsql' is the role emitted by the generic-extractor fallback
        // (extractors.ts) for `query/execute/prepare/from(...)` calls when the
        // language plugin doesn't refine it further. 'sqlquery' / 'sql' /
        // 'table' come from the PHP plugin's table-method classification.
        if (r === 'sql' || r === 'sqlquery' || r === 'table' || r === 'tableorsql') return 'rdbms';
        // ODM / document surface (mongo collections, couchdb docs).
        if (r === 'collection' || r === 'document' || r === 'mongocollection') return 'document';
        // Time-series write surface (InfluxDB writePoints, etc.) — schemaless,
        // maps to the timeseries family so the binding gate accepts the connection.
        if (r === 'timeseries') return 'timeseries';
    }
    if (type === 'Cache') return 'kv';
    return undefined;
}

export interface StaticInfraItem {
    name: string;
    type: ResolvedResourceType;
    operation: 'READS' | 'WRITES' | 'MAPS_TO';
    channelKind?: 'topic' | 'subscription' | 'queue' | 'exchange';
    kindFamily?: 'rdbms' | 'document' | 'kv' | 'timeseries' | 'broker' | 'queue' | 'object';
    /** Graph-writer reads `source`/`resolved_via`/`grounding`. */
    source?: 'ast' | 'llm';
    resolved_via?: string;
    grounding?: import('../../../graph/grounding.js').GroundingFields;
}

/**
 * Narrow plugin view for name-safety composition: framework DI-handle
 * shapes are ecosystem grammar owned by the language plugin
 * (`recognizesFrameworkDiHandle`), composed here with the agnostic
 * name-safety predicates on BOTH resource kinds.
 */
export interface StaticNameSafetyPlugin {
    recognizesFrameworkDiHandle?(name: string, kind: 'channel' | 'container'): boolean;
}

export function buildStaticAnalysisFromResolvedInvocations(
    resolved: ResolvedInvocationArg[],
    chunkSourceCode?: string,
    plugin?: StaticNameSafetyPlugin,
): {
    has_io: true;
    intent: string;
    infrastructure: StaticInfraItem[];
    capabilities: string[];
    emergent_api_calls: Array<{ method: string; path: string; direction: 'INBOUND' | 'OUTBOUND' }>;
} | null {
    if (resolved.length === 0) return null;

    // ── Hard invariant ─────────────────────────────────────
    // A `serviceId` invocation without a `diBinding.ioTags` resolved means
    // the DI bypass cannot fire. Fall through to LLM rather than emitting
    // a partial result. Same applies to invocations where the propagator
    // emitted ioTags but they were filtered to zero by the chained-method
    // method filter (binding.ioTags exists but item.diBinding does not).
    for (const item of resolved) {
        if (item.invocation.resourceRole === 'serviceId') {
            if (!item.diBinding || item.diBinding.ioTags.length === 0) return null;
        }
    }

    // Other prompt-only roles (messageClass, parameterId, configRef)
    // still abort the static path entirely (LLM is the right tool there).
    if (resolved.some(item => isPromptOnlyResourceRole(item.invocation.resourceRole, item))) return null;
    // Fail-closed on ANY unresolved MessageChannel invocation.
    //
    // Mixed DB+broker functions previously bypassed the LLM here: the DB call
    // resolved cleanly while a DI-bound topic name (e.g. `payment.completed.v2`,
    // `refund.initiated`, `payment_order_queue`) landed below the 0.5 confidence
    // floor or was silently elided from the static analysis. The DataContainer
    // was persisted, the MessageChannel never appeared, and the sanitizer/DI-
    // registry path that recovers DI keys only runs on the LLM branch — so
    // the channel was lost forever.
    //
    // Scope of the guard:
    //   - MessageChannel only — that's the resource family that depends on the
    //     LLM/DI-registry path to recover its name. SQL queries, cache keys,
    //     and HTTP URLs already reach the static path via their own literal
    //     args; an unresolved *connection metadata* invocation (e.g.
    //     process.env.DB_ORDERS) MUST NOT block a function whose actual SQL
    //     literal is fully resolved.
    //   - Prompt-only roles (messageClass, serviceId, parameterId,
    //     configRef) are deliberately excluded — those are routed to the
    //     LLM by design via the earlier guard.
    if (resolved.some(item =>
        !item.complete
        && !isPromptOnlyResourceRole(item.invocation.resourceRole)
        && item.invocation.resourceType === 'MessageChannel'
    )) {
        return null;
    }

    const infra = new Map<string, StaticInfraItem>();
    const emergentApiCalls: Array<{ method: string; path: string; direction: 'INBOUND' | 'OUTBOUND' }> = [];

    // ── DI bypass branch ─────────────────────────────────
    // For each serviceId invocation that carries diBinding+ioTags, expand
    // into N synthetic infrastructure items. Each item runs through the
    // selective name-safety validation (using the bound method's source
    // slice, NOT the consumer chunk) before being committed.
    //
    // Fail-closed: for every serviceId invocation
    // that had non-empty ioTags going in, at least one item MUST survive
    // validation. Otherwise we return null (LLM fallback).
    let validationDroppedAllForServiceId = false;
    for (const item of resolved) {
        if (item.invocation.resourceRole !== 'serviceId') continue;
        if (!item.diBinding || item.diBinding.ioTags.length === 0) continue;

        let survivedAny = false;
        for (const tag of item.diBinding.ioTags) {
            const channelName = tag.channelName;
            if (!channelName) continue;
            if (isUnsafeStaticResourceName(channelName)) continue;
            if (tag.resourceType === 'MessageChannel'
                && (isNameSafetyNoisyBroker(channelName)
                    || plugin?.recognizesFrameworkDiHandle?.(channelName, 'channel'))) continue;
            if (tag.resourceType === 'Database' || tag.resourceType === 'ObjectStorage') {
                // Container name-safety against the bound method's source slice
                // (the consumer chunk does not contain the table literal).
                // isUnsafeContainerName composes the DI-service-locator
                // -key shape (e.g. 'archive.mongodb.client') with the existing
                // hallucination/system/type-token guards — the static path skips
                // the sanitizer, so this is the only gate it gets. Framework
                // DI-handle shapes are plugin grammar, composed alongside.
                if (isUnsafeContainerName(channelName, { sourceCode: tag.evidenceSource.sourceSlice })
                    || plugin?.recognizesFrameworkDiHandle?.(channelName, 'container')) {
                    continue;
                }
            }

            // ExternalAPI items have no `infrastructure`
            // persistence path in graph-writer. Route them to
            // `emergent_api_calls` instead so the endpoint persists as
            // OUTBOUND — otherwise the static bypass silently loses
            // ExternalAPI nodes.
            if (tag.resourceType === 'ExternalAPI') {
                const path = channelName;
                emergentApiCalls.push({
                    method: 'GET',
                    path,
                    direction: 'OUTBOUND',
                });
                survivedAny = true;
                continue;
            }

            const resource: StaticInfraItem = {
                name: channelName,
                type: tag.resourceType,
                operation: tag.operation,
                channelKind: tag.channelKind,
                kindFamily: inferKindFamilyFromRole(tag.resourceType, tag.method),
                // Stamp explicit AST grounding with DI evidence in
                // evidence.extractors. graph-writer's groundingForInfra
                // helper returns this verbatim.
                grounding: makeDiAstGrounding(tag.hopCount),
            };
            const key = `${resource.type}:${resource.operation}:${resource.name}`;
            if (!infra.has(key)) infra.set(key, resource);
            survivedAny = true;
        }
        if (!survivedAny) validationDroppedAllForServiceId = true;
    }

    // Fail-closed: if any serviceId had ioTags but
    // zero items survived validation, do NOT emit partial result. The
    // function falls back to LLM rather than masking an unsafe DI alias
    // with a literal-resolved sibling.
    if (validationDroppedAllForServiceId) return null;

    for (const item of resolved) {
        if (item.invocation.resourceRole === 'serviceId') continue; // already handled above
        // Time-series writes (InfluxDB `writePoints`) are schemaless: there is no
        // table/measurement to resolve, so the completeness + table-name +
        // confidence guards below don't apply (the unresolvable points arg drives
        // confidence down, but the role itself — set only by the writePoints
        // method match — is a certain signal). Emit a measurement-less Database
        // item that the graph-writer binds function->Datastore directly via
        // kindFamily 'timeseries' (its `<DYNAMIC>` no-DataContainer path), like memcached.
        if (item.invocation.resourceRole === 'timeseries') {
            const tsKey = `${item.invocation.resourceType}:${item.invocation.operation}:timeseries`;
            if (!infra.has(tsKey)) {
                infra.set(tsKey, {
                    name: '<DYNAMIC>',
                    type: item.invocation.resourceType,
                    operation: item.invocation.operation,
                    kindFamily: 'timeseries',
                });
            }
            continue;
        }
        // MongoDB collections with a DYNAMIC name (`selectCollection($db,
        // sprintf(...))`) cannot resolve the collection name, but role='collection'
        // is a certain document-family signal from the driver method match. Emit a
        // name-less <DYNAMIC> document item (the timeseries/writePoints precedent)
        // so the function binds to the Mongo datastore, instead of dropping the
        // signal and letting the family-less name default to RDBMS downstream. A
        // RESOLVED collection name (complete) keeps its own named DataContainer.
        if (item.invocation.resourceRole === 'collection' && !item.complete) {
            const docKey = `${item.invocation.resourceType}:${item.invocation.operation}:document`;
            if (!infra.has(docKey)) {
                infra.set(docKey, {
                    name: '<DYNAMIC>',
                    type: item.invocation.resourceType,
                    operation: item.invocation.operation,
                    kindFamily: 'document',
                });
            }
            continue;
        }
        if (!item.complete || item.confidence < MIN_STATIC_CONFIDENCE) continue;
        if (!isStaticEligibleInvocation(item)) continue;
        const name = normalizeStaticResourceName(item);
        if (!name || isUnsafeStaticResourceName(name)) continue;
        // Container name-safety for store-backed items (the static path skips the
        // sanitizer, so this is the only DataContainer gate). Shape-only here (no
        // source slice): drops type/transport tokens, DI keys, system/generic/
        // property names, templates, path leaks; preserves cloud buckets.
        // Framework DI-handle shapes are plugin grammar, composed alongside.
        if ((item.invocation.resourceType === 'Database' || item.invocation.resourceType === 'ObjectStorage')
            && (isUnsafeContainerName(name)
                || plugin?.recognizesFrameworkDiHandle?.(name, 'container'))) continue;

        const kindFamily = inferKindFamilyFromRole(item.invocation.resourceType, item.invocation.resourceRole);
        const resource: StaticInfraItem = {
            name,
            type: item.invocation.resourceType,
            operation: item.invocation.operation,
            ...(channelKindForRole(item.invocation.resourceRole) ? { channelKind: channelKindForRole(item.invocation.resourceRole)! } : {}),
            ...(kindFamily ? { kindFamily } : {}),
        };
        const key = `${resource.type}:${resource.operation}:${resource.name}`;
        if (!infra.has(key)) infra.set(key, resource);
    }

    void chunkSourceCode; // reserved for future consumer-source-based validations

    const infrastructure = [...infra.values()];
    if (infrastructure.length === 0 && emergentApiCalls.length === 0) return null;

    return {
        has_io: true,
        intent: `Deterministic I/O resource resolved from static value analysis.`,
        infrastructure,
        capabilities: capabilitiesForInfrastructure(infrastructure),
        emergent_api_calls: emergentApiCalls,
    };
}

function isStaticEligibleInvocation(item: ResolvedInvocationArg): boolean {
    const callee = item.invocation.callee.toLowerCase();
    if (item.invocation.resourceType === 'Database') {
        // Match either a standalone DB-method keyword (`->prepare`, `->query`)
        // or a camelCase compound used by the Mongo PHP / Mongoose drivers
        // (`->selectCollection`, `->createCollection`). The compound forms
        // don't have a word boundary before `Collection`, so they need to be
        // listed explicitly in addition to the bare-word alternation.
        return /\b(collection|table|from|query|execute|prepare|exec|find|insert|update|delete|writepoint|writepoints)\b|select(?:collection|database)|createcollection/i.test(callee);
    }
    if (item.invocation.resourceType === 'ExternalAPI') {
        const value = item.resolvedValue ?? item.fallbackValue ?? '';
        return /(?:fetch|axios|curl|requests|http\.)/i.test(item.invocation.callee)
            && /^(https?:\/\/|\/|[A-Za-z0-9_.-]+\/)/.test(value);
    }
    if (item.invocation.resourceType === 'MessageChannel') {
        if (/^(publish|send_task|basic_publish|queue_declare|basic_consume)$/.test(callee)) return true;
        return /(outbox|adapter|bus|broker|queue|topic|subscription|kafka|rabbit|pubsub|sns|sqs|nats|producer|publisher|consumer|client|message)/i.test(item.invocation.callee);
    }
    if (item.invocation.resourceType === 'ObjectStorage') {
        return /(bucket|s3|storage|blob|gcs)/i.test(item.invocation.callee);
    }
    if (item.invocation.resourceType === 'Cache') {
        return /(cache|redis|memcache)/i.test(item.invocation.callee);
    }
    return true;
}

/**
 * Build the AST-grounded GroundingFields for an item emitted by the DI
 * static-bypass path: same-source `compositeGrounding(ast, ast)`
 * keeps `source='ast'` and surfaces DI provenance via evidence.extractors
 * (see grounding.ts:175 same-source merge rule). The graph-writer's
 * groundingForInfra helper returns this verbatim — never falls back to
 * the LLM grounding branch.
 */
function stripQuotesIfPresent(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' || first === "'" || first === '`') && first === last) {
            return s.slice(1, -1);
        }
    }
    return s;
}

function makeDiAstGrounding(hopCount: number): GroundingFields {
    return compositeGrounding(
        astGrounding('di-binding-resolver@v1'),
        astGrounding(`di-propagator-hop${hopCount}@v1`),
    );
}

function isPromptOnlyResourceRole(role: string, item?: ResolvedInvocationArg): boolean {
    // `serviceId` is normally prompt-only, but when the DI
    // binding registry resolved it AND the propagator stamped matching
    // ioTags for the chained method, the static bypass takes over.
    if (role === 'serviceId') {
        if (item?.diBinding && item.diBinding.ioTags.length > 0) return false;
        return true;
    }
    return role === 'messageClass'
        || role === 'parameterId'
        || role === 'configRef';
}

function findBinding(bindings: ImportSpecifierBinding[] | undefined, local: string): ImportSpecifierBinding | null {
    if (!bindings || bindings.length === 0) return null;
    return bindings.find(binding => binding.local === local) ?? null;
}

function unresolved(
    expression: string,
    trace: string[],
    confidence: number,
    failureReason: ResolvedInvocationArg['failureReason'],
): Omit<ResolvedInvocationArg, 'invocation'> {
    return {
        originalExpression: expression,
        trace,
        confidence,
        complete: false,
        dynamic: failureReason === 'dynamic',
        failureReason,
    };
}

export function canonicalKey(expression: string): string {
    let out = expression.trim();
    out = out.replace(/;$/, '');
    out = out.replace(/\s+/g, '');
    out = out.replace(/\?\./g, '.');
    out = out.replace(/!$/g, '');
    out = out.replace(/^this->/, 'this.');
    out = out.replace(/\$this->/g, 'this.');
    out = out.replace(/->/g, '.');
    out = out.replace(/::/g, '.');
    out = out.replace(/^self\./, 'this.');
    out = out.replace(/^self::/, 'this.');
    out = out.replace(/^self\./, 'this.');
    out = out.replace(/^self/, 'this');
    out = out.replace(/^self\./, 'this.');
    out = out.replace(/^self::/, 'this.');
    out = out.replace(/^self\./, 'this.');
    out = out.replace(/\$/g, '');
    out = out.replace(/\[['"`]([^'"`]+)['"`]\]/g, '.$1');
    out = out.replace(/\["([^"]+)"\]/g, '.$1');
    out = out.replace(/\['([^']+)'\]/g, '.$1');
    out = out.replace(/\[`([^`]+)`\]/g, '.$1');
    out = out.replace(/^self\./, 'this.');
    out = out.replace(/^self$/, 'this');
    out = out.replace(/^this\./, 'this.');
    out = out.replace(/^self::/, 'this.');
    out = out.replace(/^self\./, 'this.');
    return out;
}

export function extractStringLiteral(expression: string): string | undefined {
    const trimmed = expression.trim();
    const match = trimmed.match(/^(['"`])([\s\S]*)\1$/);
    if (!match) return undefined;
    if (match[2].includes('${')) return undefined;
    return match[2].replace(/\\(['"`\\])/g, '$1');
}

function extractFallback(expression: string): { left: string; value: string } | null {
    const patterns = [
        /^([\s\S]+?)\s*(?:\?\?|\|\|)\s*(['"`])([\s\S]*?)\2$/,
        /^([\s\S]+?)\s+or\s+(['"`])([\s\S]*?)\2$/,
        /^([\s\S]+?)\s*:\s*(['"`])([\s\S]*?)\2$/,
    ];
    for (const pattern of patterns) {
        const match = expression.match(pattern);
        if (match && !match[3].includes('${')) return { left: match[1], value: match[3] };
    }

    const defaultMatch = expression.match(/\.(?:default|catch)\(\s*(['"`])([\s\S]*?)\1\s*\)/);
    if (defaultMatch && !defaultMatch[2].includes('${')) {
        return { left: expression.slice(0, defaultMatch.index), value: defaultMatch[2] };
    }

    const getenvDefault = expression.match(/(?:os\.getenv|os\.environ\.get)\(\s*(['"`])([A-Z][A-Z0-9_]*)\1\s*,\s*(['"`])([\s\S]*?)\3\s*\)/);
    if (getenvDefault) return { left: `env:${getenvDefault[2]}`, value: getenvDefault[4] };

    return null;
}

export function extractEnvKey(expression: string): string | undefined {
    const patterns = [
        /process\.env\.([A-Z][A-Z0-9_]*)/,
        /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/,
        /getenv\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\)/,
        /\$_(?:ENV|SERVER)\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/,
        /os\.(?:getenv|environ\.get)\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/,
        /os\.environ\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/,
        /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/,
    ];

    for (const pattern of patterns) {
        const match = expression.match(pattern);
        if (match) return match[1];
    }
    return undefined;
}

function normalizeStaticResourceName(item: ResolvedInvocationArg): string | null {
    const value = item.resolvedValue ?? item.fallbackValue;
    if (!value) return null;
    if (item.invocation.resourceType === 'Database') {
        const fromSql = extractSqlTableName(value);
        if (fromSql) return fromSql;
        // Dynamic-name stubs (`quote_{tipo}`) are valid resource names: a later
        // welder expands the {placeholder}. Accept them so a dynamic Mongo
        // collection (or SQL table) keeps a named node instead of being dropped
        // by the bare-identifier check (which rejects the `{}` braces).
        if (isDynamicTableStub(value)) return value;
        // No `FROM`/`INTO`/`UPDATE` table found in the resolved value.
        // Two cases:
        //   1. value is a clean identifier ("users", "wp_posts") — accept.
        //   2. value is a SQL FRAGMENT like
        //        'SELECT comune, prov, istat, code AS codice_catastale, '
        //      The resolver only saw the FIRST `$sql = '...'` assignment;
        //      the actual table name lives in a later `.=` concatenation
        //      it didn't follow. Returning the fragment as the resource
        //      name produces a bogus DataContainer literally titled with
        //      the SQL fragment. Defer to the LLM in that case.
        if (looksLikeBareIdentifier(value)) return value;
        return null;
    }
    return value;
}

function extractSqlTableName(value: string): string | null {
    const match = value.match(/\b(?:from|into|update|table|join)\s+["`]?([A-Za-z_][A-Za-z0-9_.$-]*)["`]?/i);
    return match?.[1] ?? null;
}

/**
 * True when `value` looks like a single SQL identifier (a plausible table or
 * collection name) — no whitespace, no SQL keywords, no punctuation outside
 * the identifier-safe set. Anything more complex is rejected so the resolver
 * defers to the LLM, which sees the full source code (including any
 * `.=`-style SQL concatenations the static path could not follow).
 */
function looksLikeBareIdentifier(value: string): boolean {
    const v = value.trim();
    if (!v) return false;
    return /^[A-Za-z_][A-Za-z0-9_.$-]*$/.test(v);
}

function isUnsafeStaticResourceName(name: string): boolean {
    if (!name || name.length > 240) return true;
    if (/^(unknown|dynamic|undefined|null|outbox)$/i.test(name)) return true;
    if (/\$\w|\{\$|\$\{|%[sd]/.test(name)) return true;
    return false;
}

function channelKindForRole(role: string): 'topic' | 'subscription' | 'queue' | 'exchange' | undefined {
    if (/topic/i.test(role)) return 'topic';
    if (/subscription/i.test(role)) return 'subscription';
    if (/queue/i.test(role)) return 'queue';
    if (/exchange/i.test(role)) return 'exchange';
    return undefined;
}

function capabilitiesForInfrastructure(
    infrastructure: Array<{ type: ResolvedResourceType; operation: 'READS' | 'WRITES' | 'MAPS_TO' }>,
): string[] {
    const out = new Set<string>();
    for (const infra of infrastructure) {
        if (infra.type === 'MessageChannel') out.add(infra.operation === 'READS' ? 'event-consumer' : 'event-publisher');
        if (infra.type === 'Database') out.add(infra.operation === 'READS' ? 'database-reader' : 'database-writer');
        if (infra.type === 'ExternalAPI') out.add('external-api-client');
        if (infra.type === 'Cache') out.add('cache-client');
        if (infra.type === 'ObjectStorage') out.add('object-storage-client');
        if (infra.type === 'Process') out.add('process-runner');
    }
    return [...out];
}

function stripExtension(filePath: string): string {
    return filePath.replace(/\.(ts|tsx|js|jsx|php|py|go|ya?ml)$/i, '');
}
