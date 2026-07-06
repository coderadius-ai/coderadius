import { describe, test, expect } from 'vitest';
import { renovatePlugin } from '../../../src/ingestion/structural/plugins/renovate.plugin.js';
import type { PluginContext } from '../../../src/ingestion/structural/types.js';
import fs from 'node:fs';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        relativePath: 'renovate.json',
        absolutePath: '/repo/renovate.json',
        basename: 'renovate.json',
        repoName: 'acme/order-service',
        ownerService: 'order-service',
        ...overrides,
    };
}

function extract(content: string, ctxOverrides: Partial<PluginContext> = {}) {
    const result = renovatePlugin.extract(content, makeCtx(ctxOverrides));
    return {
        result,
        entity: result.entities[0],
        props: result.entities[0]?.properties,
    };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RECOMMENDED_CONFIG = JSON.stringify({
    $schema: 'https://docs.renovatebot.com/renovate-schema.json',
    extends: ['config:recommended'],
    schedule: ['before 6am on monday'],
    automerge: false,
    labels: ['dependencies'],
});

const AUTOMERGE_ALL_CONFIG = JSON.stringify({
    extends: ['config:base'],
    automerge: true,
    schedule: ['at any time'],
    packageRules: [
        { matchDepTypes: ['devDependencies'], automerge: true },
        { matchPackageNames: ['lodash'], allowedVersions: '4.x' },
    ],
});

const PATCH_AUTOMERGE_CONFIG = JSON.stringify({
    extends: ['config:recommended'],
    automerge: false,
    packageRules: [
        { matchUpdateTypes: ['patch', 'pin', 'digest'], automerge: true },
    ],
});

const MAJOR_BLOCKED_CONFIG = JSON.stringify({
    automerge: true,
    packageRules: [
        { matchUpdateTypes: ['major'], automerge: false },
    ],
});

const SHARED_CONFIG = JSON.stringify({
    extends: ['local>myorg/.github//renovate-config', 'config:recommended'],
    automerge: false,
});

const RENOVATERC_YAML = `
extends:
  - config:recommended
schedule:
  - before 6am on monday
automerge: false
`;

const JSON5_WITH_COMMENTS = `
{
  // Schema validation
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  /* Multi-line comment */
  "automerge": false
}
`;

const MINIMAL = JSON.stringify({ extends: ['config:recommended'] });

// ═══════════════════════════════════════════════════════════════════════════════
// matchFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.matchFile', () => {
    test('matches renovate.json', () => {
        expect(renovatePlugin.matchFile('renovate.json', 'renovate.json')).toBe(true);
    });

    test('matches renovate.json5', () => {
        expect(renovatePlugin.matchFile('renovate.json5', 'renovate.json5')).toBe(true);
    });

    test('matches .renovaterc', () => {
        expect(renovatePlugin.matchFile('.renovaterc', '.renovaterc')).toBe(true);
    });

    test('matches .renovaterc.json', () => {
        expect(renovatePlugin.matchFile('.renovaterc.json', '.renovaterc.json')).toBe(true);
    });

    test('matches .github/renovate.json via relativePath', () => {
        expect(renovatePlugin.matchFile('.github/renovate.json', 'renovate.json')).toBe(true);
    });

    test('does NOT match renovate.yaml', () => {
        expect(renovatePlugin.matchFile('renovate.yaml', 'renovate.yaml')).toBe(false);
    });

    test('does NOT match package.json', () => {
        expect(renovatePlugin.matchFile('package.json', 'package.json')).toBe(false);
    });

    test('does NOT match tsconfig.json', () => {
        expect(renovatePlugin.matchFile('tsconfig.json', 'tsconfig.json')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — basic invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — basic invariants', () => {
    test('produces exactly one ToolConfig entity', () => {
        const { result } = extract(RECOMMENDED_CONFIG);
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0]!.labels).toContain('ToolConfig');
    });

    test('managedLabels contains ToolConfig', () => {
        expect(renovatePlugin.managedLabels).toContain('ToolConfig');
    });

    test('entity relationshipType is DEFINES', () => {
        const { entity } = extract(RECOMMENDED_CONFIG);
        expect(entity!.relationshipType).toBe('DEFINES');
    });

    test('URN follows cr:toolconfig:renovate:{repoName}:{filePath} schema', () => {
        const { entity } = extract(RECOMMENDED_CONFIG);
        expect(entity!.id).toBe('cr:toolconfig:renovate:acme/order-service:renovate.json');
    });

    test('tool property is always renovate', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['tool']).toBe('renovate');
    });

    test('_sourcePath matches relativePath', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['_sourcePath']).toBe('renovate.json');
    });

    test('_ownerService is propagated from context', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['_ownerService']).toBe('order-service');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — extends
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — extends', () => {
    test('normalizes string array extends to comma-separated string', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['extends']).toBe('config:recommended');
    });

    test('normalizes scalar string extends', () => {
        const content = JSON.stringify({ extends: 'config:recommended' });
        const { props } = extract(content);
        expect(props!['extends']).toBe('config:recommended');
    });

    test('joins multiple extends with comma', () => {
        const { props } = extract(SHARED_CONFIG);
        const ext = props!['extends'] as string;
        expect(ext).toContain('local>myorg/.github//renovate-config');
        expect(ext).toContain('config:recommended');
    });

    test('returns empty string when extends is absent', () => {
        const content = JSON.stringify({ automerge: false });
        const { props } = extract(content);
        expect(props!['extends']).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — automerge (granular model)
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — automerge (granular model)', () => {

    test('automergeDefault reflects top-level automerge: false', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['automergeDefault']).toBe(false);
    });

    test('automergeDefault reflects top-level automerge: true', () => {
        const { props } = extract(AUTOMERGE_ALL_CONFIG);
        expect(props!['automergeDefault']).toBe(true);
    });

    test('automergeDefault is false when automerge is absent (Renovate default)', () => {
        const { props } = extract(MINIMAL);
        expect(props!['automergeDefault']).toBe(false);
    });

    // ── Safe pattern: default=false, patch=true via packageRules ──────────────
    test('safe pattern: default=false, patch+pin+digest=true via packageRules', () => {
        const { props } = extract(PATCH_AUTOMERGE_CONFIG);
        expect(props!['automergeDefault']).toBe(false);
        expect(props!['automergePatch']).toBe(true);
        expect(props!['automergeMinor']).toBe(false);
        expect(props!['automergeMajor']).toBe(false);
        expect(props!['automergeEffective']).toBe(true); // patch is enabled
    });

    // ── Minor automerge for devDeps only ──────────────────────────────────────
    test('minor automerge for devDependencies (matchUpdateTypes: [minor])', () => {
        const config = JSON.stringify({
            extends: ['config:recommended'],
            automerge: false,
            packageRules: [
                { matchDepTypes: ['devDependencies'], matchUpdateTypes: ['minor'], automerge: true },
            ],
        });
        const { props } = extract(config);
        expect(props!['automergeMinor']).toBe(true);
        expect(props!['automergeMajor']).toBe(false);
        expect(props!['automergeEffective']).toBe(true);
    });

    // ── Global true with major explicitly blocked ──────────────────────────────
    test('global automerge: true with major explicitly blocked in packageRules', () => {
        const { props } = extract(MAJOR_BLOCKED_CONFIG);
        expect(props!['automergeDefault']).toBe(true);
        expect(props!['automergePatch']).toBe(true);   // inherits default
        expect(props!['automergeMinor']).toBe(true);   // inherits default
        expect(props!['automergeMajor']).toBe(false);  // overridden by rule
        expect(props!['automergeEffective']).toBe(true); // patch+minor still enabled
    });

    // ── All disabled ──────────────────────────────────────────────────────────
    test('all disabled: automerge false, no packageRule overrides', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['automergePatch']).toBe(false);
        expect(props!['automergeMinor']).toBe(false);
        expect(props!['automergeMajor']).toBe(false);
        expect(props!['automergeEffective']).toBe(false);
    });

    // ── All enabled ───────────────────────────────────────────────────────────
    test('all enabled: top-level automerge: true, no overrides', () => {
        const config = JSON.stringify({ automerge: true });
        const { props } = extract(config);
        expect(props!['automergePatch']).toBe(true);
        expect(props!['automergeMinor']).toBe(true);
        expect(props!['automergeMajor']).toBe(true);
        expect(props!['automergeEffective']).toBe(true);
    });

    // ── packageRules without matchUpdateTypes have no effect ──────────────────
    test('packageRules without matchUpdateTypes do not change per-type flags', () => {
        const config = JSON.stringify({
            automerge: false,
            packageRules: [
                // Rule without matchUpdateTypes — automerge: true applies globally
                // but our extractor only tracks explicitly-typed rules
                { matchDepTypes: ['devDependencies'], automerge: true },
            ],
        });
        const { props } = extract(config);
        expect(props!['automergePatch']).toBe(false);
        expect(props!['automergeMinor']).toBe(false);
        expect(props!['automergeMajor']).toBe(false);
        expect(props!['automergeEffective']).toBe(false);
    });

    // ── Summary format ────────────────────────────────────────────────────────
    test('summary describes automerge types by name (patch), not boolean', () => {
        const { result } = extract(PATCH_AUTOMERGE_CONFIG);
        expect(result.summary).toContain('patch');
        expect(result.summary).not.toContain('true');
    });

    test('summary shows "none" when all automerge disabled', () => {
        const { result } = extract(RECOMMENDED_CONFIG);
        expect(result.summary).toContain('none');
    });

    test('summary shows patch+minor when both enabled', () => {
        const config = JSON.stringify({
            automerge: false,
            packageRules: [
                { matchUpdateTypes: ['patch', 'minor'], automerge: true },
            ],
        });
        const { result } = extract(config);
        expect(result.summary).toContain('patch');
        expect(result.summary).toContain('minor');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — schedule
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — schedule', () => {
    test('normalizes string array schedule', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['schedule']).toBe('before 6am on monday');
    });

    test('normalizes scalar string schedule', () => {
        const content = JSON.stringify({ extends: ['config:recommended'], schedule: 'at any time' });
        const { props } = extract(content);
        expect(props!['schedule']).toBe('at any time');
    });

    test('returns empty string when schedule is absent', () => {
        const { props } = extract(MINIMAL);
        expect(props!['schedule']).toBe('');
    });

    test('joins multiple schedule entries with comma', () => {
        const content = JSON.stringify({
            extends: ['config:recommended'],
            schedule: ['before 6am on monday', 'on friday'],
        });
        const { props } = extract(content);
        expect(props!['schedule']).toContain('before 6am on monday');
        expect(props!['schedule']).toContain('on friday');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — packageRulesCount
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — packageRulesCount', () => {
    test('counts packageRules entries', () => {
        const { props } = extract(AUTOMERGE_ALL_CONFIG);
        expect(props!['packageRulesCount']).toBe(2);
    });

    test('is zero when packageRules is absent', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['packageRulesCount']).toBe(0);
    });

    test('is zero when packageRules is an empty array', () => {
        const content = JSON.stringify({ extends: ['config:recommended'], packageRules: [] });
        const { props } = extract(content);
        expect(props!['packageRulesCount']).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — hasSharedBaseConfig
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — hasSharedBaseConfig', () => {
    test('is true when extends contains config: prefix', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['hasSharedBaseConfig']).toBe(true);
    });

    test('is true for config:base', () => {
        const { props } = extract(AUTOMERGE_ALL_CONFIG);
        expect(props!['hasSharedBaseConfig']).toBe(true);
    });

    test('is false when extends is absent', () => {
        const content = JSON.stringify({ automerge: false });
        const { props } = extract(content);
        expect(props!['hasSharedBaseConfig']).toBe(false);
    });

    test('is false when extends only has local> refs without config:', () => {
        const content = JSON.stringify({ extends: ['local>myorg/renovate-config'] });
        const { props } = extract(content);
        expect(props!['hasSharedBaseConfig']).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — multi-format parser
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — multi-format parser', () => {
    test('parses standard JSON', () => {
        const { props } = extract(RECOMMENDED_CONFIG);
        expect(props!['extends']).toBe('config:recommended');
    });

    test('parses JSON5 with single-line comments (not stripping URLs)', () => {
        const { props } = extract(JSON5_WITH_COMMENTS);
        expect(props!['extends']).toBe('config:recommended');
        expect(props!['automergeDefault']).toBe(false);
    });

    test('parses JSON with multi-line block comments (JSONC)', () => {
        const content = `{
  /* organization config */
  "extends": ["config:recommended"],
  "automerge": true
}`;
        const { props } = extract(content);
        expect(props!['extends']).toBe('config:recommended');
        expect(props!['automergeDefault']).toBe(true);
    });

    test('parses YAML format (.renovaterc)', () => {
        const { props } = extract(RENOVATERC_YAML, {
            relativePath: '.renovaterc',
            basename: '.renovaterc',
        });
        expect(props!['extends']).toBe('config:recommended');
        expect(props!['automergeDefault']).toBe(false);
        expect(props!['schedule']).toBe('before 6am on monday');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extract — error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('renovatePlugin.extract — error handling', () => {
    test('returns empty entities for completely malformed content', () => {
        const { result } = extract('not json or yaml {{{{');
        expect(result.entities).toHaveLength(0);
        expect(result.summary).toContain('parse error');
    });

    test('returns empty entities for empty file', () => {
        const { result } = extract('');
        expect(result.entities).toHaveLength(0);
    });

    test('returns empty entities when root is a JSON array', () => {
        const { result } = extract('["config:recommended"]');
        expect(result.entities).toHaveLength(0);
    });

    test('summary contains extends and automerge info on success', () => {
        const { result } = extract(RECOMMENDED_CONFIG);
        expect(result.summary).toContain('config:recommended');
        expect(result.summary).toContain('automerge');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fixture: order-service
// ═══════════════════════════════════════════════════════════════════════════════

const ORDER_RENOVATE_PATH = path.resolve(
    import.meta.dirname,
    '../../../tests/fixtures/microservices/order-service/renovate.json',
);
const ORDER_RENOVATE_CONTENT = fs.readFileSync(ORDER_RENOVATE_PATH, 'utf-8');
const ORDER_RENOVATE_PROPS = extract(ORDER_RENOVATE_CONTENT, { repoName: 'order/order-service' }).props;

describe('renovatePlugin — order-service fixture', () => {
    test('uses shared base config (config:recommended)', () => {
        expect(ORDER_RENOVATE_PROPS!['hasSharedBaseConfig']).toBe(true);
    });

    test('automergeDefault is false (safe default)', () => {
        expect(ORDER_RENOVATE_PROPS!['automergeDefault']).toBe(false);
    });

    test('automergeEffective is false (no packageRule overrides)', () => {
        expect(ORDER_RENOVATE_PROPS!['automergeEffective']).toBe(false);
    });

    test('has schedule configured', () => {
        expect(ORDER_RENOVATE_PROPS!['schedule']).not.toBe('');
    });
});
