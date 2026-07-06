/**
 * interpretApiCalls — pure interpreter for the emergent-API block of
 * persistFunction.
 *
 * Unlike the datastore/channel interpreters this one returns typed write
 * INTENTS, not a GraphDelta: the API mutations (mergeCodeExposedEndpoint,
 * mergeEmergentAPIEndpoint, GraphQL variants) encode the APIEndpoint
 * dedup/welding contract (apiSource/epSource stamps, welding anchors,
 * EXPOSES/CONSUMES reclassification) and stay the single write path for it.
 * The interpreter owns every DECISION — filtering, the GraphQL/HTTP fork,
 * the EXPOSES_API server-role gate, payload naming, link direction,
 * dedup fingerprints — and graph-writer executes the intents.
 *
 * Decision parity preserved from the inline block:
 *   - noisy endpoints dropped silently; dynamic paths dropped with a trace;
 *   - GQL INBOUND requires a service context AND a graphql-server bootstrap
 *     signal (otherwise resolver-lib imports leak phantom endpoints);
 *   - GQL OUTBOUND prefers the explicit document_operation_name, else infers
 *     the document from the gql/graphql template literal in the source;
 *   - payload link direction inverts with the call direction (INBOUND:
 *     request→consumes/response→produces; OUTBOUND: the opposite);
 *   - templated payload-name guard applies to INBOUND request, INBOUND
 *     response and OUTBOUND response — but NOT to the OUTBOUND request
 *     (historical asymmetry, preserved verbatim);
 *   - fast scans persist schema stubs with no fields; deep scans materialise
 *     required typed fields.
 */
import {
    isNoisyEndpoint,
    isGraphQLPath,
    parseGraphQLPath,
    isTemplatedPayloadName,
} from '../../../../ai/workflows/sanitizer.js';
import { normalizeApiPathLossless } from '../../api-path-utils.js';
import type { HttpMethod } from '@coderadius/shared-types';
import type { InterpretLog, PersistTrace } from './types.js';

export type GraphQLOperation = 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';

export interface PayloadField {
    name?: string;
    type?: string;
}

export interface EmergentApiCallItem {
    path: string;
    direction: 'INBOUND' | 'OUTBOUND';
    method?: HttpMethod;
    framework?: string;
    document_operation_name?: string;
    payload_schema?: PayloadField[];
    response_schema?: PayloadField[];
}

export interface ApiCallsInterpretContext {
    functionId: string;
    /** Function source — GQL document-name inference scans gql`` literals. */
    sourceCode: string;
    isDeepScan: boolean;
    /** Service owning the function, when resolvable — gates INBOUND intents. */
    serviceName: string | null;
    /** Caller-side service URN anchoring emergent GQL CONSUMES_API. */
    callerServiceUrn: string;
    /** Whether the owning service bootstraps a GraphQL server (EXPOSES gate). */
    graphqlServerRole: boolean;
}

export interface EmergentSchemaIntent {
    schemaName: string;
    fields: Array<{ name: string; type: string; required: boolean }>;
    link: 'produces' | 'consumes';
    fingerprint: string;
}

export type ApiCallIntent =
    | { kind: 'gql-inbound'; operation: GraphQLOperation; operationName: string; serviceName: string; framework: string }
    | { kind: 'gql-outbound'; operation: GraphQLOperation; operationName: string; callerServiceUrn: string; documentName?: string }
    | { kind: 'http-inbound'; method: HttpMethod; path: string; serviceName: string; framework?: string; schemas: EmergentSchemaIntent[] }
    | { kind: 'http-outbound'; method: HttpMethod; normalizedPath: string; rawPath: string; schemas: EmergentSchemaIntent[] };

export interface ApiCallsInterpretOutcome {
    intents: ApiCallIntent[];
    traces: PersistTrace[];
    logs: InterpretLog[];
    /** Field-set fingerprints of persisted bodies — suppresses produced/consumed payload duplicates downstream. */
    requestBodyFingerprints: string[];
}

/** Sorted field-name fingerprint used for payload dedup across LLM emissions. */
export function payloadFieldFingerprint(fields: PayloadField[] | undefined): string {
    return (fields ?? []).map(f => f.name ?? '').sort().join('|');
}

