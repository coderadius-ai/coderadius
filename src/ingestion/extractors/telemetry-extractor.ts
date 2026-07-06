import type { ProgressReporter } from '../core/progress.js';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { BackstageCatalogEntitySchema } from '../../graph/types.js';
import { TraceSpanSchema } from '../../graph/domain.js';
import { linkTraceObservedInFunction, mergeTraceSpan } from '../../graph/mutations/code-graph.js';
import { vectorSearchFunctions } from '../../graph/mutations/search.js';
import { generateEmbedding } from '../../ai/index.js';
import { logger } from '../../utils/logger.js';
import { telemetryCollector } from '../../telemetry/index.js';

const commitHash = "SYSTEM";

/**
 * Step 2: The Observer
 *
 * Reads a mock-traces.json file, writes TraceSpan nodes to Neo4j,
 * and links them to the closest Function node via vector similarity.
 */
export async function ingestTelemetry(
    tracesFilePath: string,
    task?: ProgressReporter
): Promise<{
    spansProcessed: number;
    spansLinked: number;
    errors: string[];
}> {
    let spansProcessed = 0;
    let spansLinked = 0;
    const errors: string[] = [];

    // Read and parse the traces file
    let rawTraces: unknown[];
    try {
        const content = fs.readFileSync(tracesFilePath, 'utf-8');
        rawTraces = JSON.parse(content);
        if (!Array.isArray(rawTraces)) {
            throw new Error('Traces file must contain a JSON array');
        }
    } catch (err) {
        const msg = `Failed to read traces file: ${(err as Error).message}`;
        if (task) task.report(`[Error] ${msg}`);
        telemetryCollector.incrementErrors();
        return { spansProcessed: 0, spansLinked: 0, errors: [msg] };
    }

    if (task) task.report(`Processing ${rawTraces.length} trace spans from ${tracesFilePath}...`);

    for (const rawSpan of rawTraces) {
        try {
            if (!TraceSpanSchema) {
                throw new Error('TraceSpanSchema is undefined! Circular dependency or import error.');
            }
            const parseResult = TraceSpanSchema.safeParse(rawSpan);
            if (!parseResult.success) {
                const msg = `Invalid span: ${parseResult.error.issues[0]?.message || 'Unknown schema error'}`;
                if (task) task.report(`[Error] ${msg}`);
                errors.push(`[Observer] ${msg}`);
                continue;
            }

            const span = parseResult.data;

            // Write TraceSpan node to Neo4j
            await mergeTraceSpan(span.spanId,
                span.operationName,
                span.serviceName,
                span.latency_ms,
                span.status,
                span.attributes as Record<string, unknown> | undefined, commitHash);
            spansProcessed++;

            // Generate embedding for the span operation
            const spanText = [
                span.operationName,
                span.serviceName,
                span.attributes ? Object.values(span.attributes).join(' ') : '',
            ].join(' ');

            const embedding = await generateEmbedding(spanText);

            if (embedding) {
                // Find the closest Function node via vector similarity
                const results = await vectorSearchFunctions(embedding, 1);

                if (results.length > 0 && results[0].score > 0.5) {
                    await linkTraceObservedInFunction(span.spanId, results[0].id, commitHash);
                    spansLinked++;
                    if (task) task.report(`Span "${span.operationName}" -> Function "${results[0].name}"`);
                } else {
                    if (task) task.report(`Span "${span.operationName}" -> no confident match`);
                }
            }
        } catch (err) {
            const msg = `Error processing span: ${(err as Error).message}`;
            if (task) task.report(`[Error] ${msg}`);
            errors.push(msg);
            telemetryCollector.incrementErrors();
        }
    }

    if (task) task.report(`Complete: ${spansProcessed} spans processed, ${spansLinked} linked to functions.`);
    return { spansProcessed, spansLinked, errors };
}
