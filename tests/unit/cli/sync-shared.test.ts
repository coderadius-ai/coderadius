import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    renderIngestCompletion,
    resolveIngestListrRenderer,
    resolveIngestSourcePaths,
    shouldEmitTaskOutput,
} from '../../../src/cli/commands/analyze/shared.js';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // best effort cleanup
        }
    }
});

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radius-ingest-paths-'));
    tempDirs.push(dir);
    return dir;
}

describe('resolveIngestSourcePaths', () => {
    it('falls back to cwd when no paths are provided', () => {
        const cwd = '/tmp/example-cwd';
        expect(resolveIngestSourcePaths([], {}, cwd)).toEqual([cwd]);
    });

    it('returns direct positional paths unchanged', () => {
        const input = ['git@github.com:org/repo-a.git', 'git@github.com:org/repo-b.git'];
        expect(resolveIngestSourcePaths(input, {}, '/tmp/unused')).toEqual(input);
    });

    it('loads paths from --paths-file', () => {
        const dir = makeTempDir();
        const file = path.join(dir, 'repos.txt');
        fs.writeFileSync(file, '# comment\ngit@github.com:org/repo-a.git\n\n git@github.com:org/repo-b.git \n', 'utf-8');

        expect(resolveIngestSourcePaths([], { pathsFile: file }, dir)).toEqual([
            'git@github.com:org/repo-a.git',
            'git@github.com:org/repo-b.git',
        ]);
    });

    it('expands @file positional tokens', () => {
        const dir = makeTempDir();
        const file = path.join(dir, 'repos.txt');
        fs.writeFileSync(file, 'git@github.com:org/repo-a.git\ngit@github.com:org/repo-b.git\n', 'utf-8');

        expect(resolveIngestSourcePaths([`@${file}`], {}, dir)).toEqual([
            'git@github.com:org/repo-a.git',
            'git@github.com:org/repo-b.git',
        ]);
    });

    it('deduplicates while preserving order', () => {
        const dir = makeTempDir();
        const file = path.join(dir, 'repos.txt');
        fs.writeFileSync(file, 'git@github.com:org/repo-a.git\ngit@github.com:org/repo-c.git\n', 'utf-8');

        expect(resolveIngestSourcePaths(
            ['git@github.com:org/repo-a.git', 'git@github.com:org/repo-b.git'],
            { pathsFile: file },
            dir,
        )).toEqual([
            'git@github.com:org/repo-a.git',
            'git@github.com:org/repo-b.git',
            'git@github.com:org/repo-c.git',
        ]);
    });

    it('throws when explicit inputs resolve to an empty set', () => {
        const dir = makeTempDir();
        const file = path.join(dir, 'repos.txt');
        fs.writeFileSync(file, '# only comments\n\n', 'utf-8');

        expect(() => resolveIngestSourcePaths([], { pathsFile: file }, dir))
            .toThrow('No source targets resolved from arguments');
    });
});

describe('resolveIngestListrRenderer', () => {
    it('uses simple renderer for verbose and large scans', () => {
        expect(resolveIngestListrRenderer({ verbose: true })).toBe('simple');
        expect(resolveIngestListrRenderer({ isLargeScan: true })).toBe('simple');
    });

    it('uses default renderer for normal interactive scans', () => {
        expect(resolveIngestListrRenderer({})).toBe('default');
    });

    it('emits task output for Listr progress details', () => {
        expect(shouldEmitTaskOutput('simple', false)).toBe(true);
        expect(shouldEmitTaskOutput('simple', true)).toBe(true);
        expect(shouldEmitTaskOutput('default', false)).toBe(true);
    });
});

describe('renderIngestCompletion', () => {
    it('renders next steps without emoji', () => {
        const output = renderIngestCompletion({
            title: 'Sync complete',
            nextSteps: [
                { command: 'cr ui', description: 'Open architecture dashboard' },
                { command: 'cr docs generate', description: 'Generate C4 Markdown' },
            ],
        });

        expect(output).toContain('Sync complete');
        expect(output).toContain('Next steps');
        expect(output).toContain('cr ui');
        expect(output).not.toContain('🚀');
        expect(output).not.toContain('📄');
    });

    it('renders trace artifacts inside the completion box', () => {
        const reportPath = path.join(os.homedir(), '.coderadius', 'traces', 'run.trace.md');
        const rawJsonlPath = path.join(os.homedir(), '.coderadius', 'traces', 'run.trace.jsonl');
        const output = renderIngestCompletion({
            title: 'Sync complete',
            nextSteps: [
                { command: 'cr ui', description: 'Open architecture dashboard' },
            ],
            trace: {
                reportPath,
                rawJsonlPath,
            },
        });

        expect(output).toContain('Artifacts');
        expect(output).toContain('Report');
        expect(output).toContain('~/.coderadius/traces/run.trace.md');
        expect(output).toContain('JSONL');
        expect(output).toContain('~/.coderadius/traces/run.trace.jsonl');
    });
});
