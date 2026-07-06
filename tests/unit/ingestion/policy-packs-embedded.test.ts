import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Embedded built-in packs
//
// The compiled binary cannot read pack YAML files from disk (import.meta.dir
// points into $bunfs and runtime fs reads are not embedded). The loader must
// fall back to the generated EMBEDDED_PACKS snapshot when no filesystem path
// resolves. These tests simulate the binary by making every statSync miss.
//
// The drift guard at the bottom pins the snapshot to the YAML source of
// truth: it fails when src/policy-runner/packs/ changes without regenerating
// packs.generated.ts (bun run gen:packs).
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('glob', () => ({
    glob: vi.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { loadPolicies, getBuiltinPacksDir, readBuiltinPackFiles } from '../../../src/policy-runner/loader.js';
import { EMBEDDED_PACKS } from '../../../src/policy-runner/packs.generated.js';
import { buildEmbeddedPacksMap } from '../../../scripts/generate-embedded-packs.js';

const AGENT_READINESS_RULE_IDS = [
    'ar-architecture-context',
    'ar-blast-radius',
    'ar-codeowners',
    'ar-context-actionable',
    'ar-context-minimal',
    'ar-makefile-targets',
    'ar-rules-validated',
    'ar-skills-coverage',
    'ar-tests-present',
];

describe('loadPolicies — embedded fallback (compiled binary)', () => {
    let statSyncSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // Simulate the compiled binary: no rules path exists on disk.
        statSyncSpy = vi.spyOn(fs, 'statSync');
        statSyncSpy.mockReturnValue(undefined as unknown as ReturnType<typeof fs.statSync>);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('resolves a built-in pack name from the embedded snapshot', async () => {
        const rules = await loadPolicies({ rulesPath: 'agent-readiness' });
        expect(rules.map(r => r.id).sort()).toEqual(AGENT_READINESS_RULE_IDS);
        expect(rules.every(r => r.tags.includes('agent-readiness'))).toBe(true);
    });

    test('with no rulesPath, loads every embedded pack', async () => {
        const rules = await loadPolicies({});
        expect(rules.length).toBeGreaterThanOrEqual(AGENT_READINESS_RULE_IDS.length);
        for (const id of AGENT_READINESS_RULE_IDS) {
            expect(rules.map(r => r.id)).toContain(id);
        }
    });

    test('applies filters to embedded rules', async () => {
        const rules = await loadPolicies({ rulesPath: 'agent-readiness', minLevel: 'error' });
        expect(rules.map(r => r.id)).toEqual(['ar-tests-present']);
    });

    test('still throws for a path that is neither on disk nor embedded', async () => {
        await expect(loadPolicies({ rulesPath: '/nonexistent/path' })).rejects.toThrow('Rules path not found');
    });
});

describe('readBuiltinPackFiles — embedded fallback for cr policy export', () => {
    let statSyncSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        statSyncSpy = vi.spyOn(fs, 'statSync');
        statSyncSpy.mockReturnValue(undefined as unknown as ReturnType<typeof fs.statSync>);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('returns embedded file contents when the packs directory is absent', async () => {
        const files = await readBuiltinPackFiles('agent-readiness');
        expect(Object.keys(files).sort()).toEqual(AGENT_READINESS_RULE_IDS.map(id => `${id}.yaml`));
        expect(files['ar-blast-radius.yaml']).toContain('id: ar-blast-radius');
    });

    test('throws with the available pack names for an unknown pack', async () => {
        await expect(readBuiltinPackFiles('no-such-pack')).rejects.toThrow(/agent-readiness/);
    });
});

describe('embedded snapshot drift guard', () => {
    test('packs.generated.ts matches src/policy-runner/packs/ — run `bun run gen:packs` if this fails', () => {
        const fresh = buildEmbeddedPacksMap(getBuiltinPacksDir());
        expect(EMBEDDED_PACKS).toEqual(fresh);
    });

    test('the packs dir resolves to a real directory in the source tree', () => {
        expect(fs.statSync(path.join(getBuiltinPacksDir(), 'agent-readiness')).isDirectory()).toBe(true);
    });
});
