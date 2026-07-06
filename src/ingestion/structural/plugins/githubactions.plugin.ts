import yaml from 'js-yaml';
import { buildUrn } from '../../../graph/urn.js';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../types.js';
import {
    buildImageEntity,
    deduplicateByUrn,
} from './container-image-utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Actions Plugin — Extract CIPipeline nodes from workflow YAML files
//
// Handles files under .github/workflows/*.yml and .github/workflows/*.yaml.
// Produces one CIPipeline entity per workflow file.
//
// Key signals extracted:
//   - triggers (on: push, pull_request, schedule, workflow_dispatch, …)
//   - job count
//   - reusable workflow refs (`uses:`) as the GHA equivalent of "includes"
//   - hasMergeRequestPipeline → mapped from `pull_request` / `pull_request_target` triggers
//   - hasTestStage / hasDeployStage → inferred from job names and step `uses:`
//   - environments
//
// No client-specific strings in this file.
// ═══════════════════════════════════════════════════════════════════════════════

/** Job/step name keywords that indicate a test/quality step. */
const TEST_KEYWORDS = ['test', 'spec', 'lint', 'coverage', 'sonar', 'sast', 'quality', 'check'];

/** Job/step name keywords that indicate a deploy/release step. */
const DEPLOY_KEYWORDS = ['deploy', 'release', 'publish', 'deliver', 'staging', 'production', 'rollout'];

/**
 * Normalise the `on:` trigger field, which GitHub Actions supports in
 * four distinct YAML shapes:
 *
 *   1. Scalar:   on: push
 *   2. Array:    on: [push, pull_request]
 *   3. Object:   on: { push: { branches: [...] }, pull_request: {} }
 *   4. Null:     on: (empty) — treated as no triggers
 */
function extractTriggers(on: unknown): string[] {
    if (!on) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String);
    if (typeof on === 'object') return Object.keys(on as object);
    return [];
}

/**
 * Collect `uses:` references from a job's `steps` array.
 * These are GHA reusable workflows / marketplace actions — the closest GHA
 * equivalent to GitLab's `include: project:`.
 * We capture only `org/repo@ref` patterns (not local actions like `./...`).
 */
function extractJobUses(job: Record<string, unknown>): string[] {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const refs: string[] = [];
    for (const step of steps) {
        if (typeof step !== 'object' || step === null) continue;
        const uses = (step as Record<string, unknown>).uses;
        if (typeof uses === 'string' && !uses.startsWith('./')) {
            refs.push(uses);
        }
    }
    return refs;
}

/**
 * Extract the environment name from a job, supporting both scalar and object forms:
 *   environment: production
 *   environment: { name: staging, url: https://... }
 */
function extractEnvironmentName(job: Record<string, unknown>): string | null {
    const env = job.environment;
    if (typeof env === 'string') return env;
    if (typeof env === 'object' && env !== null) {
        const name = (env as Record<string, unknown>).name;
        if (typeof name === 'string') return name;
    }
    return null;
}

