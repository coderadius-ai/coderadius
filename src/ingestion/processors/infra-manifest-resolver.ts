import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { logger } from '../../utils/logger.js';
import type { InfraManifestHint } from './db-scope-resolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Infrastructure Manifest Resolver (P2 — Auto-Discovery)
//
// Parses Docker Compose, Helm values, and K8s ConfigMap files to extract
// database definitions. These become InfraManifestHint[] feeding into
// resolveDatastoreBinding().
//
// Docker Compose: looks for services with known DB images and extracts
//   POSTGRES_DB, MYSQL_DATABASE, MONGO_INITDB_DATABASE from environment blocks.
//
// Helm / K8s: looks for DB_NAME, POSTGRES_DB, MONGO_DB in values files
//   and ConfigMaps. Skips Go template expressions ({{ .Values.* }}).
//
// Design: runs once per repo, results cached via loadRepoContext().
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Known DB images ─────────────────────────────────────────────────────────

const DB_IMAGE_MAP: Record<string, string> = {
    postgres: 'postgres',
    postgresql: 'postgres',
    mysql: 'mysql',
    mariadb: 'mysql',
    mongo: 'mongodb',
    mongodb: 'mongodb',
    redis: 'redis',
    'bitnami/postgresql': 'postgres',
    'bitnami/mysql': 'mysql',
    'bitnami/mongodb': 'mongodb',
    'bitnami/redis': 'redis',
};

/** Known environment variables that hold a database name, grouped by technology. */
const DB_NAME_ENV_VARS: Record<string, string> = {
    POSTGRES_DB: 'postgres',
    POSTGRES_DATABASE: 'postgres',
    MYSQL_DATABASE: 'mysql',
    MONGO_INITDB_DATABASE: 'mongodb',
    MONGO_DB: 'mongodb',
    DB_NAME: '', // generic — technology inferred from image
    DATABASE_NAME: '', // generic
};

// ─── Docker Compose Parser ───────────────────────────────────────────────────

interface ComposeService {
    image?: string;
    environment?: Record<string, string> | string[];
    env_file?: string | string[];
    depends_on?: string[] | Record<string, unknown>;
}

function extractFromDockerCompose(parsed: unknown, relPath: string, confidence: 'high' | 'medium'): InfraManifestHint[] {
    if (!parsed || typeof parsed !== 'object') return [];

    const root = parsed as Record<string, unknown>;
    const services = (root.services ?? root) as Record<string, ComposeService> | undefined;
    if (!services || typeof services !== 'object') return [];

    const hints: InfraManifestHint[] = [];

    for (const [, service] of Object.entries(services)) {
        if (!service || typeof service !== 'object') continue;

        // Detect technology from image
        const image = service.image;
        if (!image || typeof image !== 'string') continue;

        // Extract base image name (strip registry, tag, digest)
        const imageName = image.split(':')[0].split('/').pop()?.toLowerCase() ?? '';
        let technology = '';

        for (const [pattern, tech] of Object.entries(DB_IMAGE_MAP)) {
            if (imageName === pattern || image.toLowerCase().startsWith(pattern)) {
                technology = tech;
                break;
            }
        }

        if (!technology) continue; // Not a recognized DB image

        // Extract DB name from environment block
        const env = service.environment;
        if (!env) continue;

        const envMap = normalizeEnv(env);

        for (const [varName, varTech] of Object.entries(DB_NAME_ENV_VARS)) {
            const value = envMap.get(varName);
            if (!value) continue;
            if (isTemplateValue(value)) continue;

            hints.push({
                dbName: value,
                technology: varTech || technology, // specific var tech wins, else image tech
                sourceFile: relPath,
                confidence,
            });
        }
    }

    return hints;
}

/** Normalize Docker Compose environment (can be object or array of KEY=VALUE). */
function normalizeEnv(env: Record<string, string> | string[]): Map<string, string> {
    const map = new Map<string, string>();

    if (Array.isArray(env)) {
        for (const entry of env) {
            const eq = entry.indexOf('=');
            if (eq > 0) {
                map.set(entry.substring(0, eq).trim(), entry.substring(eq + 1).trim());
            }
        }
    } else if (typeof env === 'object') {
        for (const [k, v] of Object.entries(env)) {
            if (typeof v === 'string') {
                map.set(k.trim(), v.trim());
            }
        }
    }

    return map;
}

