import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';

function makeFile(repoRoot: string, relPath: string, content: string): string {
    const abs = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
}

describe('ScopeManager', () => {
    let repoRoot: string;
    let scope: ScopeManager;

    beforeEach(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scope-test-'));
        scope = new ScopeManager(repoRoot);
    });
    afterEach(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    // ─── Universal directory exclusions ─────────────────────────────────────

    test('omits tests/ at repo root', () => {
        const f = makeFile(repoRoot, 'tests/unit/foo.ts', 'const a = 1;\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits Tests/ (capitalised, PHP/Symfony) at repo root', () => {
        const f = makeFile(repoRoot, 'Tests/Foo.php', '<?php\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits e2e/, cypress/, playwright/ at repo root', () => {
        const a = makeFile(repoRoot, 'e2e/spec.ts', 'x\n');
        const b = makeFile(repoRoot, 'cypress/foo.cy.ts', 'x\n');
        const c = makeFile(repoRoot, 'playwright/test.spec.ts', 'x\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
        expect(scope.isOmitted(c, repoRoot)).toBe(true);
    });

    test('omits __tests__/, __mocks__/, __fixtures__/', () => {
        const a = makeFile(repoRoot, 'src/__tests__/foo.test.ts', 'x\n');
        const b = makeFile(repoRoot, 'src/__mocks__/foo.ts', 'x\n');
        const c = makeFile(repoRoot, 'src/__fixtures__/data.ts', 'x\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
        expect(scope.isOmitted(c, repoRoot)).toBe(true);
    });

    test('does NOT omit src/ production code', () => {
        const f = makeFile(repoRoot, 'src/services/orders.ts', 'export const x = 1;\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });

    // ─── Relative-path semantics (replaces the (?!fixtures/) carve-out) ─────

    test('fixture root passed as repo.path: inner src/ files not omitted', () => {
        // Simulates the integration-test setup that points repo.path at
        // tests/fixtures/microservices/<svc>. The relative-to-repo path begins
        // at `src/...` and never includes a leading `tests/` segment, so the
        // universal `tests/**` pattern must not trigger.
        const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'microservices', 'order-service');
        const inner = makeFile(fixtureRoot, 'src/handlers/OrderCreated.php', '<?php\n');
        const innerScope = new ScopeManager(fixtureRoot);
        expect(innerScope.isOmitted(inner, fixtureRoot)).toBe(false);
    });

    // ─── Plugin-contributed exclusions ──────────────────────────────────────

    test('omits Symfony bundle public assets (PHP plugin Resources/public/**)', () => {
        const f = makeFile(
            repoRoot,
            'src/Acme/FooBundle/Resources/public/js/charts/amcharts.js',
            'console.log(1);\n',
        );
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits Symfony var/cache and var/log (PHP plugin)', () => {
        const a = makeFile(repoRoot, 'var/cache/prod/something.php', '<?php\n');
        const b = makeFile(repoRoot, 'var/log/whatever.log.php', '<?php\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits Laravel storage/framework (PHP plugin)', () => {
        const f = makeFile(repoRoot, 'storage/framework/views/abc.blade.php', '<?php\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits Next.js .next/ build (TS plugin)', () => {
        const f = makeFile(repoRoot, '.next/server/pages/index.js', 'x\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits Nuxt .nuxt/ and Vite .vite/ caches (TS plugin)', () => {
        const a = makeFile(repoRoot, '.nuxt/dev/index.mjs', 'x\n');
        const b = makeFile(repoRoot, '.vite/deps.json', '{}\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits Storybook static output (TS plugin)', () => {
        const f = makeFile(repoRoot, 'storybook-static/iframe.html', '<html>\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits pytest .pytest_cache and mypy .mypy_cache (Python plugin)', () => {
        const a = makeFile(repoRoot, '.pytest_cache/v/cache/lastfailed', '{}\n');
        const b = makeFile(repoRoot, '.mypy_cache/3.11/foo.json', '{}\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits Go bin/ build dir (Go plugin)', () => {
        const f = makeFile(repoRoot, 'bin/server', '#!/bin/sh\n');
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    // ─── Database migration exclusions (per-framework, plugin-driven) ───────
    //
    // Trace evidence on the acme-legacy2 PHP/Symfony monorepo showed about
    // 6 to 10 minutes per analyze run spent on Doctrine migration up()/down()
    // methods, all subsequently rejected by the Sanitizer as `"no valid
    // evidence in source code"`. Migration paths are framework-shaped and
    // public, so each language plugin's `scopeExclusions` is the right level
    // for them (NOT a universal `**/migrations/**` in ScopeManager, which
    // would over-match real service names containing `migration`).

    test('omits Doctrine Migrations/Version*.php (PHP plugin)', () => {
        const a = makeFile(repoRoot, 'src/Application/Migrations/Version20240115120000.php', '<?php\n');
        const b = makeFile(repoRoot, 'app/Migrations/Version20251110155839.php', '<?php\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits Laravel database/migrations timestamped files (PHP plugin)', () => {
        const f = makeFile(
            repoRoot,
            'database/migrations/2024_01_15_120000_create_users_table.php',
            '<?php\n',
        );
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits Prisma migration tree (TypeScript plugin)', () => {
        const sql = makeFile(repoRoot, 'prisma/migrations/20240115120000_init/migration.sql', '-- noop\n');
        const meta = makeFile(repoRoot, 'prisma/migrations/migration_lock.toml', 'provider = "x"\n');
        expect(scope.isOmitted(sql, repoRoot)).toBe(true);
        expect(scope.isOmitted(meta, repoRoot)).toBe(true);
    });

    test('omits Knex/TypeORM/Sequelize timestamped TS migrations (TypeScript plugin)', () => {
        const a = makeFile(repoRoot, 'migrations/20240115120000_create_orders.ts', 'export {}\n');
        const b = makeFile(repoRoot, 'db/migrations/20240115120000_create_orders.js', 'module.exports = {}\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits Alembic and Django migrations (Python plugin)', () => {
        const alembic = makeFile(repoRoot, 'alembic/versions/a1b2c3d4_init.py', '"""init"""\n');
        const django = makeFile(repoRoot, 'apps/orders/migrations/0001_initial.py', '# noop\n');
        expect(scope.isOmitted(alembic, repoRoot)).toBe(true);
        expect(scope.isOmitted(django, repoRoot)).toBe(true);
    });

    test('omits golang-migrate paired sql files (Go plugin)', () => {
        const up = makeFile(repoRoot, 'migrations/000001_init.up.sql', 'CREATE TABLE x();\n');
        const down = makeFile(repoRoot, 'migrations/000001_init.down.sql', 'DROP TABLE x;\n');
        expect(scope.isOmitted(up, repoRoot)).toBe(true);
        expect(scope.isOmitted(down, repoRoot)).toBe(true);
    });

    test('does NOT omit a service folder named "migration-service" (regression guard)', () => {
        // If a future maintainer is tempted to bypass per-framework patterns
        // with a universal `**/migrations/**`, this test fails. Real-world
        // services occasionally carry `migration` in their name without being
        // a DB migration directory.
        const f = makeFile(
            repoRoot,
            'src/services/migration-service/index.ts',
            'export const x = 1;\n',
        );
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });

    // ─── Minified / generic asset exclusions ────────────────────────────────

    test('omits *.min.js, *.min.css across all roots', () => {
        const a = makeFile(repoRoot, 'public/js/jquery.min.js', '!function(){}();\n');
        const b = makeFile(repoRoot, 'assets/styles.min.css', '.x{}\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    test('omits *.js.map, *.css.map source maps', () => {
        const a = makeFile(repoRoot, 'dist/bundle.js.map', '{"version":3}\n');
        const b = makeFile(repoRoot, 'dist/styles.css.map', '{"version":3}\n');
        expect(scope.isOmitted(a, repoRoot)).toBe(true);
        expect(scope.isOmitted(b, repoRoot)).toBe(true);
    });

    // ─── Tier 3 heuristic: size and minification ────────────────────────────

    test('omits files > 300KB by size', () => {
        // 350KB of valid-ish source
        const big = 'const x = 1;\n'.repeat(28000);
        const f = makeFile(repoRoot, 'src/huge.ts', big);
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('omits amcharts-style minified file (long lines, sparse newlines)', () => {
        // Simulate amcharts.js: ~5KB license header followed by a 5KB single
        // line of minified payload. ScopeManager reads the first 10KB and
        // measures chars-per-newline; this sample averages ~500 chars/line.
        const header = '// License header\n'.repeat(20); // ~360 bytes, ~20 newlines
        const payload = 'a'.repeat(9700); // ~9700 chars on a single line
        const content = header + payload + '\n';
        const f = makeFile(repoRoot, 'src/vendored.js', content);
        expect(scope.isOmitted(f, repoRoot)).toBe(true);
    });

    test('does NOT omit normal source code with ~60 chars/line', () => {
        const line = 'export const foo = "this is a normal-ish line of code";\n';
        const content = line.repeat(150); // ~9KB
        const f = makeFile(repoRoot, 'src/regular.ts', content);
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });

    test('does NOT omit source with heavy non-ASCII (Italian accents)', () => {
        // Comment line with several multi-byte UTF-8 chars per line.
        // Each `è`, `é`, `à` is 2 bytes; line is ~70 visible chars / ~95 bytes.
        const line = '// però adesso è già qui, perché così va proprio bene.\n';
        const content = line.repeat(120); // ~6KB content, ~120 newlines
        const f = makeFile(repoRoot, 'src/italian.ts', content);
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });

    test('does NOT omit source with heavy CJK comments', () => {
        // Japanese chars are 3 bytes each in UTF-8. A 30-char Japanese line
        // is 90 bytes; bytes-per-newline would be 90 (under 200), but the
        // new chars-per-newline metric correctly sees ~30 chars/line.
        const line = '// テスト関数: 注文をデータベースに保存します。\n';
        const content = line.repeat(120); // ~10KB
        const f = makeFile(repoRoot, 'src/japanese.ts', content);
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });

    test('does NOT omit source with heavy emoji content (4-byte UTF-8)', () => {
        // Each 😀 is 4 bytes in UTF-8 and 2 UTF-16 code units in chunk.length.
        // 20 emoji + short prefix = ~60 chars per line, still far below 300.
        const line = '// 😀😀😀😀😀😀😀😀😀😀: stato ordine creato\n';
        const content = line.repeat(120);
        const f = makeFile(repoRoot, 'src/emoji.ts', content);
        expect(scope.isOmitted(f, repoRoot)).toBe(false);
    });
});
