import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPolicies } from '../../../src/policy-runner/loader.js';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-priority-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MINIMAL_RULE = (id: string, name: string) => `
id: ${id}
name: ${name}
level: warning
scope: repository
tags:
  - agent-readiness
query: |
  MATCH (r:Repository)
  RETURN r.id AS entityId, r.name AS entityName, 'Repository' AS entityType, 'pass' AS status, 'ok' AS detail
`;

describe('policy loader priority resolution', () => {
    test('loads built-in agent-readiness pack by name', async () => {
        const rules = await loadPolicies({ rulesPath: 'agent-readiness' });
        expect(rules.length).toBeGreaterThanOrEqual(5);
        expect(rules.every(r => r.tags.includes('agent-readiness'))).toBe(true);
    });

    test('user override takes priority over built-in', async () => {
        const overrideDir = path.join(tmpDir, '.coderadius', 'policies', 'agent-readiness');
        fs.mkdirSync(overrideDir, { recursive: true });
        fs.writeFileSync(
            path.join(overrideDir, 'custom-rule.yaml'),
            MINIMAL_RULE('custom-override', 'Custom Override Rule'),
        );

        const rules = await loadPolicies({ rulesPath: 'agent-readiness' });
        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('custom-override');
        expect(rules[0].name).toBe('Custom Override Rule');
    });

    test('direct path takes priority over pack name resolution', async () => {
        const directDir = path.join(tmpDir, 'my-rules');
        fs.mkdirSync(directDir, { recursive: true });
        fs.writeFileSync(
            path.join(directDir, 'direct.yaml'),
            MINIMAL_RULE('direct-rule', 'Direct Path Rule'),
        );

        const rules = await loadPolicies({ rulesPath: directDir });
        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('direct-rule');
    });

    test('tag filtering works with pack name', async () => {
        const rules = await loadPolicies({
            rulesPath: 'agent-readiness',
            filterTag: 'agent-readiness',
        });
        expect(rules.length).toBeGreaterThanOrEqual(5);

        const noMatch = await loadPolicies({
            rulesPath: 'agent-readiness',
            filterTag: 'nonexistent-tag',
        });
        expect(noMatch).toHaveLength(0);
    });
});
