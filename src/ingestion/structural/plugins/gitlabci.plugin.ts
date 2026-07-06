import yaml from 'js-yaml';
import { buildUrn } from '../../../graph/urn.js';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../types.js';
import {
    buildImageEntity,
    deduplicateByUrn,
    isResolvableImageRef,
} from './container-image-utils.js';
import { parseGitLabComponentRef, ciComponentUrn } from './ci-component-utils.js';

// ── GitLab-safe YAML Schema ──────────────────────────────────────────────────
// GitLab CI uses custom tags (`!reference`, `!ruby/object`, etc.) that are not
// part of the standard YAML spec.  js-yaml throws `unknown tag !<!reference>`
// by default.  We extend DEFAULT_SCHEMA with a catch-all type that accepts ANY
// unknown tag and passes through the native JS value (string, array, object).
const gitlabPassthroughType = new yaml.Type('', {
    kind: 'scalar',
    multi: true,
    representName: () => '',
    resolve: () => true,
    construct: (data: unknown) => data,
    predicate: () => false,
});

const gitlabSequenceType = new yaml.Type('', {
    kind: 'sequence',
    multi: true,
    representName: () => '',
    resolve: () => true,
    construct: (data: unknown) => data,
    predicate: () => false,
});

const gitlabMappingType = new yaml.Type('', {
    kind: 'mapping',
    multi: true,
    representName: () => '',
    resolve: () => true,
    construct: (data: unknown) => data,
    predicate: () => false,
});

/** YAML schema that tolerates GitLab-specific tags (!reference, etc.). */
const GITLAB_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
    gitlabPassthroughType,
    gitlabSequenceType,
    gitlabMappingType,
]);

// ═══════════════════════════════════════════════════════════════════════════════
// GitLab CI Plugin — Extract CIPipeline nodes from .gitlab-ci.yml
//
// Produces a single CIPipeline entity per file with the following signal:
//   - stages list
//   - job count
//   - include references (project, local, remote, template)
//   - hasMergeRequestPipeline flag
//   - hasTestStage / hasDeployStage detection
//   - environments list
//
// Design: this plugin coexists with ciConfigPlugin on the same file.
//   ciConfigPlugin → creates the StructuralFile presence node (gp-005)
//   gitlabCiPlugin → creates the CIPipeline entity (gp-012, gp-015, etc.)
//
// No client-specific strings in this file. The policy YAML (gp-012) decides
// which include ref to mandate. This plugin only extracts structure.
// ═══════════════════════════════════════════════════════════════════════════════

/** GitLab CI top-level reserved keys — everything else is a job definition. */
const GITLAB_RESERVED_KEYS = new Set([
    'stages', 'variables', 'workflow', 'include', 'default',
    'image', 'services', 'cache', 'before_script', 'after_script',
    'pages',  // GitLab Pages pseudo-job — excluded from job count for clarity
]);

/** Stage names that indicate a test/quality step. */
const TEST_KEYWORDS = ['test', 'spec', 'lint', 'quality', 'coverage', 'sonar', 'sast', 'dast', 'review'];

/** Stage names that indicate a deploy/release step. */
const DEPLOY_KEYWORDS = ['deploy', 'release', 'publish', 'deliver', 'staging', 'production', 'rollout'];

/**
 * Normalise a `include:` entry to a human-readable reference string.
 * Returns empty string for entries we cannot parse, which are then filtered.
 *
 * Supported forms (per GitLab CI spec):
 *   - local:     '/templates/base.yml'
 *   - project:   'group/toolkit'
 *   - remote:    'https://example.com/ci.yml'
 *   - template:  'Security/SAST.gitlab-ci.yml'
 *   - component: 'gitlab.com/org/comp@v1'  (GitLab 16.0+)
 *   - scalar:    '/templates/base.yml' (shorthand local)
 */
function resolveIncludeRef(item: unknown): string {
    if (typeof item === 'string') return item;
    if (typeof item !== 'object' || item === null) return '';
    const entry = item as Record<string, unknown>;
    // Precedence matches GitLab docs order
    if (typeof entry.component === 'string') return entry.component;
    if (typeof entry.project === 'string') return entry.project;
    if (typeof entry.local === 'string') return entry.local;
    if (typeof entry.remote === 'string') return entry.remote;
    if (typeof entry.template === 'string') return entry.template;
    return '';
}

/**
 * Flatten a potential scalar or array value into a typed array.
 */
function toArray<T>(value: unknown): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? (value as T[]) : [value as T];
}

