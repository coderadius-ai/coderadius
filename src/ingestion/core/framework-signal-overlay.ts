/**
 * Framework-signal consumption (agnostic core).
 *
 * Framework signals are PRODUCED by language plugins: each plugin owns its own
 * decorator/builder/annotation grammar (TypeScript in
 * `languages/typescript/framework-signals.ts`, and any future language plugin)
 * and emits the agnostic `FrameworkSignal` shape from `languages/types.ts`.
 *
 * They are CONSUMED here by the agnostic pipeline, which knows nothing about
 * any particular language: it matches signals to a code chunk, formats them for
 * the LLM prompt, builds an overlay of AST-grounded facts (routes, infra,
 * capabilities), and merges that overlay into the LLM's UnifiedAnalysis. None
 * of this depends on TS/PHP/Go syntax, so it lives in the core (a
 * `languages/` → `core/` import here would be a layering violation; the
 * consumers below are imported by the agnostic pipeline stages).
 *
 * Note: `CONSUMER_ENTRYPOINT_METHODS` deliberately contains PHP's `__invoke`
 * entrypoint (Symfony Messenger / Laravel Jobs / ADR invocable classes),
 * confirming this matcher is cross-language and belongs in the core, not in the
 * TypeScript plugin.
 */
import type { UnifiedAnalysis } from '../../ai/agents/unified-analyzer.js';
import type { FrameworkSignal, FrameworkSignalMetadataValue } from './languages/types.js';
import { scrubDecoratorSecrets } from './decorator-scrubber.js';

type InfraRef = NonNullable<UnifiedAnalysis['infrastructure']>[number];
type ApiCall = NonNullable<UnifiedAnalysis['emergent_api_calls']>[number];

export interface FrameworkSignalOverlay {
    forceHasIo: boolean;
    intent?: string;
    infrastructure: InfraRef[];
    capabilities: string[];
    emergentApiCalls: ApiCall[];
    allowedInboundPaths: Set<string>;
}

const HARD_ENTRYPOINT_CAPABILITIES = new Set([
    'http-handler',
    'graphql-handler',
    'message-consumer',
    'scheduled-job',
    'cli-entrypoint',
]);

/**
 * Returns true if any of the given signals declares a hard entrypoint capability
 * (http-handler, graphql-handler, message-consumer, scheduled-job, cli-entrypoint).
 *
 * Used by the pre-LLM heuristic filter (Gate 7) to rescue thin controller methods
 * that would otherwise be dropped because their body has no direct I/O patterns.
 */
export function hasHardEntrypointCapability(signals: FrameworkSignal[]): boolean {
    return signals.some(s => HARD_ENTRYPOINT_CAPABILITIES.has(s.metadata?.capability as string));
}

/** Consumer entrypoint method names. Only these methods receive class-level message-consumer infra edges. */
const CONSUMER_ENTRYPOINT_METHODS = new Set([
    'handle', 'handleEvent', 'handleMessage',
    'consume', 'process', 'onMessage', 'execute', 'run',
    '__invoke',  // PHP: Symfony Messenger, Laravel Jobs, ADR pattern (invocable classes)
]);

export function matchFrameworkSignalsToChunk(
    chunkName: string,
    signals: FrameworkSignal[],
): FrameworkSignal[] {
    if (signals.length === 0) return [];

    const className = deriveClassName(chunkName);
    return signals.filter(signal => {
        if (signal.scope === 'method') return signal.ownerName === chunkName;
        if (signal.scope === 'class') {
            const classMatch = signal.ownerName === chunkName || (className !== null && signal.ownerName === className);
            if (!classMatch) return false;

            // Class-level message-consumer: only propagate to consumer entrypoint methods
            if (signal.kind === 'message-consumer' && className !== null && signal.ownerName !== chunkName) {
                const methodName = chunkName.slice(className.length + 1); // strip "ClassName."
                return CONSUMER_ENTRYPOINT_METHODS.has(methodName);
            }
            return true;
        }
        return false;
    });
}

const DECORATOR_TEXT_MAX_CHARS = 200;

