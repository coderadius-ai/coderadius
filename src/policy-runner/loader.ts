import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import yaml from 'js-yaml';
import { PolicyRuleSchema, type PolicyRule } from './types.js';
import { logger } from '../utils/logger.js';
import { EMBEDDED_PACKS } from './packs.generated.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Policy Loader
//
// Discovers and validates YAML policy rule files. Resolution order:
//   1. The path itself (file or directory)
//   2. Local override: .coderadius/policies/<name>
//   3. Built-in packs directory on disk (source / dev runs)
//   4. Embedded snapshot (compiled binary — packs.generated.ts)
//
// The embedded tier exists because `bun build --compile` does not ship the
// pack YAML files: import.meta.dir points into the $bunfs virtual filesystem.
// `bun run gen:packs` regenerates the snapshot; a drift-guard unit test pins
// it to the YAML source of truth.
//
// Supported file extensions: .yaml, .yml
// Files with parse/validation errors are skipped with a warning.
// ═══════════════════════════════════════════════════════════════════════════════

export interface LoadPoliciesOptions {
    /**
     * Path to a single YAML file, a directory of YAML files, or a built-in
     * pack name. When omitted, loads every built-in pack.
     */
    rulesPath?: string;
    /** If set, only load rules with this tag. */
    filterTag?: string;
    /** If set, only load rules with this level or higher. */
    minLevel?: 'note' | 'warning' | 'error';
}

const LEVEL_ORDER: Record<string, number> = { note: 0, warning: 1, error: 2 };

const BUILTIN_PACKS_DIR = path.join(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), 'packs');

export function getBuiltinPacksDir(): string { return BUILTIN_PACKS_DIR; }

/** Every built-in pack name: directories on disk plus the embedded snapshot. */
export function listBuiltinPackNames(): string[] {
    const names = new Set(Object.keys(EMBEDDED_PACKS));
    const stat = fs.statSync(BUILTIN_PACKS_DIR, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
        for (const entry of fs.readdirSync(BUILTIN_PACKS_DIR, { withFileTypes: true })) {
            if (entry.isDirectory()) names.add(entry.name);
        }
    }
    return [...names].sort();
}

/**
 * Read a built-in pack's rule files as `{ relativeFileName: yamlContent }`,
 * preferring the on-disk packs directory and falling back to the embedded
 * snapshot. Used by `cr policy export` so it also works in the compiled binary.
 */
export async function readBuiltinPackFiles(packName: string): Promise<Record<string, string>> {
    const packDir = path.join(BUILTIN_PACKS_DIR, packName);
    const stat = fs.statSync(packDir, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
        const files = await glob('**/*.{yaml,yml}', { cwd: packDir, nodir: true });
        const out: Record<string, string> = {};
        for (const file of files.sort()) {
            out[file] = fs.readFileSync(path.join(packDir, file), 'utf-8');
        }
        return out;
    }

    const embedded = EMBEDDED_PACKS[packName];
    if (embedded) return { ...embedded };

    throw new Error(`Pack "${packName}" not found. Available: ${listBuiltinPackNames().join(', ') || '(none)'}`);
}

// ─── Source resolution ──────────────────────────────────────────────────────

/** A loadable rule document; `read` defers I/O so per-file errors stay non-fatal. */
interface RuleSource {
    label: string;
    read: () => string;
}

function fileSource(filePath: string): RuleSource {
    return { label: filePath, read: () => fs.readFileSync(filePath, 'utf-8') };
}

function embeddedPackSources(packName: string): RuleSource[] {
    const files = EMBEDDED_PACKS[packName] ?? {};
    return Object.keys(files).sort().map(file => ({
        label: `${packName}/${file} (embedded)`,
        read: () => files[file]!,
    }));
}

async function directorySources(dir: string): Promise<RuleSource[]> {
    const filePaths = await glob('**/*.{yaml,yml}', { cwd: dir, absolute: true, nodir: true });
    if (filePaths.length === 0) {
        logger.warn(`[PolicyLoader] No YAML files found in: ${dir}`);
    }
    return filePaths.sort().map(fileSource);
}

function statKind(p: string): 'file' | 'dir' | undefined {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) return undefined;
    return stat.isFile() ? 'file' : 'dir';
}

