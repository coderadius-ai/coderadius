/**
 * coderadius.yaml validation: strict schema check + semantic dry-run.
 *
 * Pure logic behind `cr validate` — no CLI, no graph, unit-testable.
 * Two layers, both stricter than the runtime loader (which silently
 * degrades to defaults so ingestion never fails on a bad file):
 *
 *  1. STRICT schema: RepoHintsStrictSchema surfaces section-name typos as
 *     unrecognized-keys errors and type/enum violations anywhere.
 *  2. SEMANTIC dry-run against the repo: a section that parses but matches
 *     nothing in the codebase is almost always a mistake — declared
 *     decorators with zero source occurrences, packages absent from every
 *     manifest, env accessors with zero call sites.
 *
 * Harvested default VALUES are masked in the report: they can carry
 * credentials and internal hostnames; the report only proves they exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
    RepoHintsStrictSchema,
    RepoHintsSchema,
    getEnvAccessors,
    type RepoHints,
} from './repo-hints.js';
import { walkScannableFiles } from '../ingestion/processors/connection-extractors/code-env-scanner.js';
import { scanCodeAccessorEnvVars } from '../ingestion/processors/connection-extractors/env-accessor-scanner.js';

export interface ValidationIssue {
    severity: 'error' | 'warning';
    section: string;
    message: string;
}

export interface SemanticFinding {
    section: string;
    subject: string;
    status: 'ok' | 'no-match' | 'not-found';
    detail: string;
}

export interface HintsValidationReport {
    /** Resolved coderadius.yaml path, or null when no file exists. */
    file: string | null;
    schemaValid: boolean;
    issues: ValidationIssue[];
    semantics: SemanticFinding[];
}

const HINTS_FILENAMES = ['coderadius.yaml', 'coderadius.yml'];

export function maskValue(value: string): string {
    if (value.length <= 4) return '***';
    return `${value[0]}***${value[value.length - 1]}`;
}

function findHintsFile(repoRoot: string): string | null {
    for (const name of HINTS_FILENAMES) {
        const p = path.join(repoRoot, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function schemaIssues(parsed: unknown): ValidationIssue[] {
    const result = RepoHintsStrictSchema.safeParse(parsed);
    if (result.success) return [];
    return result.error.issues.map((issue) => ({
        severity: 'error' as const,
        section: String(issue.path[0] ?? '(root)'),
        message: issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
    }));
}

/** Count source occurrences of each decorator name in one shared walk. */
function decoratorFindings(repoRoot: string, hints: RepoHints): SemanticFinding[] {
    if (hints.decorators.length === 0) return [];
    const counts = new Map<string, number>(hints.decorators.map((d) => [d.name, 0]));
    for (const { abs, content } of walkScannableFiles(repoRoot)) {
        // The declaration itself is not a source reference.
        if (HINTS_FILENAMES.includes(path.basename(abs))) continue;
        for (const [name, n] of counts) {
            if (content.includes(name)) counts.set(name, n + 1);
        }
    }
    return hints.decorators.map((d) => {
        const files = counts.get(d.name) ?? 0;
        return {
            section: 'decorators',
            subject: d.name,
            status: files > 0 ? 'ok' as const : 'no-match' as const,
            detail: files > 0 ? `${files} file(s) reference it` : 'no source file references this name',
        };
    });
}

function readManifestBlobs(repoRoot: string): string[] {
    const manifests = ['package.json', 'composer.json', 'package-lock.json', 'composer.lock', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml'];
    const blobs: string[] = [];
    for (const m of manifests) {
        const p = path.join(repoRoot, m);
        try { blobs.push(fs.readFileSync(p, 'utf8')); } catch { /* absent */ }
    }
    return blobs;
}

function packageFindings(repoRoot: string, hints: RepoHints): SemanticFinding[] {
    const entries = hints.packages?.analyze ?? [];
    if (entries.length === 0) return [];
    const blobs = readManifestBlobs(repoRoot);
    return entries.map((e) => {
        const name = typeof e === 'string' ? e : e.name;
        const found = blobs.some((b) => b.includes(`"${name}"`));
        return {
            section: 'packages.analyze',
            subject: name,
            status: found ? 'ok' as const : 'not-found' as const,
            detail: found ? 'present in a root manifest/lockfile' : 'not found in package.json/composer.json/lockfiles',
        };
    });
}

function accessorFindings(repoRoot: string, hints: RepoHints): SemanticFinding[] {
    const accessors = getEnvAccessors(hints);
    if (accessors.length === 0) return [];
    return accessors.map((a) => {
        const res = scanCodeAccessorEnvVars(repoRoot, [a]);
        const sample = res.defaults.slice(0, 3)
            .map((d) => `${d.key}=${maskValue(d.value)}`)
            .join(', ');
        return {
            section: 'envAccessors',
            subject: a.callee,
            status: res.keys.size > 0 ? 'ok' as const : 'no-match' as const,
            detail: res.keys.size > 0
                ? `${res.keys.size} key(s), ${res.defaults.length} literal default(s)${sample ? ` [${sample}]` : ''}`
                : 'no call site found for this accessor',
        };
    });
}

export function validateRepoHints(repoRoot: string): HintsValidationReport {
    const file = findHintsFile(repoRoot);
    if (!file) {
        return {
            file: null,
            schemaValid: true,
            issues: [{
                severity: 'warning',
                section: '(file)',
                message: 'no coderadius.yaml found in the repo root — nothing to validate',
            }],
            semantics: [],
        };
    }

    let parsed: unknown;
    try {
        parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return {
            file,
            schemaValid: false,
            issues: [{ severity: 'error', section: '(yaml)', message: `YAML parse error: ${(e as Error).message}` }],
            semantics: [],
        };
    }

    const errors = schemaIssues(parsed ?? {});
    const issues: ValidationIssue[] = [...errors];

    // Semantic dry-run runs on the LENIENT parse (mirrors what ingestion
    // will actually consume), even when the strict pass found errors.
    const lenient = RepoHintsSchema.safeParse(parsed ?? {});
    const semantics: SemanticFinding[] = [];
    if (lenient.success) {
        semantics.push(
            ...decoratorFindings(repoRoot, lenient.data),
            ...packageFindings(repoRoot, lenient.data),
            ...accessorFindings(repoRoot, lenient.data),
        );
        for (const s of semantics) {
            if (s.status === 'ok') continue;
            issues.push({
                severity: 'warning',
                section: s.section,
                message: `${s.subject}: ${s.detail}`,
            });
        }
    }

    return { file, schemaValid: errors.length === 0, issues, semantics };
}