export function formatFrameworkSignalContext(signals: FrameworkSignal[]): string | undefined {
    if (signals.length === 0) return undefined;

    const lines = signals.map(signal => {
        const summary: string[] = [
            `${signal.ownerName}`,
            `${signal.kind}`,
            signal.framework,
        ];

        if (signal.resolvedName) summary.push(`resolved=${signal.resolvedName}`);

        // Raw decorator AST text gives the LLM the exact symbol it should reason about
        // (channel name, queue, route key) even when the parser has not produced a
        // resolvedName. Custom-wrapped decorators (e.g. customer SDK wrappers) without
        // a coderadius.yaml registration land here as last-resort fallback.
        //
        // We scrub sensitive key/value pairs BEFORE truncation. Without this, a
        // secret hard-coded at the start of the decorator argument list
        // (`@Consumer({password: 'dev123', ...})`) would slip through even with
        // the 200-char cap. See decorator-scrubber.ts.
        const rawDecorator = signal.metadata?.decoratorText;
        if (typeof rawDecorator === 'string' && rawDecorator.length > 0) {
            const scrubbed = scrubDecoratorSecrets(rawDecorator);
            const trimmed = scrubbed.length > DECORATOR_TEXT_MAX_CHARS
                ? `${scrubbed.slice(0, DECORATOR_TEXT_MAX_CHARS)}...[truncated]`
                : scrubbed;
            summary.push(`raw_decorator=${trimmed}`);
        }

        const metadataBits = Object.entries(signal.metadata ?? {})
            .filter(([key, value]) =>
                key !== 'decoratorText' && value !== undefined && value !== null && value !== '',
            )
            .slice(0, 4)
            .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : value}`);

        if (metadataBits.length > 0) summary.push(metadataBits.join(', '));
        return `- ${summary.join(' | ')}`;
    });

    return `
--- Framework Signals (resolved from decorators/builders) ---
The following framework-level facts are ground truth from the AST.
Use them to interpret decorators, route prefixes, ORM entities/models, broker bindings, and DTO metadata.

${lines.join('\n')}
--- End Framework Signals ---`;
}

export function buildFrameworkSignalOverlay(
    chunkName: string,
    signals: FrameworkSignal[],
): FrameworkSignalOverlay | null {
    if (signals.length === 0) return null;

    const capabilities = new Set<string>();
    const infrastructure = new Map<string, InfraRef>();
    const emergentApiCalls = new Map<string, ApiCall>();
    const allowedInboundPaths = new Set<string>();

    const controllerPrefixes = signals
        .filter(signal => signal.kind === 'http-controller')
        .map(signal => normalizeHttpPath(asString(signal.metadata?.path)))
        .filter((value): value is string => Boolean(value));

    const processorChannels = signals
        .filter(signal => signal.kind === 'message-processor')
        .map(signal => signal.resolvedName)
        .filter((value): value is string => Boolean(value));

    const addInfra = (infra: InfraRef) => {
        const key = `${infra.type}|${infra.operation}|${infra.name.toLowerCase()}`;
        infrastructure.set(key, infra);
    };

    const addApiCall = (call: ApiCall) => {
        const key = `${call.api_kind || 'rest'}|${call.direction}|${call.method || 'null'}|${call.path}`;
        emergentApiCalls.set(key, call);
        if (call.direction === 'INBOUND') allowedInboundPaths.add(call.path);
    };

    for (const signal of signals) {
        const capability = asString(signal.metadata?.capability);
        if (capability) capabilities.add(capability);

        if (signal.kind === 'http-route') {
            const httpMethod = asString(signal.metadata?.httpMethod) || 'POST';
            const methodPath = normalizeHttpPath(asString(signal.metadata?.path)) || '/';
            const fullPath = controllerPrefixes.length > 0
                ? joinHttpPath(controllerPrefixes[controllerPrefixes.length - 1], methodPath)
                : methodPath;

            addApiCall({
                method: httpMethod as ApiCall['method'],
                path: fullPath,
                direction: 'INBOUND',
                api_kind: 'rest',
                document_operation_name: null,
            });
        }

        if (signal.kind === 'graphql-operation') {
            const operation = asString(signal.metadata?.graphqlOperation) || 'QUERY';
            const opName = signal.resolvedName || lastSegment(signal.ownerName);
            if (!opName) continue;

            addApiCall({
                method: null,
                path: `GRAPHQL ${operation} ${opName}`,
                direction: 'INBOUND',
                api_kind: 'graphql',
                document_operation_name: null,
            });
        }

        if (signal.kind === 'message-consumer') {
            const decoratorName = asString(signal.metadata?.decorator);
            const resolvedChannel = decoratorName === 'Process'
                ? processorChannels[processorChannels.length - 1] || signal.resolvedName
                : signal.resolvedName || processorChannels[processorChannels.length - 1];
            if (!resolvedChannel) continue;

            // source='ast' so the graph-writer stamps this MessageChannel with
            // `ast/exact` grounding instead of falling back to `llm/medium`.
            // The channel name was extracted deterministically from a decorator
            // literal (e.g. `@QueueConsumer({routingKey: 'acme.order.updated'})`).
            addInfra({
                name: resolvedChannel,
                type: 'MessageChannel',
                operation: 'READS',
                evidence: signal.metadata?.decoratorText as string | undefined,
                source: 'ast',
            });
        }
    }

    const hardCapabilities = [...capabilities].filter(capability => HARD_ENTRYPOINT_CAPABILITIES.has(capability));
    const forceHasIo = infrastructure.size > 0 || emergentApiCalls.size > 0 || hardCapabilities.length > 0;

    if (!forceHasIo && capabilities.size === 0) return null;

    const intent = inferOverlayIntent({
        routes: [...emergentApiCalls.values()],
        infrastructure: [...infrastructure.values()],
        capabilities: [...capabilities],
        chunkName,
    });

    return {
        forceHasIo,
        intent,
        infrastructure: [...infrastructure.values()],
        capabilities: [...capabilities],
        emergentApiCalls: [...emergentApiCalls.values()],
        allowedInboundPaths,
    };
}

export function mergeUnifiedAnalysisWithOverlay(
    analysis: UnifiedAnalysis,
    overlay: FrameworkSignalOverlay | null,
): UnifiedAnalysis {
    if (!overlay) return analysis;

    const merged = {
        ...analysis,
        has_io: analysis.has_io || overlay.forceHasIo,
        intent: analysis.intent || overlay.intent || '',
        infrastructure: dedupeInfra([
            ...(analysis.infrastructure ?? []),
            ...overlay.infrastructure,
        ]),
        capabilities: dedupeStrings([
            ...(analysis.capabilities ?? []),
            ...overlay.capabilities,
        ]),
        emergent_api_calls: dedupeApiCalls([
            ...(analysis.emergent_api_calls ?? []),
            ...overlay.emergentApiCalls,
        ]),
    } satisfies UnifiedAnalysis;

    return merged;
}

function deriveClassName(chunkName: string): string | null {
    const dotIdx = chunkName.lastIndexOf('.');
    if (dotIdx === -1) return null;
    return chunkName.slice(0, dotIdx);
}

function inferOverlayIntent(params: {
    routes: ApiCall[];
    infrastructure: InfraRef[];
    capabilities: string[];
    chunkName: string;
}): string | undefined {
    const route = params.routes[0];
    if (route) {
        if (route.api_kind === 'graphql') return `${params.chunkName} exposes ${route.path}`;
        return `${params.chunkName} exposes ${route.method} ${route.path}`;
    }

    const infra = params.infrastructure[0];
    if (infra?.type === 'MessageChannel') {
        return `${params.chunkName} consumes messages from ${infra.name}`;
    }

    if (params.capabilities.includes('scheduled-job')) {
        return `${params.chunkName} is a scheduled job entrypoint`;
    }

    if (params.capabilities.includes('cli-entrypoint')) {
        return `${params.chunkName} is a CLI entrypoint`;
    }

    return undefined;
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function dedupeInfra(items: InfraRef[]): InfraRef[] {
    const seen = new Map<string, InfraRef>();
    for (const item of items) {
        const key = `${item.type}|${item.operation}|${item.name.toLowerCase()}`;
        const prev = seen.get(key);
        if (!prev) {
            seen.set(key, item);
            continue;
        }
        // When the same infra is emitted twice (overlay + LLM), the AST-sourced
        // entry wins so the graph-writer stamps `ast/exact` grounding rather
        // than `llm/medium`. Other fields fall back to the surviving entry's
        // non-null values, merging metadata across both.
        const astPriority = item.source === 'ast' ? item : prev.source === 'ast' ? prev : prev;
        const otherEntry = astPriority === item ? prev : item;
        seen.set(key, {
            ...otherEntry,
            ...astPriority,
            evidence: astPriority.evidence ?? otherEntry.evidence,
            schemaPath: astPriority.schemaPath ?? otherEntry.schemaPath,
            schemaFormat: astPriority.schemaFormat ?? otherEntry.schemaFormat,
            technology: astPriority.technology ?? otherEntry.technology,
            channelKind: astPriority.channelKind ?? otherEntry.channelKind,
            routingKey: astPriority.routingKey ?? otherEntry.routingKey,
            partitionKey: astPriority.partitionKey ?? otherEntry.partitionKey,
            consumerGroup: astPriority.consumerGroup ?? otherEntry.consumerGroup,
        });
    }
    return [...seen.values()];
}

function dedupeApiCalls(items: ApiCall[]): ApiCall[] {
    const seen = new Set<string>();
    const out: ApiCall[] = [];
    for (const item of items) {
        const key = `${item.api_kind || 'rest'}|${item.direction}|${item.method || 'null'}|${item.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

export function joinHttpPath(basePath?: string, routePath?: string): string {
    const base = normalizeHttpPath(basePath) || '';
    const route = normalizeHttpPath(routePath) || '';
    const joined = `${base}/${route}`.replace(/\/{2,}/g, '/');
    return joined === '' ? '/' : joined;
}

export function normalizeHttpPath(path?: string): string | undefined {
    if (path === undefined || path === null) return undefined;
    const trimmed = path.trim();
    if (!trimmed || trimmed === '/') return '/';
    if (trimmed.startsWith('GRAPHQL ')) return trimmed;
    return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
}

export function lastSegment(value: string): string {
    const segments = value.split(/[.:]/).filter(Boolean);
    return segments[segments.length - 1] || value;
}

function asString(value: FrameworkSignalMetadataValue): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
