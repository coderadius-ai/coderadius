import yaml from 'js-yaml';
import { buildUrn } from '../../../graph/urn.js';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Renovate Plugin — Extract governance signals from Renovate config files
//
// Produces a ToolConfig entity with key governance metadata:
//   - extends: base config (is it using the company standard?)
//   - automergeDefault: top-level automerge flag
//   - automergePatch / automergeMinor / automergeMajor: per-update-type signals
//   - automergeEffective: true if ANY update type can be auto-merged
//   - schedule: update frequency
//   - packageRulesCount: number of custom override rules
//
// WHY per-update-type granularity:
//   `automerge: false` at top-level + `automerge: true` for patch in packageRules
//   is a safe and common pattern. Reading only the top-level boolean produces
//   misleading governance signals — a repo with patch automerge looks "safe" but
//   our old model would flag it as fully disabled.
//
// Design: coexists with devtoolsPlugin on the same file.
//   devtoolsPlugin → creates StructuralFile (for gp-011 presence check)
//   renovatePlugin → creates ToolConfig (for richer future policy rules)
// ═══════════════════════════════════════════════════════════════════════════════

/** All filenames Renovate supports, in discovery priority order. */
const RENOVATE_BASENAMES = new Set([
    'renovate.json',
    'renovate.json5',
    '.renovaterc',
    '.renovaterc.json',
]);

/**
 * Renovate config can be in JSON (with optional comments) or YAML (.renovaterc).
 * We attempt JSON parse first (handles json5/jsonc comments by stripping them),
 * then fall back to YAML.
 */
function parseRenovateConfig(content: string): Record<string, unknown> | null {
    // Strip single-line comments for JSON5 / JSONC compatibility.
    // Use negative lookbehind to avoid stripping `://` in URLs.
    const stripped = content
        .replace(/(?<!:)\/\/.*$/gm, '')  // single-line comments, but not https://
        .replace(/\/\*[\s\S]*?\*\//g, '');  // block comments
    try {
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Fall through to YAML parser
    }
    try {
        const parsed = yaml.load(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Unparseable
    }
    return null;
}

/**
 * Normalise the `extends` field to a comma-separated string.
 * Renovate supports: string, string[], or absent.
 */
function normalizeExtends(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.map(String).join(',');
    return '';
}

/**
 * Normalise the `schedule` field.
 * Renovate supports: string or string[].
 */
function normalizeSchedule(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.map(String).join(',');
    return '';
}

/**
 * Scan `packageRules[]` to determine which update types have automerge
 * explicitly enabled or disabled.
 *
 * Returns a partial record: only update types with an explicit setting are
 * included. Absence = "inherits from automergeDefault".
 *
 * Renovation's `matchUpdateTypes` accepts an array of:
 *   major | minor | patch | pin | digest | lockFileMaintenance
 *
 * Example:
 *   { matchUpdateTypes: ["patch", "pin"], automerge: true }  → patch: true
 *   { matchUpdateTypes: ["major"], automerge: false }         → major: false
 */
function resolveAutomergePerType(
    packageRules: unknown[],
    defaultAutomerge: boolean,
): { patch: boolean; minor: boolean; major: boolean } {
    // Start from the top-level default and let packageRules override
    const result = { patch: defaultAutomerge, minor: defaultAutomerge, major: defaultAutomerge };

    for (const rule of packageRules) {
        if (typeof rule !== 'object' || rule === null) continue;
        const r = rule as Record<string, unknown>;

        // Only rules with an explicit automerge value are relevant
        if (typeof r.automerge !== 'boolean') continue;

        const types = Array.isArray(r.matchUpdateTypes)
            ? (r.matchUpdateTypes as string[])
            : [];

        if (types.includes('patch')) result.patch = r.automerge;
        if (types.includes('minor')) result.minor = r.automerge;
        if (types.includes('major')) result.major = r.automerge;
    }

    return result;
}

export const renovatePlugin: StructuralPlugin = {
    name: 'renovate',
    label: 'Renovate',
    managedLabels: ['ToolConfig'],

    matchFile(relativePath: string, basename: string): boolean {
        if (RENOVATE_BASENAMES.has(basename)) return true;
        if (relativePath === '.github/renovate.json') return true;
        return false;
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const parsed = parseRenovateConfig(content);

        if (!parsed) {
            return { entities: [], summary: 'parse error (unrecognized Renovate config format)' };
        }

        // ── Key governance signals ────────────────────────────────────────────

        // extends: base policy inheritance chain
        const extendsStr = normalizeExtends(parsed.extends);

        // schedule: how often Renovate runs
        const schedule = normalizeSchedule(parsed.schedule);

        // packageRules: raw array (may be undefined)
        const packageRules = Array.isArray(parsed.packageRules) ? parsed.packageRules : [];
        const packageRulesCount = packageRules.length;

        // ── Automerge: top-level default + per-update-type resolution ─────────
        //
        // Common safe pattern:
        //   automerge: false (default)  +  packageRules[patch].automerge: true
        // A flat boolean would misreport this as "automerge disabled".

        const automergeDefault = typeof parsed.automerge === 'boolean' ? parsed.automerge : false;
        const { patch: automergePatch, minor: automergeMinor, major: automergeMajor } =
            resolveAutomergePerType(packageRules, automergeDefault);

        // Effective signal: true if ANY update type is set to auto-merge.
        // This is the primary governance flag for policy rules.
        const automergeEffective = automergePatch || automergeMinor || automergeMajor;

        // ── Derived governance flags ──────────────────────────────────────────

        const hasSharedBaseConfig = extendsStr.includes('config:');

        const entity = {
            id: buildUrn('toolconfig', 'renovate', context.repoName, context.relativePath),
            labels: ['ToolConfig'],
            properties: {
                name: context.relativePath,
                tool: 'renovate',
                // Governance signals
                extends: extendsStr,
                hasSharedBaseConfig,
                schedule,
                packageRulesCount,
                // Automerge (granular)
                automergeDefault,
                automergePatch,
                automergeMinor,
                automergeMajor,
                automergeEffective,
                // Metadata
                filePath: context.relativePath,
                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        };

        const automergeDesc = [
            automergePatch ? 'patch' : '',
            automergeMinor ? 'minor' : '',
            automergeMajor ? 'major' : '',
        ].filter(Boolean).join('+') || 'none';

        return {
            entities: [entity],
            summary: `[Renovate] extends: ${extendsStr || '(none)'} | automerge: ${automergeDesc} | schedule: ${schedule || '(default)'}`,
        };
    },
};
