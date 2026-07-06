import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Policy Loader Tests
//
// Strategy: we test the loader by mocking its I/O dependencies (glob + fs)
// WITHOUT mocking 'node:fs' at the module level (which causes Zod v4 ESM
// circular issues when vitest hoists the mock and intercepts the module graph).
//
// Instead we mock the loader's internal dependencies by spy-patching after
// importing, or we test purely through the public API with real (in-memory)
// fixtures written to actual temp files if needed.
//
// For simplicity: we use vi.mock on 'glob' only (safe), and for 'node:fs'
// we use vi.spyOn on the fs module after import to avoid hoisting issues.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('glob', () => ({
    glob: vi.fn(),
}));

import fs from 'node:fs';
import { glob } from 'glob';
import { loadPolicies, getBuiltinPacksDir } from '../../../src/policy-runner/loader.js';

const mockGlob = vi.mocked(glob);

// ─── Valid rule fixtures ──────────────────────────────────────────────────────

const VALID_RULE_YAML = `
id: gp-001-makefile-targets
name: Makefile mandatory targets
description: Repos must have setup, test, run targets
level: error
scope: repository
failFast: false
tags:
  - golden-path
query: |
  MATCH (r:Repository)-[:HAS_TASK]->(t:Task)
  WHERE t.source = 'makefile'
  RETURN r.id AS entityId, r.name AS entityName, 'repository' AS entityType, 'Missing targets' AS detail
`;

const WARNING_RULE_YAML = `
id: gp-004-team-ownership
name: Team ownership
level: warning
scope: service
query: |
  MATCH (s:Service) RETURN s.id AS entityId, s.name AS entityName, 'service' AS entityType, 'No owner' AS detail
`;

// ─── Setup helpers ────────────────────────────────────────────────────────────

let statSyncSpy: ReturnType<typeof vi.spyOn>;
let readFileSyncSpy: ReturnType<typeof vi.spyOn>;

function setupSingleFile(content: string) {
    statSyncSpy.mockReturnValue({ isFile: () => true, isDirectory: () => false } as ReturnType<typeof fs.statSync>);
    readFileSyncSpy.mockReturnValue(content as unknown as ReturnType<typeof fs.readFileSync>);
}

