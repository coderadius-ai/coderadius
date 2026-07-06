import yaml from 'js-yaml';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import {
    buildImageEntity,
    deduplicateByUrn,
    inferScopeFromFilename,
    isResolvableImageRef,
    sanitizeImageRef,
} from './container-image-utils.js';
import { stripGoTemplates, findValuesFile, resolvePlaceholders } from './contrib/helm-template-resolver.js';
import fs from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════════
// Container Image Plugin — Extract DockerImage nodes from infrastructure manifests
//
// Parses Docker Compose, Kubernetes workloads, and Helm values files to create
// DockerImage nodes linked via USES_IMAGE edges (not USES_BASE_IMAGE, which is
// reserved for Dockerfile FROM instructions).
//
// Architecture:
//   matchFile     — *.yaml / *.yml (wide net, same as crossplane plugin)
//   contentSig    — /^\s*image\s*:/m (fast-fail on non-matching YAML)
//   filename guard — excludes CI files, internal config, etc.
//   managedLabels — ['DockerImage'] (participates in union Mark & Sweep)
//
// Gotchas addressed:
//   AG-1 — context/scope on USES_IMAGE edge, not node
//   TG-1 — sanitizeImageRef() before buildUrn
//   TG-2 — deduplicateByUrn() per file
//   TG-3 — isResolvableImageRef() fail-closed guard
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Filename Guards ─────────────────────────────────────────────────────────

/** Files handled by CI plugins — must NOT be processed here. */
const CI_FILE_PATTERNS = [
    /^\.github\/workflows\//,           // GitHub Actions
    /(?:^|\/)\.gitlab-ci(?:\..*)?\.ya?ml$/i,  // GitLab CI
    /(?:^|\/)Jenkinsfile$/i,            // Jenkins
];

/** Internal config files that happen to use YAML but are not infrastructure. */
const EXCLUDED_BASENAMES = new Set([
    'coderadius.yaml',
    'coderadius.yml',
    'catalog-info.yaml',    // Backstage
    'mkdocs.yml',           // MkDocs
    'codecov.yml',          // Codecov
    '.pre-commit-config.yaml',
]);

function isCIFile(relativePath: string): boolean {
    return CI_FILE_PATTERNS.some(p => p.test(relativePath));
}

function isExcludedFile(relativePath: string, basename: string): boolean {
    if (isCIFile(relativePath)) return true;
    if (EXCLUDED_BASENAMES.has(basename.toLowerCase())) return true;
    // Renovate configs are JSON/JSON5 but some are .yaml
    if (/^\.?renovate/i.test(basename)) return true;
    return false;
}

// ─── Format Detection ────────────────────────────────────────────────────────

type ManifestFormat = 'compose' | 'k8s' | 'helm-values' | 'unknown';

const K8S_WORKLOAD_KINDS = new Set([
    'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob',
    'Pod', 'ReplicaSet',
]);

function detectFormat(parsed: Record<string, unknown>, relativePath: string): ManifestFormat {
    // Docker Compose: has `services:` top-level key
    if (parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)) {
        return 'compose';
    }

    // Kubernetes: has `kind:` matching a workload type
    if (typeof parsed.kind === 'string' && K8S_WORKLOAD_KINDS.has(parsed.kind)) {
        return 'k8s';
    }

    // Helm values: filename matches values*.yaml pattern
    const basename = relativePath.split('/').pop()?.toLowerCase() ?? '';
    if (/^values.*\.ya?ml$/.test(basename)) {
        return 'helm-values';
    }

    return 'unknown';
}

// ─── Image Extractors ────────────────────────────────────────────────────────

function extractComposeImages(parsed: Record<string, unknown>): string[] {
    const services = parsed.services as Record<string, unknown>;
    if (!services || typeof services !== 'object') return [];

    const images: string[] = [];
    for (const [, svcDef] of Object.entries(services)) {
        if (!svcDef || typeof svcDef !== 'object') continue;
        const svc = svcDef as Record<string, unknown>;
        if (typeof svc.image === 'string') {
            images.push(svc.image);
        }
    }
    return images;
}

function extractK8sImages(parsed: Record<string, unknown>): string[] {
    const images: string[] = [];

    // Navigate to spec.template.spec for workload resources
    const spec = parsed.spec as Record<string, unknown> | undefined;
    const template = spec?.template as Record<string, unknown> | undefined;
    const podSpec = template?.spec as Record<string, unknown> | undefined;

    if (!podSpec) {
        // Direct Pod spec
        const directPodSpec = spec as Record<string, unknown> | undefined;
        if (directPodSpec) {
            extractContainerImages(directPodSpec, images);
        }
        return images;
    }

    extractContainerImages(podSpec, images);
    return images;
}

