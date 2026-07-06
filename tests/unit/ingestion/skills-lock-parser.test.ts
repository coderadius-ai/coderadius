import { describe, test, expect } from 'vitest';
import { agenticConfigPlugin } from '../../../src/ingestion/structural/plugins/agentic-config.plugin';
import type { PluginContext } from '../../../src/ingestion/structural/types';

function makeContext(relativePath: string): PluginContext {
    return {
        relativePath,
        repoName: 'acme-orders',
        ownerService: 'orders-core',
        language: null,
        fileContent: '',
    };
}

const VALID_LOCK = JSON.stringify({
    version: 1,
    skills: {
        'frontend-design': {
            source: 'vercel-labs/agent-skills',
            sourceType: 'github',
            sourceUrl: 'https://github.com/vercel-labs/agent-skills',
            ref: 'main',
            skillPath: 'skills/frontend-design',
            skillFolderHash: 'abc123def456',
            installedAt: '2026-05-20T10:00:00Z',
            updatedAt: '2026-05-24T14:30:00Z',
        },
        'web-design-guidelines': {
            source: 'vercel-labs/agent-skills',
            sourceType: 'github',
            sourceUrl: 'https://github.com/vercel-labs/agent-skills',
            skillFolderHash: 'def789ghi012',
        },
        'custom-local-skill': {
            source: './my-local-skills',
            sourceType: 'local',
        },
    },
});

describe('skills-lock.json parser', () => {
    test('matchFile recognizes skills-lock.json', () => {
        expect(agenticConfigPlugin.matchFile('skills-lock.json', 'skills-lock.json')).toBe(true);
    });

    test('matchFile rejects unrelated JSON', () => {
        expect(agenticConfigPlugin.matchFile('package-lock.json', 'package-lock.json')).toBe(false);
    });

    test('emits zero entities (enrichment-only)', () => {
        const result = agenticConfigPlugin.extract(VALID_LOCK, makeContext('skills-lock.json'));
        expect(result.entities).toHaveLength(0);
    });

    test('emits enrichments for all skills in lock', () => {
        const result = agenticConfigPlugin.extract(VALID_LOCK, makeContext('skills-lock.json'));
        expect(result.enrichments).toHaveLength(3);
        expect(result.summary).toContain('3 provenance enrichment(s)');
    });

    test('enrichments match by skillName on AgenticConfig label', () => {
        const result = agenticConfigPlugin.extract(VALID_LOCK, makeContext('skills-lock.json'));
        for (const e of result.enrichments!) {
            expect(e.label).toBe('AgenticConfig');
            expect(e.matchField).toBe('skillName');
            expect(e.matchValue).toBeTruthy();
        }
    });

    test('enrichment carries provenance properties', () => {
        const result = agenticConfigPlugin.extract(VALID_LOCK, makeContext('skills-lock.json'));
        const fd = result.enrichments!.find(e => e.matchValue === 'frontend-design');

        expect(fd).toBeDefined();
        expect(fd!.properties.skillSource).toBe('vercel-labs/agent-skills');
        expect(fd!.properties.skillSourceUrl).toBe('https://github.com/vercel-labs/agent-skills');
        expect(fd!.properties.skillSourceType).toBe('github');
        expect(fd!.properties.skillHash).toBe('abc123def456');
        expect(fd!.properties.skillInstalledAt).toBe('2026-05-20T10:00:00Z');
        expect(fd!.properties.skillUpdatedAt).toBe('2026-05-24T14:30:00Z');
    });

    test('local skill has sourceType but no hash', () => {
        const result = agenticConfigPlugin.extract(VALID_LOCK, makeContext('skills-lock.json'));
        const local = result.enrichments!.find(e => e.matchValue === 'custom-local-skill');
        expect(local!.properties.skillSourceType).toBe('local');
        expect(local!.properties.skillHash).toBeUndefined();
    });

    test('handles invalid JSON gracefully', () => {
        const result = agenticConfigPlugin.extract('not json {{{', makeContext('skills-lock.json'));
        expect(result.entities).toHaveLength(0);
        expect(result.enrichments).toBeUndefined();
        expect(result.summary).toContain('invalid JSON');
    });

    test('handles empty skills object', () => {
        const empty = JSON.stringify({ version: 1, skills: {} });
        const result = agenticConfigPlugin.extract(empty, makeContext('skills-lock.json'));
        expect(result.entities).toHaveLength(0);
        expect(result.enrichments).toHaveLength(0);
    });
});
