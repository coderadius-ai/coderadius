// ═══════════════════════════════════════════════════════════════════════════════
// Helm Template Resolver — Go Template Stripping & Values Resolution
//
// Pure-function utility for parsing Helm chart templates without a full
// Helm evaluation engine. Handles the common patterns:
//   - {{ $.Values.x.y.z }} → placeholder → resolved from values.yaml
//   - {{ .Release.Name }}  → stripped (deploy-time value, unknowable)
//   - {{- if/range/end }}  → deleted (control flow, not data)
//
// This module lives in contrib/ because it was built for Crossplane CRD
// extraction, but it is fully generic and reusable for any Helm-based plugin.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Placeholder prefix for Values references. */
const VAL_PREFIX = '__CR_VAL_';
const VAL_SUFFIX = '__';

/** Matches {{ $.Values.x.y.z }} or {{ .Values.x.y.z }} (with optional pipe filters like | lower). */
const VALUES_REF_RE = /\{\{-?\s*(?:\$\.|\.)Values\.([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*-?\}\}/g;

/** Matches {{ $.Release.Name }} and similar non-Values Go template expressions. */
const RELEASE_REF_RE = /\{\{-?\s*(?:\$\.)?\s*\.?Release\.[a-zA-Z0-9_.]+\s*-?\}\}/g;

/** Matches control flow blocks: {{- if ... }}, {{- else }}, {{- end }}, {{- range ... }}, {{- with ... }}. */
const CONTROL_FLOW_RE = /^\s*\{\{-?\s*(?:if|else|end|range|with|define|template|block)\b[^}]*-?\}\}\s*$/;

/** Matches any remaining {{ ... }} expression after specific replacements. Non-greedy to handle nested braces. */
const REMAINING_TEMPLATE_RE = /\{\{-?[\s\S]*?-?\}\}/g;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip Go template syntax from Helm YAML content to make it parseable by js-yaml.
 *
 * Strategy:
 *   1. Replace {{ $.Values.x.y }} with __CR_VAL_x_y__ placeholders
 *   2. Delete control flow lines ({{- if/else/end/range }}) entirely
 *   3. Replace {{ .Release.Name }} with empty string
 *   4. Strip any remaining {{ ... }} expressions
 *
 * @param content  Raw Helm template YAML content
 * @returns        YAML content parseable by js-yaml, with placeholders for Values refs
 */
export function stripGoTemplates(content: string): string {
    // Step 1: Replace Values references with resolvable placeholders
    // Use pipe '|' as dot-separator to avoid ambiguity with underscores in key names
    // (e.g., TOPIC_NAME would collide if we used underscore as separator)
    let result = content.replace(VALUES_REF_RE, (_match, dotPath: string) => {
        const key = dotPath.replace(/\./g, '|');
        return `${VAL_PREFIX}${key}${VAL_SUFFIX}`;
    });

    // Step 2: Delete control flow lines entirely (line-by-line to preserve YAML structure)
    result = result
        .split('\n')
        .filter(line => !CONTROL_FLOW_RE.test(line))
        .join('\n');

    // Step 3: Replace Release references with empty string
    result = result.replace(RELEASE_REF_RE, '');

    // Step 4: Strip any remaining Go template expressions by converting them to comments
    // This prevents syntax errors when templates are used as block scalar values or dict values
    result = result.replace(REMAINING_TEMPLATE_RE, ' # template');

    return result;
}

/**
 * Resolve a dot-path against a parsed values.yaml object.
 *
 * @param values   Parsed values.yaml as a nested object
 * @param dotPath  Dot-separated path, e.g. 'global.configuration.TOPIC_NAME'
 * @returns        The resolved string value, or undefined if the path doesn't exist
 */
export function resolveHelmValue(values: Record<string, unknown>, dotPath: string): string | undefined {
    const segments = dotPath.split('.');
    let current: unknown = values;

    for (const segment of segments) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }

    if (current === null || current === undefined) return undefined;
    return String(current);
}

/**
 * Find the values.yaml file relative to a Helm template file path.
 *
 * Walks up from the template directory to find a sibling `values.yaml`.
 * Prefers the base `values.yaml` over environment-specific overrides.
 *
 * Expected directory structures:
 *   .charts/templates/sub.yaml     → .charts/values.yaml
 *   charts/my-svc/templates/x.yaml → charts/my-svc/values.yaml
 *   helm/templates/x.yaml          → helm/values.yaml
 *
 * @param templateAbsPath  Absolute path to the Helm template file
 * @returns                Absolute path to values.yaml, or null if not found
 */
export function findValuesFile(templateAbsPath: string): string | null {
    let dir = path.dirname(templateAbsPath);

    // Walk up at most 3 levels (templates/ → chart root → parent)
    for (let i = 0; i < 3; i++) {
        const candidate = path.join(dir, 'values.yaml');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
    }

    return null;
}

/**
 * Replace __CR_VAL_x_y__ placeholders in a string with resolved values from values.yaml.
 *
 * @param text    String containing __CR_VAL_x_y__ placeholders
 * @param values  Parsed values.yaml as a nested object
 * @returns       String with placeholders replaced by resolved values
 */
export function resolvePlaceholders(text: string, values: Record<string, unknown>): string {
    const placeholderRe = new RegExp(`${VAL_PREFIX}([a-zA-Z0-9_|]+)${VAL_SUFFIX}`, 'g');

    return text.replace(placeholderRe, (_match, key: string) => {
        // Convert pipe-separated key back to dot-path
        const dotPath = key.replace(/\|/g, '.');
        const resolved = resolveHelmValue(values, dotPath);
        return resolved ?? _match; // keep placeholder if unresolvable
    });
}

/**
 * Extract all Values dot-paths referenced in a Helm template.
 * Useful for understanding which values.yaml keys a template depends on.
 *
 * @param content  Raw Helm template YAML content
 * @returns        Array of dot-paths, e.g. ['global.configuration.TOPIC_NAME']
 */
export function extractValuesPaths(content: string): string[] {
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(VALUES_REF_RE.source, 'g');

    while ((match = re.exec(content)) !== null) {
        paths.push(match[1]);
    }

    return [...new Set(paths)];
}
