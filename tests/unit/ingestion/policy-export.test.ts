import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportPack } from '../../../src/cli/commands/policy/export.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-export-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('exportPack', () => {
    test('exports agent-readiness built-in pack', async () => {
        const result = await exportPack('agent-readiness', { targetPath: tmpDir });

        expect(result.copied).toBeGreaterThanOrEqual(5);
        expect(result.targetDir).toBe(path.join(tmpDir, 'agent-readiness'));
        expect(fs.existsSync(result.targetDir)).toBe(true);

        const files = fs.readdirSync(result.targetDir);
        expect(files.some(f => f.includes('ar-blast-radius'))).toBe(true);
        expect(files.some(f => f.includes('ar-skills-coverage'))).toBe(true);
        expect(files.some(f => f.includes('ar-codeowners'))).toBe(true);
        expect(files.some(f => f.includes('ar-rules-validated'))).toBe(true);
        expect(files.some(f => f.includes('ar-tests-present'))).toBe(true);
    });

    test('exported YAML files are valid and parseable', async () => {
        const yaml = await import('js-yaml');
        const result = await exportPack('agent-readiness', { targetPath: tmpDir });

        for (const file of result.files) {
            const content = fs.readFileSync(path.join(result.targetDir, file), 'utf-8');
            const parsed = yaml.load(content) as Record<string, unknown>;
            expect(parsed).toHaveProperty('id');
            expect(parsed).toHaveProperty('name');
            expect(parsed).toHaveProperty('query');
            expect(parsed).toHaveProperty('level');
            expect(parsed).toHaveProperty('scope', 'repository');
            expect((parsed.tags as string[]) ?? []).toContain('agent-readiness');
        }
    });

    test('throws on unknown pack name', async () => {
        await expect(exportPack('nonexistent-pack', { targetPath: tmpDir }))
            .rejects.toThrow('Pack "nonexistent-pack" not found');
    });

    test('throws when target exists without --force', async () => {
        await exportPack('agent-readiness', { targetPath: tmpDir });
        await expect(exportPack('agent-readiness', { targetPath: tmpDir }))
            .rejects.toThrow('already exists');
    });

    test('overwrites with --force', async () => {
        await exportPack('agent-readiness', { targetPath: tmpDir });
        const result = await exportPack('agent-readiness', { targetPath: tmpDir, force: true });
        expect(result.copied).toBeGreaterThanOrEqual(5);
    });
});
