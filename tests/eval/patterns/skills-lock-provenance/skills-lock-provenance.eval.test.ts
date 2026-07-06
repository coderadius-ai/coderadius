import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { agenticConfigPlugin } from '../../../../src/ingestion/structural/plugins/agentic-config.plugin.js';
import type { PluginContext, StructuralEntity, StructuralEnrichment } from '../../../../src/ingestion/structural/types.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const REPO_NAME = 'order-service';

interface GraphManifest {
    fixture: string;
    description: string;
    expected_nodes: Record<string, string[]>;
    negative_nodes?: Record<string, string[]>;
}

function makeContext(relativePath: string): PluginContext {
    return {
        relativePath,
        repoName: REPO_NAME,
        ownerService: REPO_NAME,
        language: null,
        fileContent: '',
    };
}

function discoverAll(fixtureRoot: string): { entities: StructuralEntity[]; enrichments: StructuralEnrichment[] } {
    const entities: StructuralEntity[] = [];
    const enrichments: StructuralEnrichment[] = [];
    const repoDir = path.join(fixtureRoot, REPO_NAME);

    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                walk(fullPath);
            } else {
                const relPath = path.relative(repoDir, fullPath);
                if (agenticConfigPlugin.matchFile(relPath, entry.name)) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const result = agenticConfigPlugin.extract(content, makeContext(relPath));
                    entities.push(...result.entities);
                    if (result.enrichments) enrichments.push(...result.enrichments);
                }
            }
        }
    }

    walk(repoDir);
    return { entities, enrichments };
}

describe('Pattern Eval: skills-lock-provenance (structural, deterministic)', () => {
    let manifest: GraphManifest;
    let entities: StructuralEntity[];
    let enrichments: StructuralEnrichment[];

    beforeAll(() => {
        manifest = yaml.load(
            fs.readFileSync(path.resolve(TEST_DIR, 'expected.graph.yaml'), 'utf-8'),
        ) as GraphManifest;
        const result = discoverAll(FIXTURE_DIR);
        entities = result.entities;
        enrichments = result.enrichments;
    });

    it('SKILL.md files produce AgenticConfig entities', () => {
        expect(entities.length).toBe(3);
        const names = entities.map(e => e.properties.skillName ?? e.properties.name);
        for (const expected of manifest.expected_nodes.AgenticConfig) {
            expect(names, `Missing node: ${expected}`).toContain(expected);
        }
    });

    it('skills-lock.json produces zero entities (enrichment-only)', () => {
        const lockEntities = entities.filter(e =>
            e.properties._sourcePath === 'skills-lock.json'
        );
        expect(lockEntities).toHaveLength(0);
    });

    it('skills-lock.json produces enrichments for each locked skill', () => {
        expect(enrichments.length).toBe(3);
        const skillNames = enrichments.map(e => e.matchValue);
        expect(skillNames).toContain('review-pr');
        expect(skillNames).toContain('generate-tests');
        expect(skillNames).toContain('deploy-preview');
    });

    it('enrichments target AgenticConfig.skillName', () => {
        for (const e of enrichments) {
            expect(e.label).toBe('AgenticConfig');
            expect(e.matchField).toBe('skillName');
        }
    });

    it('enrichments carry provenance properties from the lock', () => {
        const reviewPr = enrichments.find(e => e.matchValue === 'review-pr');
        expect(reviewPr).toBeDefined();
        expect(reviewPr!.properties.skillSource).toBe('acme/agent-skills');
        expect(reviewPr!.properties.skillSourceUrl).toBe('https://github.com/acme/agent-skills');
        expect(reviewPr!.properties.skillSourceType).toBe('github');
        expect(reviewPr!.properties.skillInstalledAt).toBe('2026-05-10T08:00:00Z');
        expect(reviewPr!.properties.skillUpdatedAt).toBe('2026-05-20T14:30:00Z');
    });

    it('local skills carry sourceType but no hash', () => {
        const deploy = enrichments.find(e => e.matchValue === 'deploy-preview');
        expect(deploy!.properties.skillSourceType).toBe('local');
        expect(deploy!.properties.skillHash).toBeUndefined();
    });

    it('SKILL.md entities have correct tool assignments', () => {
        const claude = entities.find(e => e.properties._sourcePath?.toString().includes('.claude/'));
        expect(claude?.properties.tool).toBe('claude');

        const generic = entities.find(e => e.properties._sourcePath?.toString().includes('.agents/'));
        expect(generic?.properties.tool).toBe('generic');
    });

    it('REGRESSION: skill entities without ownerService still have configType=skill', () => {
        const skillEntities = entities.filter(e => e.properties.configType === 'skill');
        expect(skillEntities.length).toBeGreaterThanOrEqual(1);
        for (const e of skillEntities) {
            expect(e.properties.configType).toBe('skill');
            expect(e.properties.skillName).toBeTruthy();
        }
    });

    it('REGRESSION: skill entities without ownerService get _ownerService from context', () => {
        for (const e of entities) {
            expect(e.properties._ownerService).toBeDefined();
        }
    });

    it('REGRESSION: queryCatalog filter IN clause includes skill type', () => {
        const CATALOG_TYPES = ['skill', 'workflow', 'rule', 'subagent_rule', 'subagents_config', 'multi_agent_config', 'tasks_config', 'agent_instructions'];
        const skillEntities = entities.filter(e => e.properties.configType === 'skill');
        for (const e of skillEntities) {
            expect(
                CATALOG_TYPES.includes(e.properties.configType as string),
                `configType "${e.properties.configType}" must be in queryCatalog IN clause`,
            ).toBe(true);
        }
    });
});