export function interpretApiCalls(
    calls: EmergentApiCallItem[],
    ctx: ApiCallsInterpretContext,
): ApiCallsInterpretOutcome {
    const out: ApiCallsInterpretOutcome = { intents: [], traces: [], logs: [], requestBodyFingerprints: [] };

    for (const call of calls) {
        if (isNoisyEndpoint(call.path)) continue;

        const normalizedPath = normalizeApiPathLossless(call.path);
        if (!normalizedPath) {
            out.logs.push({ level: 'debug', message: `Skipping dynamic API path: ${call.path}` });
            out.traces.push({ action: 'DROP', target: 'api_call', reason: 'dynamic API path', meta: { path: call.path } });
            continue;
        }

        if (isGraphQLPath(normalizedPath)) interpretGraphQLCall(call, normalizedPath, ctx, out);
        else interpretHttpCall(call, normalizedPath, ctx, out);
    }
    return out;
}

function interpretGraphQLCall(
    call: EmergentApiCallItem,
    normalizedPath: string,
    ctx: ApiCallsInterpretContext,
    out: ApiCallsInterpretOutcome,
): void {
    const gql = parseGraphQLPath(normalizedPath);
    if (!gql) {
        out.logs.push({ level: 'debug', message: `Skipping malformed GQL path: ${normalizedPath}` });
        return;
    }
    const operation = gql.operation as GraphQLOperation;
    const { operationName } = gql;

    if (call.direction === 'INBOUND') {
        if (!ctx.serviceName) {
            out.logs.push({ level: 'debug', message: `Skipping GQL INBOUND ${normalizedPath} — no service context` });
            return;
        }
        // EXPOSES_API gate: a resolver only "exposes" a GraphQL endpoint when
        // the hosting service actually bootstraps a GraphQL server.
        if (!ctx.graphqlServerRole) {
            out.logs.push({ level: 'debug', message: `Skipping GQL INBOUND ${operation} ${operationName} on ${ctx.serviceName} — no graphql-server signal` });
            out.traces.push({
                action: 'DROP',
                target: `gql:${operation}:${operationName}`,
                reason: 'GQL INBOUND dropped: no graphql-server bootstrap',
                meta: { direction: 'INBOUND', serviceName: ctx.serviceName },
            });
            return;
        }
        out.intents.push({
            kind: 'gql-inbound',
            operation,
            operationName,
            serviceName: ctx.serviceName,
            framework: call.framework ?? 'graphql',
        });
        out.logs.push({ level: 'debug', message: `GQL INBOUND: ${ctx.serviceName} exposes GRAPHQL ${operation} ${operationName}` });
        out.traces.push({
            action: 'WRITE',
            target: `gql:${operation}:${operationName}`,
            reason: 'GQL INBOUND endpoint merged',
            meta: { functionId: ctx.functionId, direction: 'INBOUND', serviceName: ctx.serviceName },
        });
        return;
    }

    const rawDocName = call.document_operation_name;
    const documentName = rawDocName && rawDocName.trim()
        ? rawDocName.trim()
        : inferGraphQLDocumentNameFromSource(ctx.sourceCode, operation, operationName);
    out.intents.push({
        kind: 'gql-outbound',
        operation,
        operationName,
        callerServiceUrn: ctx.callerServiceUrn,
        documentName,
    });
    out.traces.push({
        action: 'WRITE',
        target: `gql:${operation}:${operationName}`,
        reason: 'GQL OUTBOUND emergent merged',
        meta: { functionId: ctx.functionId, direction: 'OUTBOUND', documentName },
    });
}

