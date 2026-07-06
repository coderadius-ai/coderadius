import fs from 'node:fs';
import { initSchema } from '../../graph/neo4j.js';
import { ingestTelemetry } from '../extractors/telemetry-extractor.js';
import { silentReporter, type IngestionStep, type IngestionContext, type ProgressReporter } from '../core/progress.js';

export interface TraceIngestionOptions {
    tracesPath: string;
    debug?: boolean;
}

export interface TraceIngestionContext extends IngestionContext {
    tracesPath: string;
    spansProcessed?: number;
}

export function getGlobalTraceIngestionSteps(opts: TraceIngestionOptions): IngestionStep<TraceIngestionContext>[] {
    const steps: IngestionStep<TraceIngestionContext>[] = [];

    steps.push({
        title: 'Bootstrapping Graph Engine',
        run: async (ctx, reporter) => {
            await initSchema();
        }
    });

    steps.push({
        title: 'Distributed Telemetry Ingestion',
        run: async (ctx, reporter) => {
            if (!fs.existsSync(ctx.tracesPath)) {
                throw new Error(`Traces file not found: ${ctx.tracesPath}`);
            }

            const result = await ingestTelemetry(ctx.tracesPath, reporter);
            ctx.spansProcessed = result.spansProcessed;
            reporter.report(`Ingested ${result.spansProcessed} telemetry spans`);
        }
    });

    return steps;
}

/**
 * Headless execution of the trace ingestion workflow.
 * Can be run from an API, cron job, or alternative UI.
 */
export async function runGlobalTraceIngestion(
    ctx: TraceIngestionContext,
    opts: TraceIngestionOptions,
    reporter: ProgressReporter = silentReporter
): Promise<TraceIngestionContext> {
    const steps = getGlobalTraceIngestionSteps(opts);

    for (const step of steps) {
        reporter.report(`Starting: ${step.title}`);
        await step.run(ctx, reporter);
    }

    return ctx;
}