async function sourcesFromPath(p: string): Promise<RuleSource[] | undefined> {
    const kind = statKind(p);
    if (kind === 'file') return [fileSource(p)];
    if (kind === 'dir') return directorySources(p);
    return undefined;
}

/** Walk the resolution tiers for an explicit rules path. */
async function collectExplicitSources(rulesPath: string): Promise<RuleSource[]> {
    const direct = await sourcesFromPath(path.resolve(rulesPath));
    if (direct) return direct;

    const userOverride = path.resolve('.coderadius', 'policies', rulesPath);
    const override = await sourcesFromPath(userOverride);
    if (override) {
        logger.debug(`[PolicyLoader] Using local override: ${userOverride}`);
        return override;
    }

    const builtin = await sourcesFromPath(path.join(BUILTIN_PACKS_DIR, rulesPath));
    if (builtin) {
        logger.debug(`[PolicyLoader] Using built-in pack: ${rulesPath}`);
        return builtin;
    }

    if (EMBEDDED_PACKS[rulesPath]) {
        logger.debug(`[PolicyLoader] Using embedded built-in pack: ${rulesPath}`);
        return embeddedPackSources(rulesPath);
    }

    throw new Error(`Rules path not found: ${path.resolve(rulesPath)}`);
}

/** Default (no path): every built-in pack, from disk or the embedded snapshot. */
async function collectDefaultSources(): Promise<RuleSource[]> {
    const onDisk = await sourcesFromPath(BUILTIN_PACKS_DIR);
    if (onDisk) return onDisk;

    logger.debug('[PolicyLoader] Packs directory unavailable, using embedded built-in packs');
    return Object.keys(EMBEDDED_PACKS).sort().flatMap(embeddedPackSources);
}

// ─── Parsing & validation ───────────────────────────────────────────────────

// Lightweight safety check: reject write clauses. This is a defense-in-depth
// guard, not a sandbox. The real sandbox is the read-only Memgraph user
// configured in sandbox.ts. Pattern is split into two alternatives:
//   1. Simple keywords surrounded by word boundaries (\b...\b)
//   2. SET [property] = which cannot use trailing \b (= is a non-word char)
//
// \b at start ensures we don't match partial words (e.g. 'RESET' would NOT match).
const WRITE_KEYWORDS = /\b(CREATE|MERGE|DELETE|REMOVE)\b|\bSET\s+[\w][\w.]*\s*=|\bDETACH\s+DELETE\b/i;

function parseRuleSource(source: RuleSource): PolicyRule | undefined {
    let raw: string;
    try {
        raw = source.read();
    } catch (err) {
        logger.warn(`[PolicyLoader] Cannot read ${source.label}: ${(err as Error).message}`);
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = yaml.load(raw);
    } catch (err) {
        logger.warn(`[PolicyLoader] YAML parse error in ${source.label}: ${(err as Error).message}`);
        return undefined;
    }

    const result = PolicyRuleSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        logger.warn(`[PolicyLoader] Invalid rule in ${path.basename(source.label)}: ${issues}`);
        return undefined;
    }

    if (WRITE_KEYWORDS.test(result.data.query)) {
        logger.warn(`[PolicyLoader] Rule "${result.data.id}" rejected: query contains write clause. Rules must be read-only.`);
        return undefined;
    }

    return result.data;
}

function passesFilters(rule: PolicyRule, options: LoadPoliciesOptions): boolean {
    if (options.filterTag && !rule.tags.includes(options.filterTag)) return false;
    if (options.minLevel !== undefined && LEVEL_ORDER[rule.level]! < LEVEL_ORDER[options.minLevel]!) return false;
    return true;
}

/**
 * Load and validate policy rules from a path or built-in pack name.
 * Returns only rules that pass schema validation.
 */
export async function loadPolicies(options: LoadPoliciesOptions): Promise<PolicyRule[]> {
    const sources = options.rulesPath !== undefined
        ? await collectExplicitSources(options.rulesPath)
        : await collectDefaultSources();

    const rules: PolicyRule[] = [];
    for (const source of sources) {
        const rule = parseRuleSource(source);
        if (!rule || !passesFilters(rule, options)) continue;
        rules.push(rule);
        logger.debug(`[PolicyLoader] Loaded rule: ${rule.id} (${rule.level}) — ${rule.name}`);
    }

    logger.debug(`[PolicyLoader] ${rules.length}/${sources.length} rules loaded`);
    return rules;
}
