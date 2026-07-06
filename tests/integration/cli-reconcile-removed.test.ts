import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('CLI command surface', () => {
    it('does not expose standalone cr reconcile', () => {
        const result = spawnSync(
            'bun',
            ['run', 'src/cli/index.ts', 'reconcile'],
            {
                cwd: process.cwd(),
                encoding: 'utf-8',
                env: { ...process.env, NODE_ENV: 'test' },
            },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown command|error: unknown command/i);
    });
});