// ─── Helm / K8s ConfigMap Parser ─────────────────────────────────────────────

function extractFromHelmOrK8s(parsed: unknown, relPath: string, confidence: 'high' | 'medium'): InfraManifestHint[] {
    if (!parsed || typeof parsed !== 'object') return [];

    const hints: InfraManifestHint[] = [];
    const found = new Map<string, string>(); // dbName → technology

    // Recursively scan for known DB env var keys
    scanObjectForDbVars(parsed, found);

    for (const [dbName, technology] of found) {
        hints.push({
            dbName,
            technology: technology || 'unknown',
            sourceFile: relPath,
            confidence,
        });
    }

    return hints;
}

function scanObjectForDbVars(obj: unknown, found: Map<string, string>): void {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        for (const item of obj) scanObjectForDbVars(item, found);
        return;
    }

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        const upperKey = key.toUpperCase();

        if (upperKey in DB_NAME_ENV_VARS && typeof val === 'string') {
            if (!isTemplateValue(val)) {
                found.set(val, DB_NAME_ENV_VARS[upperKey]);
            }
        }

        // Recurse into nested objects
        if (val && typeof val === 'object') {
            scanObjectForDbVars(val, found);
        }
    }
}

/** Detect Go template expressions and K8s secret references. */
function isTemplateValue(value: string): boolean {
    return /\{\{.*\}\}/.test(value)                    // Go templates: {{ .Values.x }}
        || /valueFrom/i.test(value)                    // K8s secretKeyRef
        || /\$\{[^}]+\}/.test(value)                   // Shell variable
        || value.trim() === '';
}

// ─── File-level scan targets ─────────────────────────────────────────────────

interface InfraScanTarget {
    patterns: string[];
    confidence: 'high' | 'medium';
}