function interpretHttpCall(
    call: EmergentApiCallItem,
    normalizedPath: string,
    ctx: ApiCallsInterpretContext,
    out: ApiCallsInterpretOutcome,
): void {
    const method = call.method ?? 'POST';

    if (call.direction === 'INBOUND') {
        if (!ctx.serviceName) {
            out.logs.push({ level: 'debug', message: `Skipping INBOUND endpoint ${method} ${normalizedPath} — no service context` });
            return;
        }
        const schemas = [
            ...schemaIntent(call.payload_schema, method, normalizedPath, 'RequestBody', 'consumes', ctx, { guardTemplated: true, logTemplated: true }, out),
            ...schemaIntent(call.response_schema, method, normalizedPath, 'ResponseBody', 'produces', ctx, { guardTemplated: true }, out),
        ];
        out.intents.push({ kind: 'http-inbound', method, path: normalizedPath, serviceName: ctx.serviceName, framework: call.framework, schemas });
        out.logs.push({ level: 'debug', message: `INBOUND endpoint: ${ctx.serviceName} exposes ${method} ${normalizedPath}` });
        out.traces.push({
            action: 'WRITE',
            target: `endpoint:${method} ${normalizedPath}`,
            reason: 'INBOUND endpoint merged',
            meta: { functionId: ctx.functionId, direction: 'INBOUND', serviceName: ctx.serviceName },
        });
        return;
    }

    const schemas = [
        // Historical asymmetry preserved: the OUTBOUND request body has no
        // templated-name guard on the inline path.
        ...schemaIntent(call.payload_schema, method, normalizedPath, 'RequestBody', 'produces', ctx, { guardTemplated: false }, out),
        ...schemaIntent(call.response_schema, method, normalizedPath, 'ResponseBody', 'consumes', ctx, { guardTemplated: true }, out),
    ];
    out.intents.push({ kind: 'http-outbound', method, normalizedPath, rawPath: call.path, schemas });
    out.traces.push({
        action: 'WRITE',
        target: `endpoint:${method} ${normalizedPath}`,
        reason: 'OUTBOUND endpoint merged',
        meta: { functionId: ctx.functionId, direction: 'OUTBOUND' },
    });
}

function schemaIntent(
    fields: PayloadField[] | undefined,
    method: string,
    normalizedPath: string,
    suffix: 'RequestBody' | 'ResponseBody',
    link: 'produces' | 'consumes',
    ctx: ApiCallsInterpretContext,
    opts: { guardTemplated: boolean; logTemplated?: boolean },
    out: ApiCallsInterpretOutcome,
): EmergentSchemaIntent[] {
    if (!fields || fields.length === 0) return [];
    const schemaName = `${method.toUpperCase()}_${normalizedPath.replace(/[/{}]/g, '_')}_${suffix}`;
    if (opts.guardTemplated && isTemplatedPayloadName(schemaName)) {
        if (opts.logTemplated) {
            out.logs.push({ level: 'debug', message: `Skipping INBOUND request body with templated name: "${schemaName}"` });
        }
        return [];
    }
    const fingerprint = payloadFieldFingerprint(fields);
    out.requestBodyFingerprints.push(fingerprint);
    return [{
        schemaName,
        fields: ctx.isDeepScan
            ? fields.map(f => ({ name: f.name ?? '', type: f.type ?? '', required: true }))
            : [],
        link,
        fingerprint,
    }];
}

/**
 * Infer the GraphQL document name (e.g. `GetMyOrder`) for an operation by
 * scanning gql/graphql template literals in the function source. Matched only
 * when the operation type AND the root field agree. Moved verbatim from
 * graph-writer.ts.
 */
export function inferGraphQLDocumentNameFromSource(
    sourceCode: string,
    operation: GraphQLOperation,
    rootFieldName: string,
): string | undefined {
    const documents = [...sourceCode.matchAll(/(?:gql|graphql)\s*`([\s\S]*?)`/g)];

    for (const documentMatch of documents) {
        const document = documentMatch[1] ?? '';
        const operationMatch = document.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (!operationMatch) continue;

        const operationType = operationMatch[1].toUpperCase();
        const documentName = operationMatch[2];
        if (operationType !== operation) continue;

        const bodyStart = document.indexOf('{');
        if (bodyStart === -1) continue;

        const body = document.slice(bodyStart + 1).replace(/#[^\n]*/g, '');
        const rootFieldMatch = body.match(/(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\{)/);
        if (!rootFieldMatch) continue;
        if (rootFieldMatch[1] !== rootFieldName) continue;

        return documentName;
    }

    return undefined;
}
