import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguagePlugin, RuntimeServiceSignals } from '../../../../src/ingestion/core/languages/types';
import { classifyServiceRole } from '../../../../src/ingestion/extractors/autodiscovery';

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-classify-'));
}

function touch(dir: string, rel: string, contents = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

function stubPlugin(signals: RuntimeServiceSignals | undefined): LanguagePlugin {
    return { language: 'fake', extensions: [], scopeExclusions: [], runtimeServiceSignals: signals } as unknown as LanguagePlugin;
}

describe('classifyServiceRole — declarative signal evaluation', () => {
    let repo: string;
    beforeEach(() => { repo = makeRepo(); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('plugin without signals and no Dockerfile → undefined', () => {
        touch(repo, 'apps/lib-only/package.json', '{}');
        const dir = path.join(repo, 'apps/lib-only');
        const plugin = stubPlugin(undefined);
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('workspace with a Dockerfile in dir → runtime (language-agnostic short-circuit)', () => {
        touch(repo, 'apps/x/Dockerfile', 'FROM acme/node:20\nCMD ["node", "dist/main.js"]\n');
        touch(repo, 'apps/x/package.json', '{}');
        const dir = path.join(repo, 'apps/x');
        const plugin = stubPlugin(undefined);
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('manifestFields condition=exists fires → runtime', () => {
        touch(repo, 'apps/api/package.json', JSON.stringify({ scripts: { start: 'node dist/main.js' } }));
        const dir = path.join(repo, 'apps/api');
        const plugin = stubPlugin({
            manifestFields: [{ manifest: 'package.json', jsonPath: 'scripts.start', condition: 'exists' }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('manifestFields jsonPath missing → no fire from this signal', () => {
        touch(repo, 'libs/pure/package.json', JSON.stringify({ main: 'dist/index.js', private: true }));
        const dir = path.join(repo, 'libs/pure');
        const plugin = stubPlugin({
            manifestFields: [{ manifest: 'package.json', jsonPath: 'scripts.start', condition: 'exists' }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('manifestFields condition=matches with valuePattern → runtime when regex matches', () => {
        touch(repo, 'apps/api/package.json', JSON.stringify({ main: 'dist/main.js' }));
        const dir = path.join(repo, 'apps/api');
        const plugin = stubPlugin({
            manifestFields: [{
                manifest: 'package.json',
                jsonPath: 'main',
                condition: 'matches',
                valuePattern: /main\.js$/,
            }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('entrypoint grep regex matches file contents → runtime', () => {
        touch(repo, 'apps/api/package.json', '{}');
        touch(repo, 'apps/api/src/Main.bootstrap.ts', 'await NestFactory.create(AppModule);');
        const dir = path.join(repo, 'apps/api');
        const plugin = stubPlugin({
            entrypoints: [{ files: ['src/Main.bootstrap.ts'], patterns: [/NestFactory\.create/] }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('entrypoint file missing → signal does not fire', () => {
        touch(repo, 'libs/util/package.json', '{}');
        const dir = path.join(repo, 'libs/util');
        const plugin = stubPlugin({
            entrypoints: [{ files: ['src/Main.bootstrap.ts'], patterns: [/NestFactory\.create/] }],
        });
        expect(classifyServiceRole(dir, plugin)).toBeUndefined();
    });

    it('dependencyMarker found in package.json#dependencies → runtime', () => {
        touch(repo, 'apps/api/package.json', JSON.stringify({
            dependencies: { '@nestjs/graphql': '12.0.0' },
        }));
        const dir = path.join(repo, 'apps/api');
        const plugin = stubPlugin({
            dependencyMarkers: [{ manifest: 'package.json', packages: ['@nestjs/graphql'], sections: ['dependencies', 'devDependencies'] }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('any-of semantics: one of three signals fires → runtime', () => {
        // No Dockerfile, no manifestField, but entrypoint regex matches.
        touch(repo, 'apps/x/package.json', '{}');
        touch(repo, 'apps/x/index.ts', 'const app = http.createServer(handler);');
        const dir = path.join(repo, 'apps/x');
        const plugin = stubPlugin({
            manifestFields: [{ manifest: 'package.json', jsonPath: 'scripts.start', condition: 'exists' }],
            entrypoints: [{ files: ['index.ts'], patterns: [/http\.createServer/] }],
        });
        expect(classifyServiceRole(dir, plugin)).toBe('runtime');
    });

    it('null plugin (unknown language) and no Dockerfile → undefined', () => {
        touch(repo, 'apps/mystery/package.json', '{}');
        const dir = path.join(repo, 'apps/mystery');
        expect(classifyServiceRole(dir, null)).toBeUndefined();
    });

    it('null plugin but Dockerfile present → runtime', () => {
        touch(repo, 'apps/mystery/Dockerfile', 'FROM alpine\n');
        const dir = path.join(repo, 'apps/mystery');
        expect(classifyServiceRole(dir, null)).toBe('runtime');
    });
});