function extractContainerImages(podSpec: Record<string, unknown>, images: string[]): void {
    // containers[*].image
    const containers = podSpec.containers;
    if (Array.isArray(containers)) {
        for (const c of containers) {
            if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).image === 'string') {
                images.push((c as Record<string, unknown>).image as string);
            }
        }
    }

    // initContainers[*].image
    const initContainers = podSpec.initContainers;
    if (Array.isArray(initContainers)) {
        for (const c of initContainers) {
            if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).image === 'string') {
                images.push((c as Record<string, unknown>).image as string);
            }
        }
    }
}

/**
 * Extract images from Helm values files.
 * Common patterns:
 *   image: nginx:stable                     → simple string
 *   image: { repository: nginx, tag: stable } → object with repository/tag
 *   app: { image: { repository: x, tag: y } } → nested under service key
 */
function extractHelmValuesImages(parsed: Record<string, unknown>): string[] {
    const images: string[] = [];
    walkHelmValues(parsed, images, 0);
    return images;
}

function walkHelmValues(obj: Record<string, unknown>, images: string[], depth: number): void {
    // Prevent infinite recursion on deeply nested or circular structures
    if (depth > 8) return;

    for (const [key, value] of Object.entries(obj)) {
        if (key === 'image') {
            if (typeof value === 'string') {
                images.push(value);
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                const imgObj = value as Record<string, unknown>;
                const repo = imgObj.repository;
                const tag = imgObj.tag;
                if (typeof repo === 'string') {
                    const fullRef = tag ? `${repo}:${String(tag)}` : repo;
                    images.push(fullRef);
                }
            }
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            walkHelmValues(value as Record<string, unknown>, images, depth + 1);
        }
    }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const containerImagePlugin: StructuralPlugin = {
    name: 'container-image',
    label: 'Container Images',
    managedLabels: ['DockerImage'],

    /** Content signature: fast-fail on files that don't have `image:` anywhere. */
    contentSignatures: [/^\s*-?\s*image\s*:/m],

    matchFile(relativePath: string, basename: string): boolean {
        if (isExcludedFile(relativePath, basename)) return false;
        return /\.ya?ml$/i.test(basename);
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        // ── 1. Prepare content — strip Helm templates if needed ──────────
        let processableContent = content;
        const isHelmTemplate = context.relativePath.includes('/templates/');

        if (isHelmTemplate) {
            processableContent = stripGoTemplates(content);

            // Attempt values.yaml resolution for Helm templates
            const valuesFile = findValuesFile(context.absolutePath);
            if (valuesFile) {
                try {
                    const valuesContent = fs.readFileSync(valuesFile, 'utf-8');
                    const values = yaml.load(valuesContent) as Record<string, unknown>;
                    if (values && typeof values === 'object') {
                        processableContent = resolvePlaceholders(processableContent, values);
                    }
                } catch {
                    // values.yaml parse failed — continue with placeholders
                }
            }
        }

        // ── 2. Parse YAML ────────────────────────────────────────────────
        let parsed: Record<string, unknown>;
        try {
            const raw = yaml.load(processableContent);
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return { entities: [], summary: 'empty or non-object YAML' };
            }
            parsed = raw as Record<string, unknown>;
        } catch {
            return { entities: [], summary: 'parse error (malformed YAML)' };
        }

        // ── 3. Detect format ─────────────────────────────────────────────
        const format = detectFormat(parsed, context.relativePath);
        if (format === 'unknown') {
            return { entities: [], summary: 'not an infrastructure manifest' };
        }

        // ── 4. Extract raw image strings ─────────────────────────────────
        let rawImages: string[];
        switch (format) {
            case 'compose':
                rawImages = extractComposeImages(parsed);
                break;
            case 'k8s':
                rawImages = extractK8sImages(parsed);
                break;
            case 'helm-values':
                rawImages = extractHelmValuesImages(parsed);
                break;
        }

        if (rawImages.length === 0) {
            return { entities: [], summary: `${format} manifest with no image references` };
        }

        // ── 5. Build entities with safety guards (TG-1, TG-3) ────────────
        const scope = inferScopeFromFilename(context.relativePath);
        const entities = rawImages
            .map(img => buildImageEntity(img, 'infrastructure', scope, context.relativePath, context.ownerService))
            .filter((e): e is NonNullable<typeof e> => e !== null);

        // ── 6. Deduplicate per file (TG-2) ───────────────────────────────
        const deduped = deduplicateByUrn(entities);

        const imageList = deduped.map(e => `${e.properties.name}:${e.properties.tag}`).join(', ');
        return {
            entities: deduped,
            summary: `[${format}] ${deduped.length} image(s): ${imageList}`,
        };
    },
};
