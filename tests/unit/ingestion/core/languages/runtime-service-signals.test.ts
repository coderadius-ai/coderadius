import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyServiceRole } from '../../../../../src/ingestion/extractors/autodiscovery';
import { getLanguagePlugin } from '../../../../../src/ingestion/core/languages/registry';

function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-signals-'));
}

function touch(dir: string, rel: string, contents = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

describe('runtimeServiceSignals — TypeScript plugin', () => {
    let dir: string;
    beforeEach(() => { dir = makeTmp(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('package.json with scripts.start → runtime', () => {
        touch(dir, 'package.json', JSON.stringify({ scripts: { start: 'node dist/main.js' } }));
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('package.json with bin → runtime', () => {
        touch(dir, 'package.json', JSON.stringify({ bin: { 'orders-cli': 'bin/orders.js' } }));
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('Main.bootstrap.ts with NestFactory.create → runtime', () => {
        touch(dir, 'package.json', '{}');
        touch(dir, 'src/Main.bootstrap.ts', 'await NestFactory.create(AppModule);');
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('index.ts with http.createServer → runtime', () => {
        touch(dir, 'package.json', '{}');
        touch(dir, 'index.ts', 'const s = http.createServer(handler); s.listen(3000);');
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('package.json with scripts.start:prod / start:dev (no bare start) → runtime', () => {
        // Regression: nestjs monorepo workspaces commonly expose `start:prod` /
        // `start:debug` rather than a bare `start` key. Must still classify as runtime.
        touch(dir, 'package.json', JSON.stringify({
            scripts: {
                'start:dev': 'nest start -w',
                'start:prod': 'node --enable-source-maps dist/Main',
                'start:debug': 'nest start --debug',
            },
        }));
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('Main.ts (capital M) with NestFactory.create → runtime (case-sensitive FS guard)', () => {
        // Linux CI is case-sensitive — must declare both `Main.ts` and `main.ts`
        // entrypoint files.
        touch(dir, 'package.json', '{}');
        touch(dir, 'src/Main.ts', 'await NestFactory.create(AppModule);');
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('CLI app via nest-commander (CommandFactory.run) → runtime', () => {
        // Regression for nestjs-commander CLI apps (core-service-style consoles): the
        // entrypoint is a CommandFactory.run, not a NestFactory.create or app.listen.
        touch(dir, 'package.json', JSON.stringify({
            scripts: { 'start:prod': 'node dist/Main' },
        }));
        touch(dir, 'src/Main.ts',
            "import { CommandFactory } from 'nest-commander';\nawait CommandFactory.run(AppModule);");
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });

    it('pure library (only exports, no entrypoint, no start script) → undefined', () => {
        touch(dir, 'package.json', JSON.stringify({
            name: '@acme/orders-domain',
            private: true,
            main: 'dist/index.js',
            exports: { '.': './dist/index.js' },
        }));
        touch(dir, 'src/index.ts', 'export function buildOrder() { return {}; }');
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBeUndefined();
    });

    it('NestJS lib workspace with 16 helper files + dependencies block but NO bootstrap → undefined', () => {
        // REGRESSION GUARD (RC0 root cause from acme-platform ingestion analysis):
        // `libs/helper` in a NestJS monorepo contains 16 pure-helper TS files
        // (CloneHelper.ts, DateHelper.ts, ZodiosHelper.ts, ...), a `nest build`
        // script and a `dependencies` block. It is unambiguously a library,
        // not a runtime service. The old `manifestPresence` signal (≥10 TS
        // files + dependencies) was evaluated standalone and fired here,
        // misclassifying the lib as Service.
        touch(dir, 'package.json', JSON.stringify({
            name: '@lib/helper',
            main: 'dist/index.js',
            scripts: { build: 'nest build', 'type:check': 'tsc --noEmit' },
            dependencies: { lodash: '^4.0.0', luxon: '^3.0.0', 'fp-ts': '^2.0.0' },
        }));
        for (const name of [
            'CloneHelper.ts', 'CryptoHelper.ts', 'DateHelper.ts', 'EnumHelper.ts',
            'FpTsHelper.ts', 'GitLabHelper.ts', 'HashHelper.ts', 'index.ts',
            'IpHelper.ts', 'JsonHelper.ts', 'PredicateHelper.ts', 'RecursionHelper.ts',
            'StringHelper.ts', 'TypeHelper.ts', 'VersioningHelper.ts', 'ZodiosHelper.ts',
        ]) {
            touch(dir, `src/${name}`, `export function dummy() {}\n`);
        }
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBeUndefined();
    });

    it('NestJS app with 16 files AND a bootstrap entrypoint → runtime', () => {
        // Counterpart of the RC0 guard above: a workspace with the same
        // shape (16 files, dependencies block) that ALSO has a real
        // bootstrap MUST still classify as runtime. Pinning the AND-with-
        // strong-signal contract.
        touch(dir, 'package.json', JSON.stringify({
            name: '@app/api',
            scripts: { 'start:prod': 'node dist/Main', build: 'nest build' },
            dependencies: { '@nestjs/core': '^10.0.0' },
        }));
        for (const name of [
            'src/Main.ts', 'src/App.module.ts',
            'src/controllers/A.controller.ts', 'src/controllers/B.controller.ts',
            'src/services/A.service.ts', 'src/services/B.service.ts',
            'src/services/C.service.ts', 'src/dto/A.dto.ts', 'src/dto/B.dto.ts',
            'src/dto/C.dto.ts', 'src/dto/D.dto.ts', 'src/dto/E.dto.ts',
            'src/dto/F.dto.ts', 'src/dto/G.dto.ts', 'src/dto/H.dto.ts',
            'src/utils/I.ts',
        ]) {
            touch(dir, name, name.endsWith('Main.ts') ? 'await NestFactory.create(AppModule);' : 'export const X = 1;');
        }
        expect(classifyServiceRole(dir, getLanguagePlugin('typescript'))).toBe('runtime');
    });
});

describe('runtimeServiceSignals — PHP plugin', () => {
    let dir: string;
    beforeEach(() => { dir = makeTmp(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('public/index.php present → runtime', () => {
        touch(dir, 'composer.json', '{}');
        touch(dir, 'public/index.php', '<?php require __DIR__."/../vendor/autoload.php";');
        expect(classifyServiceRole(dir, getLanguagePlugin('php'))).toBe('runtime');
    });

    it('bin/console present → runtime', () => {
        touch(dir, 'composer.json', '{}');
        touch(dir, 'bin/console', '#!/usr/bin/env php');
        expect(classifyServiceRole(dir, getLanguagePlugin('php'))).toBe('runtime');
    });

    it('composer.json with symfony/runtime → runtime', () => {
        touch(dir, 'composer.json', JSON.stringify({
            require: { 'symfony/runtime': '^7.0' },
        }));
        expect(classifyServiceRole(dir, getLanguagePlugin('php'))).toBe('runtime');
    });

    it('pure library (only autoload) → undefined', () => {
        touch(dir, 'composer.json', JSON.stringify({
            name: 'acme/orders-domain',
            type: 'library',
            autoload: { 'psr-4': { 'Acme\\Orders\\': 'src/' } },
        }));
        touch(dir, 'src/Order.php', '<?php namespace Acme\\Orders; class Order {}');
        expect(classifyServiceRole(dir, getLanguagePlugin('php'))).toBeUndefined();
    });
});

describe('runtimeServiceSignals — Python plugin', () => {
    let dir: string;
    beforeEach(() => { dir = makeTmp(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('manage.py present → runtime', () => {
        touch(dir, 'pyproject.toml', '');
        touch(dir, 'manage.py', '#!/usr/bin/env python\nimport os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "x")');
        expect(classifyServiceRole(dir, getLanguagePlugin('python'))).toBe('runtime');
    });

    it('main.py with FastAPI() → runtime', () => {
        touch(dir, 'pyproject.toml', '');
        touch(dir, 'main.py', 'from fastapi import FastAPI\napp = FastAPI()');
        expect(classifyServiceRole(dir, getLanguagePlugin('python'))).toBe('runtime');
    });

    it('main.py with uvicorn.run → runtime', () => {
        touch(dir, 'pyproject.toml', '');
        touch(dir, 'main.py', 'import uvicorn\nuvicorn.run("app:app", port=8000)');
        expect(classifyServiceRole(dir, getLanguagePlugin('python'))).toBe('runtime');
    });

    it('pure library with only __init__.py and pure functions → undefined', () => {
        touch(dir, 'pyproject.toml', '[project]\nname = "acme-orders-domain"\n');
        touch(dir, 'acme_orders/__init__.py', 'from .builder import build_order');
        touch(dir, 'acme_orders/builder.py', 'def build_order(): return {}');
        expect(classifyServiceRole(dir, getLanguagePlugin('python'))).toBeUndefined();
    });
});

describe('runtimeServiceSignals — Go plugin', () => {
    let dir: string;
    beforeEach(() => { dir = makeTmp(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('cmd/server/main.go with http.ListenAndServe → runtime', () => {
        touch(dir, 'go.mod', 'module acme/orders\n');
        touch(dir, 'cmd/server/main.go', `package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }`);
        expect(classifyServiceRole(dir, getLanguagePlugin('go'))).toBe('runtime');
    });

    it('main.go in dir root with http.ListenAndServe → runtime', () => {
        touch(dir, 'go.mod', 'module acme/orders\n');
        touch(dir, 'main.go', `package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }`);
        expect(classifyServiceRole(dir, getLanguagePlugin('go'))).toBe('runtime');
    });

    it('pure pkg with go.mod and exported funcs only → undefined', () => {
        touch(dir, 'go.mod', 'module acme/orders/orders-domain\n');
        touch(dir, 'orders.go', `package orders\nfunc BuildOrder() string { return "ok" }`);
        expect(classifyServiceRole(dir, getLanguagePlugin('go'))).toBeUndefined();
    });
});