export const githubActionsPlugin: StructuralPlugin = {
    name: 'githubactions',
    label: 'GitHub Actions',
    managedLabels: ['CIPipeline'],

    matchFile(relativePath: string, basename: string): boolean {
        return (
            relativePath.startsWith('.github/workflows/') &&
            (basename.endsWith('.yml') || basename.endsWith('.yaml'))
        );
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        let parsed: Record<string, unknown>;
        try {
            const raw = yaml.load(content);
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return { entities: [], summary: 'empty or non-object YAML' };
            }
            parsed = raw as Record<string, unknown>;
        } catch {
            return { entities: [], summary: 'parse error (malformed YAML)' };
        }

        // ── Triggers ─────────────────────────────────────────────────────────
        // Note: `on` is a reserved word in JS — access via bracket notation
        const triggers = extractTriggers((parsed as Record<string, unknown>)['on'] ?? parsed.true);

        // ── MR Pipeline equivalent ────────────────────────────────────────────
        const hasMergeRequestPipeline =
            triggers.includes('pull_request') ||
            triggers.includes('pull_request_target');

        // ── Jobs ─────────────────────────────────────────────────────────────
        const jobsMap = (parsed.jobs ?? {}) as Record<string, unknown>;
        const jobEntries = Object.entries(jobsMap);
        const jobCount = jobEntries.length;

        // ── Reusable workflow / action refs ───────────────────────────────────
        const includeRefs: string[] = [];
        // Top-level `uses:` means this workflow is a reusable workflow caller
        if (typeof (parsed as Record<string, unknown>).uses === 'string') {
            includeRefs.push((parsed as Record<string, unknown>).uses as string);
        }

        const environments: string[] = [];
        const allJobAndStepNames: string[] = [];

        for (const [jobName, jobRaw] of jobEntries) {
            if (typeof jobRaw !== 'object' || jobRaw === null) continue;
            const job = jobRaw as Record<string, unknown>;

            allJobAndStepNames.push(jobName.toLowerCase());

            // Step-level uses (marketplace actions / reusable workflows)
            const stepRefs = extractJobUses(job);
            for (const ref of stepRefs) {
                if (!includeRefs.includes(ref)) includeRefs.push(ref);
            }

            // Step names for keyword detection
            const steps = Array.isArray(job.steps) ? job.steps : [];
            for (const step of steps) {
                if (typeof step !== 'object' || step === null) continue;
                const stepName = (step as Record<string, unknown>).name;
                if (typeof stepName === 'string') {
                    allJobAndStepNames.push(stepName.toLowerCase());
                }
            }

            // Environment
            const envName = extractEnvironmentName(job);
            if (envName && !environments.includes(envName)) {
                environments.push(envName);
            }
        }

        // ── Stage classification ──────────────────────────────────────────────
        // GHA has no explicit `stages` — use job names + step names as signal
        const hasTestStage = allJobAndStepNames.some(n => TEST_KEYWORDS.some(k => n.includes(k)));
        const hasDeployStage = allJobAndStepNames.some(n => DEPLOY_KEYWORDS.some(k => n.includes(k)));

        const hasReviewEnvironment = environments.some(e =>
            e.toLowerCase().includes('review'),
        );

        // ── Workflow name (for human-readable summary) ────────────────────────
        const workflowName = typeof parsed.name === 'string'
            ? parsed.name
            : context.relativePath.split('/').pop() ?? context.relativePath;

        const entity = {
            id: buildUrn('cipipeline', context.repoName, 'github-actions', context.relativePath),
            labels: ['CIPipeline'],
            properties: {
                name: workflowName,
                tool: 'github-actions',
                filePath: context.relativePath,
                // GHA has no sequential stages (unlike GitLab CI) — leave empty
                stages: '',
                jobCount,
                includes: includeRefs.join(','),
                triggers: triggers.join(','),
                hasMergeRequestPipeline,
                hasTestStage,
                hasDeployStage,
                hasReviewEnvironment,
                environments: environments.join(','),
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        };

        // ── Docker Images (CI runners & service containers) ──────────────
        // GHA supports `container: { image: ... }` and `services: { svc: { image: ... } }`.
        // GHA variable expressions use `${{ ... }}` which contain `$` —
        // the isResolvableImageRef() guard catches these via the `$` marker.
        const imageEntities: StructuralEntity[] = [];

        function extractContainerImage(containerVal: unknown): string | null {
            if (typeof containerVal === 'string') return containerVal;
            if (typeof containerVal === 'object' && containerVal !== null) {
                const img = (containerVal as Record<string, unknown>).image;
                if (typeof img === 'string') return img;
            }
            return null;
        }

        for (const [, jobRaw] of jobEntries) {
            if (typeof jobRaw !== 'object' || jobRaw === null) continue;
            const job = jobRaw as Record<string, unknown>;

            // Per-job container image
            const containerImg = extractContainerImage(job.container);
            if (containerImg) {
                const ent = buildImageEntity(containerImg, 'ci_runner', 'unknown', context.relativePath, context.ownerService);
                if (ent) imageEntities.push(ent);
            }

            // Per-job service containers
            const services = job.services;
            if (services && typeof services === 'object' && !Array.isArray(services)) {
                // Object form: services: { redis: { image: 'redis:7' } }
                for (const [, svcDef] of Object.entries(services as Record<string, unknown>)) {
                    const svcImg = extractContainerImage(svcDef);
                    if (svcImg) {
                        const ent = buildImageEntity(svcImg, 'ci_runner', 'unknown', context.relativePath, context.ownerService);
                        if (ent) imageEntities.push(ent);
                    }
                }
            } else if (Array.isArray(services)) {
                // Array form: services: [{ image: 'redis:7' }]
                for (const svcDef of services) {
                    const svcImg = extractContainerImage(svcDef);
                    if (svcImg) {
                        const ent = buildImageEntity(svcImg, 'ci_runner', 'unknown', context.relativePath, context.ownerService);
                        if (ent) imageEntities.push(ent);
                    }
                }
            }
        }

        const dedupedImages = deduplicateByUrn(imageEntities);

        return {
            entities: [entity, ...dedupedImages],
            summary: `[GitHub Actions] "${workflowName}" | ${jobCount} job(s) | triggers: ${triggers.join(', ')} | images: ${dedupedImages.length}`,
        };
    },
};