function setupDirectory(files: Record<string, string>) {
    statSyncSpy.mockReturnValue({ isFile: () => false, isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    const paths = Object.keys(files).map(f => `/rules/${f}`);
    mockGlob.mockResolvedValue(paths as Awaited<ReturnType<typeof glob>>);
    readFileSyncSpy.mockImplementation((p: unknown) => {
        const key = Object.keys(files).find(f => (p as string).includes(f));
        if (key) return files[key] as unknown as ReturnType<typeof fs.readFileSync>;
        throw new Error(`ENOENT: ${p}`);
    });
}

beforeEach(() => {
    statSyncSpy = vi.spyOn(fs, 'statSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Single file loading
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadPolicies — single YAML file', () => {
    test('loads a valid rule from a single file', async () => {
        setupSingleFile(VALID_RULE_YAML);
        const rules = await loadPolicies({ rulesPath: '/rules/gp-001.yaml' });
        expect(rules).toHaveLength(1);
        expect(rules[0]!.id).toBe('gp-001-makefile-targets');
        expect(rules[0]!.level).toBe('error');
        expect(rules[0]!.scope).toBe('repository');
        expect(rules[0]!.failFast).toBe(false);
    });

    test('rule tags default to empty array', async () => {
        setupSingleFile(WARNING_RULE_YAML);
        const rules = await loadPolicies({ rulesPath: '/rules/gp-004.yaml' });
        expect(rules[0]!.tags).toEqual([]);
    });

    test('throws when path does not exist', async () => {
        statSyncSpy.mockReturnValue(undefined as unknown as ReturnType<typeof fs.statSync>);
        await expect(loadPolicies({ rulesPath: '/nonexistent/path' })).rejects.toThrow('Rules path not found');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Directory loading
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadPolicies — directory', () => {
    test('loads multiple valid rules from directory', async () => {
        setupDirectory({
            'gp-001.yaml': VALID_RULE_YAML,
            'gp-004.yaml': WARNING_RULE_YAML,
        });
        const rules = await loadPolicies({ rulesPath: '/rules' });
        expect(rules).toHaveLength(2);
    });

    test('returns empty array when directory has no YAML files', async () => {
        statSyncSpy.mockReturnValue({ isFile: () => false, isDirectory: () => true } as ReturnType<typeof fs.statSync>);
        mockGlob.mockResolvedValue([]);
        const rules = await loadPolicies({ rulesPath: '/empty-dir' });
        expect(rules).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Default: built-in packs
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadPolicies — default to built-in packs', () => {
    test('with no rulesPath, loads from the built-in packs directory', async () => {
        statSyncSpy.mockReturnValue({ isFile: () => false, isDirectory: () => true } as ReturnType<typeof fs.statSync>);
        mockGlob.mockResolvedValue([] as Awaited<ReturnType<typeof glob>>);
        await loadPolicies({});
        expect(mockGlob).toHaveBeenCalledTimes(1);
        const globOpts = mockGlob.mock.calls[0]![1] as { cwd: string };
        expect(globOpts.cwd).toBe(getBuiltinPacksDir());
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Write-clause guard (defense-in-depth)
// ═══════════════════════════════════════════════════════════════════════════════

describe('write-clause guard', () => {
    const withQuery = (query: string) => `
id: bad-rule
name: Bad rule
level: error
scope: repository
query: |
  ${query}
`;

    const WRITE_QUERIES: [string, string][] = [
        ['CREATE clause', 'CREATE (n:Node {id: "test"}) RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
        ['MERGE clause', 'MERGE (n:Node {id: "test"}) RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
        ['DELETE clause', 'MATCH (n) DELETE n RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
        ['DETACH DELETE clause', 'MATCH (n) DETACH DELETE n RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
        ['SET assignment', 'MATCH (n) SET n.foo = "bar" RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
        ['REMOVE clause', 'MATCH (n) REMOVE n.foo RETURN n.id AS entityId, n.name AS entityName, "t" AS entityType, "d" AS detail'],
    ];

    for (const [name, query] of WRITE_QUERIES) {
        test(`rejects rule with ${name}`, async () => {
            setupSingleFile(withQuery(query));
            const rules = await loadPolicies({ rulesPath: '/any.yaml' });
            expect(rules).toHaveLength(0);
        });
    }

    test('valid MATCH+RETURN query passes the guard', async () => {
        const readOnlyQuery = `
id: valid-rule
name: Valid read-only
level: note
scope: repository
query: |
  MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, 'repository' AS entityType, 'ok' AS detail
`;
        setupSingleFile(readOnlyQuery);
        const rules = await loadPolicies({ rulesPath: '/any.yaml' });
        expect(rules).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Schema validation (zod)
// ═══════════════════════════════════════════════════════════════════════════════

describe('schema validation', () => {
    test('rejects rule with missing id', async () => {
        const bad = `
name: Missing ID
level: error
scope: repository
query: MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, 'r' AS entityType, 'd' AS detail
`;
        setupSingleFile(bad);
        const rules = await loadPolicies({ rulesPath: '/bad.yaml' });
        expect(rules).toHaveLength(0);
    });

    test('rejects rule with invalid level', async () => {
        const bad = `
id: bad-requirement
name: Bad
level: critical
scope: repository
query: MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, 'r' AS entityType, 'd' AS detail
`;
        setupSingleFile(bad);
        const rules = await loadPolicies({ rulesPath: '/bad.yaml' });
        expect(rules).toHaveLength(0);
    });

    test('rejects rule with non-kebab-case id', async () => {
        const bad = `
id: GP001_UPPERCASE
name: Bad ID
level: error
scope: repository
query: MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, 'r' AS entityType, 'd' AS detail
`;
        setupSingleFile(bad);
        const rules = await loadPolicies({ rulesPath: '/bad.yaml' });
        expect(rules).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Filters
// ═══════════════════════════════════════════════════════════════════════════════

describe('filters', () => {
    test('filterTag excludes non-matching rules', async () => {
        setupDirectory({
            'gp-001.yaml': VALID_RULE_YAML,  // tags: [golden-path]
            'gp-004.yaml': WARNING_RULE_YAML, // tags: []
        });
        const rules = await loadPolicies({ rulesPath: '/rules', filterTag: 'golden-path' });
        expect(rules).toHaveLength(1);
        expect(rules[0]!.id).toBe('gp-001-makefile-targets');
    });

    test('minLevel=warning excludes note rules', async () => {
        const couldRule = `
id: could-rule
name: Could level
level: note
scope: repository
query: MATCH (r:Repository) RETURN r.id AS entityId, r.name AS entityName, 'repository' AS entityType, 'd' AS detail
`;
        setupDirectory({
            'gp-001.yaml': VALID_RULE_YAML, // must
            'could.yaml': couldRule,           // could
        });
        const rules = await loadPolicies({ rulesPath: '/rules', minLevel: 'warning' });
        expect(rules).toHaveLength(1);
        expect(rules[0]!.level).toBe('error');
    });

    test('minLevel=error excludes warning rules', async () => {
        setupDirectory({
            'gp-001.yaml': VALID_RULE_YAML,   // must
            'gp-004.yaml': WARNING_RULE_YAML,  // should
        });
        const rules = await loadPolicies({ rulesPath: '/rules', minLevel: 'error' });
        expect(rules).toHaveLength(1);
        expect(rules[0]!.level).toBe('error');
    });
});
