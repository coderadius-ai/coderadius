import { describe, it, expect } from 'vitest';
import { makefilePlugin } from '../../../../src/ingestion/structural/plugins/makefile.plugin.js';
import { dockerfilePlugin } from '../../../../src/ingestion/structural/plugins/dockerfile.plugin.js';
import { toolconfigPlugin } from '../../../../src/ingestion/structural/plugins/toolconfig.plugin.js';
import { packagePublisherPlugin } from '../../../../src/ingestion/structural/plugins/package-publisher.plugin.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';

const mockContext: PluginContext = {
    relativePath: 'test-file',
    absolutePath: '/abs/test-file',
    repoName: 'test-repo',
    repoUrn: 'cr://repository/test-repo',
    scopeManager: new ScopeManager('/tmp'), // Mock manager
};

describe('Structural Plugins - Unit Tests', () => {

    describe('Makefile Plugin', () => {
        it('should match Makefile variants', () => {
            expect(makefilePlugin.matchFile('Makefile', 'Makefile')).toBe(true);
            expect(makefilePlugin.matchFile('makefile', 'makefile')).toBe(true);
            expect(makefilePlugin.matchFile('GNUmakefile', 'GNUmakefile')).toBe(true);
            expect(makefilePlugin.matchFile('subdir/Makefile', 'Makefile')).toBe(true);
            expect(makefilePlugin.matchFile('README.md', 'README.md')).toBe(false);
        });

        it('should extract standard targets and ignore internals', () => {
            const content = `
build:
	echo building...

test: build
	npm run test

.PHONY: build test

.setup:
	mkdir temp
`;
            const result = makefilePlugin.extract(content, mockContext);
            const targets = result.entities.map(e => e.properties.name);
            
            expect(targets).toContain('build');
            expect(targets).toContain('test');
            expect(targets).not.toContain('.setup');
            expect(targets).not.toContain('.PHONY');
            expect(result.entities[0].labels).toContain('Task');
        });
    });

    describe('Dockerfile Plugin', () => {
        it('should match Dockerfile variants', () => {
            expect(dockerfilePlugin.matchFile('Dockerfile', 'Dockerfile')).toBe(true);
            expect(dockerfilePlugin.matchFile('Dockerfile.prod', 'Dockerfile.prod')).toBe(true);
            expect(dockerfilePlugin.matchFile('docker/api.dockerfile', 'api.dockerfile')).toBe(true);
        });

        it('should extract base images and tags correctly', () => {
            const content = `
FROM node:20-alpine AS builder
WORKDIR /app
FROM python:3.12-slim
FROM --platform=linux/amd64 postgres:15
FROM scratch
`;
            const result = dockerfilePlugin.extract(content, mockContext);
            const images = result.entities.map(e => `${e.properties.name}:${e.properties.tag}`);
            
            expect(images).toContain('node:20-alpine');
            expect(images).toContain('python:3.12-slim');
            expect(images).toContain('postgres:15');
            expect(images).not.toContain('scratch:latest');
        });
    });

    describe('ToolConfig Plugin', () => {
        it('should match tsconfig.json variants', () => {
            expect(toolconfigPlugin.matchFile('tsconfig.json', 'tsconfig.json')).toBe(true);
            expect(toolconfigPlugin.matchFile('tsconfig.base.json', 'tsconfig.base.json')).toBe(true);
        });

        it('should extract strictness flags, set tool=TypeScript, and handle JSONC (comments)', () => {
            const content = `
{
    // My compiler config
    "compilerOptions": {
        "target": "ESNext",
        "strict": true,
        "noImplicitAny": false,
        "outDir": "dist"
    },
    "extends": "./base.json"
}
`;
            const result = toolconfigPlugin.extract(content, mockContext);
            expect(result.entities.length).toBe(1);
            const props = result.entities[0].properties;
            
            expect(props.tool).toBe('TypeScript');
            expect(props.target).toBe('ESNext');
            expect(props.strict).toBe(true);
            expect(props.noImplicitAny).toBe(false);
            expect(props.extends).toBe('./base.json');
        });

        it('should handle malformed JSON gracefully', () => {
            const result = toolconfigPlugin.extract('not json {', mockContext);
            expect(result.entities).toEqual([]);
            expect(result.summary).toContain('parse error');
        });
    });

    describe('Package Publisher Plugin', () => {
        it('should extract valid internal npm packages with entry points', () => {
            const content = JSON.stringify({
                name: '@acme/auth',
                version: '1.2.3',
                main: 'dist/index.js',
                publishConfig: { registry: 'internal' }
            });
            const ctx = { ...mockContext, relativePath: 'package.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            
            expect(result.entities.length).toBe(1);
            expect(result.entities[0].properties._packageName).toBe('@acme/auth');
            expect(result.entities[0].properties._version).toBe('1.2.3');
        });

        it('should skip private packages', () => {
            const content = JSON.stringify({
                name: 'root',
                version: '1.0.0',
                private: true,
                main: 'index.js',
            });
            const result = packagePublisherPlugin.extract(content, mockContext);
            expect(result.entities).toEqual([]);
        });

        it('should skip placeholder workspace versions (0.0.0, workspace:*)', () => {
            const content0 = JSON.stringify({ name: 'lib', version: '0.0.0', main: 'index.js' });
            expect(packagePublisherPlugin.extract(content0, mockContext).entities).toEqual([]);

            const contentWs = JSON.stringify({ name: 'lib', version: 'workspace:*', main: 'index.js' });
            expect(packagePublisherPlugin.extract(contentWs, mockContext).entities).toEqual([]);
        });

        it('should skip npm packages without entry points (main/module/exports/types/bin)', () => {
            // This is the "shark-fe" scenario: application manifest with deps but no publishable entry
            const content = JSON.stringify({
                name: 'shark-fe',
                version: '0.0.1',
                description: 'Frontend app',
                dependencies: { react: '18.0.0' },
            });
            const ctx = { ...mockContext, relativePath: 'package.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            expect(result.entities).toEqual([]);
            expect(result.summary).toContain('Not a publishable npm package');
        });

        it('should accept npm packages with module/exports/types/bin entry', () => {
            // module
            expect(packagePublisherPlugin.extract(
                JSON.stringify({ name: '@acme/utils', version: '1.0.0', module: 'dist/index.mjs' }),
                { ...mockContext, relativePath: 'package.json' },
            ).entities.length).toBe(1);

            // exports
            expect(packagePublisherPlugin.extract(
                JSON.stringify({ name: '@acme/core', version: '2.0.0', exports: { '.': './dist/index.js' } }),
                { ...mockContext, relativePath: 'package.json' },
            ).entities.length).toBe(1);

            // types
            expect(packagePublisherPlugin.extract(
                JSON.stringify({ name: '@acme/types', version: '1.0.0', types: 'dist/index.d.ts' }),
                { ...mockContext, relativePath: 'package.json' },
            ).entities.length).toBe(1);

            // bin
            expect(packagePublisherPlugin.extract(
                JSON.stringify({ name: '@acme/cli', version: '3.0.0', bin: { acme: './bin/acme.js' } }),
                { ...mockContext, relativePath: 'package.json' },
            ).entities.length).toBe(1);
        });

        it('should extract composer packages with autoload correctly', () => {
             const content = JSON.stringify({
                name: 'acme/logger',
                version: '2.0.0',
                autoload: { 'psr-4': { 'Acme\\Logger\\': 'src' } },
            });
            const ctx = { ...mockContext, relativePath: 'composer.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            
            expect(result.entities.length).toBe(1);
            expect(result.entities[0].properties._ecosystem).toBe('composer');
        });

        it('should skip composer packages without autoload or library type', () => {
            const content = JSON.stringify({
                name: 'acme/app',
                version: '1.0.0',
                require: { 'php': '>=8.0' },
            });
            const ctx = { ...mockContext, relativePath: 'composer.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            expect(result.entities).toEqual([]);
            expect(result.summary).toContain('Not a publishable Composer package');
        });

        it('should accept composer packages with type=library even at low versions', () => {
            const content = JSON.stringify({
                name: 'logistics-industry/event-consumer-php',
                version: '0.0.2',
                type: 'library',
            });
            const ctx = { ...mockContext, relativePath: 'composer.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            // 0.0.2 is a real release (see event-consumer changelog), not a placeholder
            expect(result.entities.length).toBe(1);
            expect(result.entities[0].properties._packageName).toBe('logistics-industry/event-consumer-php');
            expect(result.entities[0].properties._version).toBe('0.0.2');
        });

        it('should accept npm packages at 0.0.x versions (they are real releases)', () => {
            const content = JSON.stringify({
                name: '@acme-org/event-consumer',
                version: '0.0.1',
                main: 'dist/lib/index.js',
                typings: 'dist/lib/index.d.ts',
            });
            const ctx = { ...mockContext, relativePath: 'package.json' };
            const result = packagePublisherPlugin.extract(content, ctx);
            expect(result.entities.length).toBe(1);
            expect(result.entities[0].properties._version).toBe('0.0.1');
        });
    });
});
