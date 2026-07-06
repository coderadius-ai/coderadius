// ═══════════════════════════════════════════════════════════════════════════════
// Container Image Utilities — Shared by container-image, gitlabci, githubactions
//
// Provides deterministic sanitization, validation, and deduplication for
// Docker image references extracted from YAML manifests and CI/CD files.
//
// NOT used by dockerfilePlugin — its regex-based FROM parsing already handles
// name/tag splitting correctly and Dockerfiles don't have runtime variables.
// ═══════════════════════════════════════════════════════════════════════════════

import { buildUrn } from '../../../graph/urn.js';
import type { StructuralEntity } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImageRef {
    /** Canonical image name (e.g. 'myregistry.com:5000/org/image'). */
    name: string;
    /** Image tag or digest (e.g. '20-alpine', 'sha256:abc123'). */
    tag: string;
}

// ─── TG-1: Image Reference Sanitization ──────────────────────────────────────

/**
 * Sanitize a raw image reference string into a canonical (name, tag) pair
 * safe for URN construction via `buildUrn('dockerimage', name, tag)`.
 *
 * Handles:
 *   - Whitespace/newline stripping
 *   - @sha256: digest separation (digest becomes the tag)
 *   - Empty/missing tag defaults to 'latest'
 *   - Registry-with-port normalization (myregistry.com:5000/image:tag)
 *
 * Returns `null` for empty or unparseable strings.
 *
 * @example
 *   sanitizeImageRef('postgres:15')              → { name: 'postgres', tag: '15' }
 *   sanitizeImageRef('nginx')                     → { name: 'nginx', tag: 'latest' }
 *   sanitizeImageRef('reg.io:5000/app:v1')       → { name: 'reg.io:5000/app', tag: 'v1' }
 *   sanitizeImageRef('nginx@sha256:abc123')      → { name: 'nginx', tag: 'sha256:abc123' }
 *   sanitizeImageRef('')                          → null
 */
export function sanitizeImageRef(raw: string): ImageRef | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Handle @sha256: digest format (e.g. nginx@sha256:abc123)
    const digestIdx = trimmed.indexOf('@');
    if (digestIdx > 0) {
        const name = trimmed.slice(0, digestIdx);
        const digest = trimmed.slice(digestIdx + 1);  // "sha256:abc123..."
        return { name, tag: digest || 'latest' };
    }

    // Find the tag boundary: last colon that ISN'T part of a registry:port
    // Strategy: find the last '/' (path separator), then look for ':' after it.
    // If no '/' exists, the first ':' is the tag boundary (simple image:tag).
    const lastSlash = trimmed.lastIndexOf('/');
    const searchFrom = lastSlash >= 0 ? lastSlash : 0;
    const colonAfterPath = trimmed.indexOf(':', searchFrom);

    if (colonAfterPath > 0 && colonAfterPath > lastSlash) {
        const name = trimmed.slice(0, colonAfterPath);
        const tag = trimmed.slice(colonAfterPath + 1);
        return { name, tag: tag || 'latest' };
    }

    return { name: trimmed, tag: 'latest' };
}

// ─── TG-3: Unresolved Variable Detection ─────────────────────────────────────

/** Unresolved variable/template markers that indicate the value is not literal. */
const UNRESOLVED_MARKERS = [
    '$',           // Shell/CI variables: $VAR, ${VAR}, ${{ ... }}
    '{{',          // Go/Helm templates: {{ .Values.x }}
    '__CR_',       // CodeRadius Helm placeholder: __CR_VAL_x__
    '%{',          // Ruby ERB templates
];

/**
 * Returns true if the image reference is a concrete, resolvable string.
 * Returns false if it contains unresolved variable/template markers.
 *
 * Fail-closed: it is better to drop a dynamic image than to pollute
 * the global registry with Frankenstein URNs like `cr:dockerimage:postgres:$VERSION`.
 *
 * @example
 *   isResolvableImageRef('postgres:15')            → true
 *   isResolvableImageRef('postgres:$VERSION')       → false
 *   isResolvableImageRef('{{ .Values.image }}')     → false
 *   isResolvableImageRef('${REGISTRY}/app:${TAG}') → false
 */
export function isResolvableImageRef(imageStr: string): boolean {
    return !UNRESOLVED_MARKERS.some(m => imageStr.includes(m));
}

// ─── TG-2: Per-File Deduplication ────────────────────────────────────────────

/**
 * Deduplicate entities by URN within a single file's extraction result.
 * First occurrence wins — prevents MERGE edge-property overwrites when
 * the same image appears in multiple services within the same compose file.
 */
export function deduplicateByUrn(entities: StructuralEntity[]): StructuralEntity[] {
    const seen = new Set<string>();
    return entities.filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
    });
}

// ─── Scope Inference ─────────────────────────────────────────────────────────

/**
 * Infer the deployment scope from the source filename.
 *
 * @example
 *   inferScopeFromFilename('docker-compose.prod.yml')      → 'production'
 *   inferScopeFromFilename('docker-compose.override.yml')  → 'development'
 *   inferScopeFromFilename('values-staging.yaml')           → 'staging'
 *   inferScopeFromFilename('docker-compose.yml')            → 'unknown'
 */
export function inferScopeFromFilename(relativePath: string): string {
    const lower = relativePath.toLowerCase();

    // Production indicators
    if (/(?:^|[.\-_/])prod(?:uction)?(?:[.\-_/]|$)/.test(lower)) return 'production';

    // Development indicators
    if (/(?:^|[.\-_/])(?:dev(?:elopment)?|override|local)(?:[.\-_/]|$)/.test(lower)) return 'development';

    // Staging indicators
    if (/(?:^|[.\-_/])stag(?:ing)?(?:[.\-_/]|$)/.test(lower)) return 'staging';

    return 'unknown';
}

// ─── Entity Builder ──────────────────────────────────────────────────────────

/**
 * Build a `DockerImage` StructuralEntity with USES_IMAGE edge properties.
 * Returns null if the image reference is unresolvable or invalid.
 */
export function buildImageEntity(
    rawImageStr: string,
    context: 'infrastructure' | 'ci_runner',
    scope: string,
    sourcePath: string,
    ownerService?: string,
): StructuralEntity | null {
    if (!isResolvableImageRef(rawImageStr)) return null;

    const ref = sanitizeImageRef(rawImageStr);
    if (!ref) return null;

    return {
        id: buildUrn('dockerimage', ref.name, ref.tag),
        labels: ['DockerImage'],
        properties: {
            name: ref.name,
            tag: ref.tag,
            _sourcePath: sourcePath,
            _ownerService: ownerService,
        },
        relationshipType: 'USES_IMAGE',
        relationshipProperties: {
            context,
            scope,
        },
    };
}