/**
 * Collect environment names from a job object.
 * GitLab supports both scalar (`environment: production`) and
 * map (`environment: { name: review/$CI_COMMIT_REF_NAME }`) forms.
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

export const gitlabCiPlugin: StructuralPlugin = {
    name: 'gitlabci',
    label: 'GitLab CI',
    managedLabels: ['CIPipeline', 'CIComponent'],

    matchFile(_relativePath: string, basename: string): boolean {
        return basename === '.gitlab-ci.yml' || basename === '.gitlab-ci.yaml';
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        let parsed: Record<string, unknown>;
        try {
            const raw = yaml.load(content, { schema: GITLAB_YAML_SCHEMA });
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return { entities: [], summary: 'empty or non-object YAML' };
            }
            parsed = raw as Record<string, unknown>;
        } catch {
            return { entities: [], summary: 'parse error (malformed YAML)' };
        }

        // ── Stages ───────────────────────────────────────────────────────────
        const stages: string[] = Array.isArray(parsed.stages)
            ? parsed.stages.map(String)
            : ['.pre', 'build', 'test', 'deploy', '.post']; // GitLab defaults

        // ── Jobs ─────────────────────────────────────────────────────────────
        const jobNames = Object.keys(parsed).filter(k => !GITLAB_RESERVED_KEYS.has(k));
        const jobCount = jobNames.length;

        // ── Includes ─────────────────────────────────────────────────────────
        const rawIncludes = toArray<unknown>(parsed.include);
        const includes = rawIncludes
            .map(resolveIncludeRef)
            .filter(Boolean);

        // ── CI Components (GitLab) ──────────────────────────────────────────
        // Each `include: - component: host/path/name@ref` becomes a
        // CIComponent node with tool='gitlab-ci'. Inputs (if declared inline)
        // are JSON-encoded for later querying. Resolution of the remote
        // template (image, scripts, deploy stage, review env) is a separate
        // async concern; fetchStatus is left at 'skipped' until that step
        // runs. The CIComponent schema is tool-agnostic so a future GitHub
        // Actions reusable-workflow extractor can populate the same node
        // shape with tool='github-actions'.
        const componentEntities: StructuralEntity[] = [];
        for (const item of rawIncludes) {
            if (!item || typeof item !== 'object') continue;
            const entry = item as Record<string, unknown>;
            if (typeof entry.component !== 'string') continue;
            const decl = parseGitLabComponentRef(entry.component, entry.inputs);
            if (!decl) continue;
            componentEntities.push({
                id: ciComponentUrn(decl, 'gitlab-ci'),
                labels: ['CIComponent'],
                properties: {
                    tool: 'gitlab-ci',
                    name: decl.name,
                    host: decl.host,
                    projectPath: decl.projectPath,
                    ref: decl.ref,
                    templateUrl: decl.templateUrl,
                    inputsJson: decl.inputsJson ?? null,
                    fetchStatus: 'skipped',
                    _sourcePath: context.relativePath,
                    _ownerService: context.ownerService,
                },
                relationshipType: 'INCLUDES_COMPONENT',
            });
        }

        // ── Merge Request Pipeline detection ─────────────────────────────────
        // Heuristic: check for common MR-trigger patterns in content
        // rather than deep-parsing the `workflow.rules` AST.
        const hasMergeRequestPipeline =
            content.includes('merge_request_event') ||
            content.includes('$CI_MERGE_REQUEST_IID') ||
            content.includes('$CI_PIPELINE_SOURCE == "merge_request_event"') ||
            content.includes("$CI_PIPELINE_SOURCE == 'merge_request_event'");

        // ── Stage classification ──────────────────────────────────────────────
        // Check both declared stage names AND job names for keywords.
        const allNames = [...stages, ...jobNames].map(s => s.toLowerCase());
        const hasTestStage = allNames.some(n => TEST_KEYWORDS.some(k => n.includes(k)));
        const hasDeployStage = allNames.some(n => DEPLOY_KEYWORDS.some(k => n.includes(k)));

        // ── Environments ─────────────────────────────────────────────────────
        const environments: string[] = [];
        for (const jobName of jobNames) {
            const job = parsed[jobName];
            if (typeof job !== 'object' || job === null) continue;
            const envName = extractEnvironmentName(job as Record<string, unknown>);
            if (envName && !environments.includes(envName)) {
                environments.push(envName);
            }
        }

        const hasReviewEnvironment = environments.some(e =>
            e.toLowerCase().includes('review'),
        );

        // ── Triggers ─────────────────────────────────────────────────────────
        // Infer from workflow.rules or from content patterns
        const triggers: string[] = [];
        if (hasMergeRequestPipeline) triggers.push('merge_request');
        if (content.includes('$CI_COMMIT_BRANCH') || content.includes('$CI_COMMIT_REF_NAME')) {
            triggers.push('push');
        }
        if (content.includes('$CI_PIPELINE_SOURCE == "schedule"') || content.includes("$CI_PIPELINE_SOURCE == 'schedule'")) {
            triggers.push('schedule');
        }
        if (content.includes('$CI_COMMIT_TAG')) {
            triggers.push('tag');
        }

        // ── Script tokens ───────────────────────────────────────────────────
        // Surface the unique command tokens used across all job script: blocks.
        // Each token is the first whitespace-separated word of a script line —
        // the executable name (e.g. "yarn", "npm", "fct", "bash"). Subsequent
        // arguments are dropped. Tokens are de-duplicated and joined as CSV so
        // policy queries can do `CONTAINS '<command>'` checks cheaply.
        const scriptTokens = new Set<string>();
        for (const jobName of jobNames) {
            const job = parsed[jobName];
            if (typeof job !== 'object' || job === null) continue;
            const jobObj = job as Record<string, unknown>;
            for (const key of ['before_script', 'script', 'after_script'] as const) {
                const lines = toArray<unknown>(jobObj[key]);
                for (const line of lines) {
                    if (typeof line !== 'string') continue;
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    // Strip env-var prefixes like "VAR=val cmd ..." → "cmd ..."
                    const sanitized = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/i, '');
                    const firstWord = sanitized.split(/\s+/)[0];
                    if (firstWord) scriptTokens.add(firstWord);
                }
            }
        }

        const entity = {
            id: buildUrn('cipipeline', context.repoName, 'gitlab-ci', context.relativePath),
            labels: ['CIPipeline'],
            properties: {
                name: context.relativePath,
                tool: 'gitlab-ci',
                filePath: context.relativePath,
                stages: stages.join(','),
                jobCount,
                includes: includes.join(','),
                triggers: triggers.join(','),
                hasMergeRequestPipeline,
                hasTestStage,
                hasDeployStage,
                hasReviewEnvironment,
                environments: environments.join(','),
                scriptTokens: Array.from(scriptTokens).sort().join(','),
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        };

        // ── Docker Images (CI runners & services) ─────────────────────────
        // Extract images used as job runners and service containers.
        // Uses TG-3 variable resolution from top-level `variables:` block.
        const globalVars = (parsed.variables ?? {}) as Record<string, unknown>;

        function resolveGitlabVars(imageStr: string): string {
            return imageStr.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, v) => {
                const val = globalVars[v as string];
                return typeof val === 'string' ? val : _m;
            });
        }

        function extractImageString(imageValue: unknown): string | null {
            if (typeof imageValue === 'string') return imageValue;
            if (typeof imageValue === 'object' && imageValue !== null) {
                const name = (imageValue as Record<string, unknown>).name;
                if (typeof name === 'string') return name;
            }
            return null;
        }

        const imageEntities: StructuralEntity[] = [];

        function tryAddImage(rawStr: string): void {
            const resolved = resolveGitlabVars(rawStr);
            if (!isResolvableImageRef(resolved)) return;
            const ent = buildImageEntity(resolved, 'ci_runner', 'unknown', context.relativePath, context.ownerService);
            if (ent) imageEntities.push(ent);
        }

        // Top-level default image
        const topImage = extractImageString(parsed.image);
        if (topImage) tryAddImage(topImage);

        // Top-level services
        const topServices = Array.isArray(parsed.services) ? parsed.services : [];
        for (const svc of topServices) {
            const svcImg = extractImageString(svc);
            if (svcImg) tryAddImage(svcImg);
        }

        // Per-job images and services
        for (const jobName of jobNames) {
            const job = parsed[jobName];
            if (typeof job !== 'object' || job === null) continue;
            const jobObj = job as Record<string, unknown>;

            const jobImage = extractImageString(jobObj.image);
            if (jobImage) tryAddImage(jobImage);

            const jobServices = Array.isArray(jobObj.services) ? jobObj.services : [];
            for (const svc of jobServices) {
                const svcImg = extractImageString(svc);
                if (svcImg) tryAddImage(svcImg);
            }
        }

        const dedupedImages = deduplicateByUrn(imageEntities);
        const dedupedComponents = deduplicateByUrn(componentEntities);

        return {
            entities: [entity, ...dedupedImages, ...dedupedComponents],
            summary: `[GitLab CI] ${jobCount} job(s) | stages: ${stages.join(', ')} | includes: ${includes.length} | images: ${dedupedImages.length} | components: ${dedupedComponents.length}`,
        };
    },
};