const INFRA_SCAN_TARGETS: InfraScanTarget[] = [
    // Docker Compose
    { patterns: [
        'docker-compose.yml', 'docker-compose.yaml',
        'docker-compose.prod.yml', 'docker-compose.production.yml',
    ], confidence: 'high' },
    // Helm values
    { patterns: [
        'helm/values.yaml', 'helm/values-prod.yaml', 'helm/values-production.yaml',
        'chart/values.yaml', 'charts/values.yaml',
    ], confidence: 'high' },
    // K8s ConfigMaps / overlays
    { patterns: [
        'k8s/configmap.yaml', 'k8s/configmap.yml',
        'kubernetes/configmap.yaml',
        'deploy/configmap.yaml',
    ], confidence: 'medium' },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan a repository for infrastructure manifests (Docker Compose, Helm, K8s)
 * and extract database definitions.
 *
 * Called ONCE per repo (results memoized via loadRepoContext()).
 *
 * @param repoPath  Absolute path to the repository root
 * @returns Array of InfraManifestHint[] ready for resolveDatastoreBinding()
 */
export function extractInfraManifests(repoPath: string): InfraManifestHint[] {
    const allHints: InfraManifestHint[] = [];

    for (const target of INFRA_SCAN_TARGETS) {
        for (const pattern of target.patterns) {
            const absPath = path.join(repoPath, pattern);
            if (!fs.existsSync(absPath)) continue;

            try {
                const stats = fs.statSync(absPath);
                if (stats.size > 512 * 1024) continue; // skip large files

                const content = fs.readFileSync(absPath, 'utf-8');
                const parsed = yaml.load(content);

                const relPath = path.relative(repoPath, absPath);

                // Docker Compose files have a 'services' key
                if (parsed && typeof parsed === 'object' && ('services' in (parsed as object))) {
                    const hints = extractFromDockerCompose(parsed, relPath, target.confidence);
                    allHints.push(...hints);
                } else {
                    // Helm / K8s / generic YAML
                    const hints = extractFromHelmOrK8s(parsed, relPath, target.confidence);
                    allHints.push(...hints);
                }
            } catch (err) {
                logger.debug(`[InfraManifest] Failed to parse ${pattern}: ${(err as Error).message}`);
            }
        }
    }

    // Deduplicate by dbName+technology
    const seen = new Set<string>();
    const result: InfraManifestHint[] = [];
    for (const hint of allHints) {
        const key = `${hint.technology}:${hint.dbName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(hint);
    }

    if (result.length > 0) {
        logger.debug(`[InfraManifest] Found ${result.length} DB definition(s) in ${repoPath}: ` +
            result.map(h => `${h.technology}/${h.dbName}`).join(', '));
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Env Var Dictionary — Generic Env Var Value Extraction
//
// Scans Helm values, Docker Compose, and K8s ConfigMap files to build a flat
// Map<envVarName, EnvVarBinding> of hardcoded literal values.
//
// Used by graph-writer to resolve env-var-based MessageChannel names
// (e.g. process.env.MY_TOPIC_NAME → "Acme-OrderCreated") and to annotate
// EnvVar graph nodes with their deployment-config values.
//
// Design: purely static, zero LLM. Runs once per repo, memoized via
// loadRepoContext(). Completely technology-agnostic — no knowledge of
// any specific message bus SDK, RabbitMQ, Kafka, or middleware.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single env var binding extracted from a deployment config file.
 */
export interface EnvVarBinding {
    /** The literal string value (e.g. "Acme-OrderCreated"). */
    value: string;
    /** Relative path where the value was found. */
    sourceFile: string;
    /** 0–1 deterministic confidence based on file environment classification. */
    confidence: number;
}

// ─── Env Var Dictionary — File Discovery ─────────────────────────────────────

/**
 * Glob patterns for env var dictionary extraction.
 * These are relative to the repo root.
 */
const ENV_VAR_GLOB_PATTERNS: string[] = [
    // Helm values (standard directories)
    'helm/values.yaml', 'helm/values-prod.yaml', 'helm/values-production.yaml',
    'chart/values.yaml', 'charts/values.yaml',
    'chart/values-prod.yaml', 'chart/values-production.yaml',
    'charts/values-prod.yaml', 'charts/values-production.yaml',
    // Docker Compose
    'docker-compose.yml', 'docker-compose.yaml',
    'docker-compose.prod.yml', 'docker-compose.production.yml',
    // K8s ConfigMaps
    'k8s/configmap.yaml', 'k8s/configmap.yml',
    'kubernetes/configmap.yaml', 'deploy/configmap.yaml',
];

/**
 * Dynamic glob patterns that require single-level directory expansion.
 * e.g. .charts/STAR/values.yaml matches .charts/api/values.yaml, .charts/event-consumer/values.yaml
 */
const ENV_VAR_DYNAMIC_GLOBS: string[] = [
    '.charts/*/values.yaml',
    '.charts/*/values-prod.yaml',
    '.charts/*/values-production.yaml',
    'charts/*/values.yaml',
    'charts/*/values-prod.yaml',
    'charts/*/values-production.yaml',
    'helm/*/values.yaml',
    'helm/*/values-prod.yaml',
    'helm/*/values-production.yaml',
];

/**
 * Expand a simple glob pattern with exactly one wildcard by scanning the filesystem.
 * Returns absolute paths of matching files.
 */
function expandSimpleGlob(repoPath: string, pattern: string): string[] {
    const starIdx = pattern.indexOf('*');
    if (starIdx === -1) return [];

    const prefix = pattern.substring(0, starIdx);
    const suffix = pattern.substring(starIdx + 1);
    const parentDir = path.join(repoPath, prefix);

    if (!fs.existsSync(parentDir)) return [];

    try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        const results: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(parentDir, entry.name, suffix);
            if (fs.existsSync(candidate)) {
                results.push(candidate);
            }
        }
        return results;
    } catch {
        return [];
    }
}

// ─── Env Var Dictionary — Value Extraction ───────────────────────────────────

/**
 * Determine confidence score for a file based on its path.
 *
 * - 1.0 for production-tagged files (values-production.yaml, docker-compose.prod.yml)
 * - 0.7 for base values files (values.yaml, no env tag)
 * - 0.5 for non-production / ambiguous files
 *
 * Reuses the same production detection logic from isProdFilePath (helm-env-extractor).
 */
function envVarConfidenceForFile(relPath: string): number {
    const lower = relPath.toLowerCase();

    // Production-tagged files
    const prodPatterns = ['-prod.', '-production.', '.prod.', '.production.', '/prod/', '/production/'];
    if (prodPatterns.some(p => lower.includes(p))) return 1.0;

    // Docker Compose production
    if (lower.includes('docker-compose') && lower.includes('prod')) return 0.9;

    // Non-production tagged
    const nonProdPatterns = ['-dev.', '-staging.', '-test.', '-local.', '-qa.', '-sandbox.', '-preview.', '-uat.',
                            '-mocked.', '-canary.'];
    if (nonProdPatterns.some(p => lower.includes(p))) return 0.3;

    // Base values file (no env tag) — likely defaults
    if (lower.endsWith('values.yaml') || lower.endsWith('values.yml')) return 0.7;

    // Docker Compose (no env tag)
    if (lower.includes('docker-compose')) return 0.5;

    // Generic / ambiguous
    return 0.5;
}

/**
 * Extract env var name-value pairs from a Helm/K8s deployment template.
 * Looks for env blocks with { name: X, value: Y } entries.
 * Skips Go templates, shell vars, secretKeyRef, and empty values.
 */
function extractEnvBlockBindings(parsed: unknown, relPath: string, confidence: number): Map<string, EnvVarBinding> {
    const bindings = new Map<string, EnvVarBinding>();
    if (!parsed || typeof parsed !== 'object') return bindings;

    scanForEnvBlocks(parsed, relPath, confidence, bindings);
    return bindings;
}

/**
 * Structural guard: returns true if the first non-null element in an array
 * has both `name` and `value` string properties. This heuristic reliably
 * identifies env-block arrays regardless of their parent key name.
 *
 * Handles: env, envs, envs.plain, envs.secret, customEnvs, etc.
 */
function isNameValueArray(arr: unknown[]): boolean {
    const first = arr.find(item => item && typeof item === 'object' && !Array.isArray(item));
    if (!first) return false;
    const obj = first as Record<string, unknown>;
    return typeof obj.name === 'string' && ('value' in obj || 'valueFrom' in obj);
}

/** Process an array of {name, value} entries, extracting literal values. */
function processEnvArray(arr: unknown[], relPath: string, confidence: number, bindings: Map<string, EnvVarBinding>): void {
    for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if ('valueFrom' in e) continue;

        const name = e.name;
        const value = e.value;
        if (typeof name !== 'string' || typeof value !== 'string') continue;
        if (isTemplateValue(value)) continue;

        const existing = bindings.get(name.toUpperCase());
        if (!existing || existing.confidence < confidence) {
            bindings.set(name.toUpperCase(), { value, sourceFile: relPath, confidence });
        }
    }
}

/** Process an array of {name, value} entries, collecting Go template references. */
function processTemplateArray(arr: unknown[], result: Map<string, string>): void {
    for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if ('valueFrom' in e) continue;

        const name = e.name;
        const value = e.value;
        if (typeof name !== 'string' || typeof value !== 'string') continue;

        if (/\{\{.*\}\}/.test(value)) {
            const helmPath = extractHelmValuesPath(value);
            if (helmPath) {
                result.set(name.toUpperCase(), helmPath);
            }
        }
    }
}

/**
 * Recursively scan an object tree for env arrays containing
 * name/value entry objects.
 */
function scanForEnvBlocks(obj: unknown, relPath: string, confidence: number, bindings: Map<string, EnvVarBinding>): void {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        // Check if this array itself is an env block (array of {name, value} objects)
        if (isNameValueArray(obj)) {
            processEnvArray(obj, relPath, confidence, bindings);
        }
        for (const item of obj) scanForEnvBlocks(item, relPath, confidence, bindings);
        return;
    }

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        // Structural detection: any array of {name, value} objects is treated as an env block.
        // This handles: env, envs, envs.plain, customEnvs, environment, and any Helm convention.
        if (Array.isArray(val) && isNameValueArray(val)) {
            processEnvArray(val, relPath, confidence, bindings);
        }

        // Also handle Docker Compose environment as object { KEY: VALUE }
        if (key === 'environment' && val && typeof val === 'object' && !Array.isArray(val)) {
            for (const [envName, envVal] of Object.entries(val as Record<string, unknown>)) {
                if (typeof envVal !== 'string') continue;
                if (isTemplateValue(envVal)) continue;

                const existing = bindings.get(envName.toUpperCase());
                if (!existing || existing.confidence < confidence) {
                    bindings.set(envName.toUpperCase(), { value: envVal, sourceFile: relPath, confidence });
                }
            }
        }

        // Recurse into nested objects
        if (val && typeof val === 'object') {
            scanForEnvBlocks(val, relPath, confidence, bindings);
        }
    }
}

/**
 * Extract all leaf string values from a YAML object tree.
 * Used for Helm base values files where config is nested.
 *
 * Example: global.messageBus.topics.save.topicId = "Order-Save"
 * produces key: GLOBAL.MESSAGEBUS.TOPICS.SAVE.TOPICID -> Order-Save
 *
 * These dot-path keys are stored alongside env-block entries in the same flat dict,
 * enabling camelCase to SCREAMING_SNAKE resolution in the graph-writer.
 */
function extractYamlLeafBindings(parsed: unknown, relPath: string, confidence: number): Map<string, EnvVarBinding> {
    const bindings = new Map<string, EnvVarBinding>();
    if (!parsed || typeof parsed !== 'object') return bindings;

    walkYamlLeaves(parsed, [], relPath, confidence, bindings);
    return bindings;
}

function walkYamlLeaves(
    obj: unknown,
    pathParts: string[],
    relPath: string,
    confidence: number,
    bindings: Map<string, EnvVarBinding>,
): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) return; // skip arrays for leaf extraction

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        const currentPath = [...pathParts, key];

        if (typeof val === 'string') {
            // Skip template / empty values
            if (isTemplateValue(val)) continue;

            // Store with dot-path key in SCREAMING_SNAKE
            const dotPathKey = currentPath.map(p => p.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()).join('.');
            const existing = bindings.get(dotPathKey);
            if (!existing || existing.confidence < confidence) {
                bindings.set(dotPathKey, { value: val, sourceFile: relPath, confidence });
            }
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            walkYamlLeaves(val, currentPath, relPath, confidence, bindings);
        }
    }
}

// ─── Helm Template Resolution ────────────────────────────────────────────────

/**
 * Extract the YAML dot-path from a Helm Go template expression.
 * Supports both $.Values.X.Y and .Values.X.Y syntax.
 *
 * Examples:
 *   '{{ $.Values.global.topics.save.topicId }}'  → 'global.topics.save.topicId'
 *   '{{ .Values.db.host }}'                       → 'db.host'
 *   '{{ $.Values.foo | quote }}'                   → 'foo'
 */
function extractHelmValuesPath(templateExpr: string): string | null {
    const match = templateExpr.match(/\{\{\s*\$?\.Values\.([\w.]+)/);
    if (!match) return null;
    return match[1];
}

/**
 * Convert a Helm YAML dot-path to the SCREAMING_SNAKE dot-path format
 * used by walkYamlLeaves.
 *
 * Example: 'global.topics.save.topicId' → 'GLOBAL.TOPICS.SAVE.TOPIC_ID'
 */
function helmPathToLeafKey(dotPath: string): string {
    return dotPath
        .split('.')
        .map(segment => segment.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase())
        .join('.');
}

/**
 * Scan parsed YAML for env-block entries with Go template values,
 * returning { envVarName → helmValuesPath } pairs.
 *
 * This is the counterpart to scanForEnvBlocks which *skips* template values.
 * Here we specifically *collect* them for post-resolution.
 */
function collectUnresolvedTemplateEntries(
    obj: unknown,
    result: Map<string, string>,
): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        // Check if this array is an env block
        if (isNameValueArray(obj)) {
            processTemplateArray(obj, result);
        }
        for (const item of obj) collectUnresolvedTemplateEntries(item, result);
        return;
    }

    for (const [, val] of Object.entries(obj as Record<string, unknown>)) {
        // Structural detection: any array of {name, value} objects
        if (Array.isArray(val) && isNameValueArray(val)) {
            processTemplateArray(val, result);
        }

        // Recurse into nested objects
        if (val && typeof val === 'object') {
            collectUnresolvedTemplateEntries(val, result);
        }
    }
}

// ─── Env Var Dictionary — Public API ─────────────────────────────────────────

/**
 * Scan a repository for deployment config files (Helm values, Docker Compose,
 * K8s ConfigMaps) and extract a flat dictionary of env var name → literal value.
 *
 * The dictionary merges ALL charts/services into a single repo-wide map.
 * On key collision, the entry with the highest confidence score wins.
 *
 * Called ONCE per repo (results memoized via loadRepoContext()).
 *
 * @param repoPath  Absolute path to the repository root
 * @returns Map<string, EnvVarBinding> with UPPER_CASE env var names as keys
 */
export function extractEnvVarDictionary(repoPath: string): Map<string, EnvVarBinding> {
    const allBindings = new Map<string, EnvVarBinding>();

    // Collect unresolved Helm template entries for post-resolution
    const unresolvedTemplates = new Map<string, { helmPath: string; sourceFile: string; confidence: number }>();

    // Collect all candidate files
    const candidateFiles: string[] = [];

    // Static patterns
    for (const pattern of ENV_VAR_GLOB_PATTERNS) {
        const absPath = path.join(repoPath, pattern);
        if (fs.existsSync(absPath)) {
            candidateFiles.push(absPath);
        }
    }

    // Dynamic glob patterns (.charts/*/values.yaml, etc.)
    for (const glob of ENV_VAR_DYNAMIC_GLOBS) {
        candidateFiles.push(...expandSimpleGlob(repoPath, glob));
    }

    // Deduplicate (a file could match both static and dynamic patterns)
    const seen = new Set<string>();
    for (const absPath of candidateFiles) {
        const resolved = path.resolve(absPath);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        try {
            const stats = fs.statSync(absPath);
            if (stats.size > 512 * 1024) continue; // skip large files

            const content = fs.readFileSync(absPath, 'utf-8');
            const parsed = yaml.load(content);
            const relPath = path.relative(repoPath, absPath);
            const confidence = envVarConfidenceForFile(relPath);

            // Extract from env: blocks (Helm deployment templates, docker-compose)
            const envBlockBindings = extractEnvBlockBindings(parsed, relPath, confidence);
            for (const [key, binding] of envBlockBindings) {
                const existing = allBindings.get(key);
                if (!existing || existing.confidence < binding.confidence) {
                    allBindings.set(key, binding);
                }
            }

            // Extract leaf string values from nested YAML (Helm base values)
            const leafBindings = extractYamlLeafBindings(parsed, relPath, confidence);
            for (const [key, binding] of leafBindings) {
                const existing = allBindings.get(key);
                if (!existing || existing.confidence < binding.confidence) {
                    allBindings.set(key, binding);
                }
            }

            // Collect unresolved Go template entries for post-resolution.
            // e.g. env: [{name: MY_TOPIC, value: '{{ $.Values.global.topics.save.topicId }}'}]
            const unresolved = new Map<string, string>();
            collectUnresolvedTemplateEntries(parsed, unresolved);
            for (const [envVarName, helmPath] of unresolved) {
                if (!unresolvedTemplates.has(envVarName)) {
                    unresolvedTemplates.set(envVarName, { helmPath, sourceFile: relPath, confidence });
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.debug(`[EnvVarDict] Failed to parse ${absPath}: ${errMsg}`);
        }
    }

    // ─── Helm Template Resolution Pass ──────────────────────────────────────
    // Resolve Go template env vars against leaf bindings.
    // e.g. MY_TOPIC={{ $.Values.global.topics.save.topicId }}
    //    → lookup GLOBAL.TOPICS.SAVE.TOPIC_ID in leaf bindings
    //    → resolve to the physical value from values.yaml
    let templatesResolved = 0;
    for (const [envVarName, { helmPath, sourceFile, confidence }] of unresolvedTemplates) {
        if (allBindings.has(envVarName)) continue; // already resolved directly

        const leafKey = helmPathToLeafKey(helmPath);
        const leafBinding = allBindings.get(leafKey);
        if (leafBinding) {
            allBindings.set(envVarName, {
                value: leafBinding.value,
                sourceFile,
                confidence: Math.min(confidence, leafBinding.confidence),
            });
            templatesResolved++;
            logger.debug(`[EnvVarDict] Helm template resolved: ${envVarName} → ${leafBinding.value} (via .Values.${helmPath})`);
        }
    }
    if (templatesResolved > 0) {
        logger.debug(`[EnvVarDict] Resolved ${templatesResolved} Helm template binding(s)`);
    }

    if (allBindings.size > 0) {
        const count = allBindings.size;
        logger.debug(`[EnvVarDict] Extracted ${count} env var binding(s) from ${repoPath}`);
        const topEntries = [...allBindings.entries()].slice(0, 10).map(([k, v]) => `${k}=${v.value} (${v.confidence})`).join(', ');
        logger.debug(`[EnvVarDict] Top entries: ${topEntries}`);
    }

    return allBindings;
}
