/**
 * Infra Ingestion workflow — zero-LLM, structural-only.
 *
 * Runs the governance scan (repo discovery, topology, structural plugin
 * manager: RabbitMQ definitions.json, Crossplane CRDs, Helm/K8s, CI configs,
 * agentic tooling, ...), then chains the shared reconcile workflow that
 * stabilises the graph (channel autopromote, technology weld, cross-kind
 * dedup, OpenAPI cross-spec welder, etc.).
 *
 * Used by `cr analyze infra` to ingest infrastructure declarations without
 * paying the LLM cost of `cr analyze code`. Order-independent: ingesting
 * infra first then code, or code first then infra, converges to the same
 * graph state because both ingest entry points finish with reconciliation.
 *
 * Out of scope (intentional — future batch when prioritised):
 *   - Terraform `.tf` parser (would add HCL extractor + state-file linker).
 *   - AWS CDK / Pulumi TypeScript or YAML parser.
 *   - Crossplane CRDs beyond PubSub.
 *   - Helm Chart.yaml metadata extraction (only container images today).
 * Add a new plugin under `src/ingestion/structural/plugins/` and register it
 * in `src/ingestion/structural/plugin-manager.ts` — both the code and infra
 * workflows will pick it up automatically through `ingestStructural()`.
 */

import { type SourceStrategy } from '../core/source-resolver.js';
import { areUrnsTransparent } from '../../utils/urn-transparency.js';
import { cleanupTransparentArtifacts } from '../../graph/mutations/data-contracts.js';
import { getGovernanceScanSteps, type GovernanceScanContext } from './governance-scan.workflow.js';
import { runReconcile } from './reconcile.workflow.js';
import type { IngestionStep } from '../core/progress.js';

export interface InfraIngestionContext extends GovernanceScanContext {}

export interface InfraIngestionCommandOptions {
    sourcePaths: string[];
    debug?: boolean;
    fresh?: boolean;
    sourceStrategy?: SourceStrategy;
}

/**
 * Build the ordered step list for `cr analyze infra`. Reuses the governance
 * scan (which already runs `ingestStructural()` covering all infra plugins)
 * and chains the shared reconciliation as the terminal step.
 */
export function getInfraIngestionSteps(opts: InfraIngestionCommandOptions): IngestionStep<InfraIngestionContext>[] {
    const govSteps = getGovernanceScanSteps({
        sourcePaths: opts.sourcePaths,
        debug: opts.debug,
        fresh: opts.fresh,
        sourceStrategy: opts.sourceStrategy,
    }) as IngestionStep<InfraIngestionContext>[];

    const cleanupStep: IngestionStep<InfraIngestionContext> = {
        title: 'Cleaning Stale Transparent Artifacts',
        run: async (_ctx, r) => {
            // Symmetric with the code workflow: if the user toggled
            // --transparent-urns on a previous run then ran infra in opaque mode,
            // strip the leftover plaintext displayHost / displayVhost values.
            if (!areUrnsTransparent() && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
                await cleanupTransparentArtifacts();
                r.report('Cleared stale transparent display fields');
            }
        },
    };

    const reconcileStep: IngestionStep<InfraIngestionContext> = {
        title: 'Reconciling Graph State',
        run: async (ctx, r) => {
            await runReconcile({ repos: ctx.repos, commitHash: 'SYSTEM' }, r);
        },
    };

    return [...govSteps, cleanupStep, reconcileStep];
}
