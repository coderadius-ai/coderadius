import { describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { TypeScriptPlugin } from '../../../../../src/ingestion/core/languages/typescript';
import { PHPPlugin } from '../../../../../src/ingestion/core/languages/php';
import { PythonPlugin } from '../../../../../src/ingestion/core/languages/python';
import { GoPlugin } from '../../../../../src/ingestion/core/languages/go';
import type { LanguagePlugin } from '../../../../../src/ingestion/core/languages/types';

// ─── Helper ─────────────────────────────────────────────────────────────────
//
// Tests each plugin's `scopeExclusions` array directly through the same
// gitignore-style matcher that ScopeManager wires up (`ignore` npm package).
// This decouples the per-plugin contract from ScopeManager's universal layer
// and from .gitignore/.crignore: if a wiring refactor drops a plugin, the
// ScopeManager integration test catches it; if a plugin loses a pattern from
// its own array, the assertion here catches it.

function pluginExcludes(plugin: LanguagePlugin, relativePath: string): boolean {
    return ignore().add([...plugin.scopeExclusions]).ignores(relativePath);
}

// ═════════════════════════════════════════════════════════════════════════════
// PHP plugin
// ═════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin.scopeExclusions', () => {
    const plugin = new PHPPlugin();

    describe('database migrations', () => {
        it('excludes Doctrine Migrations/Version*.php (namespace convention)', () => {
            expect(pluginExcludes(plugin, 'src/Application/Migrations/Version20240115120000.php')).toBe(true);
            expect(pluginExcludes(plugin, 'app/Migrations/Version20251110155839.php')).toBe(true);
        });

        it('excludes Doctrine lowercase migrations/Version*.php variant', () => {
            expect(pluginExcludes(plugin, 'src/migrations/Version20240115120000.php')).toBe(true);
        });

        it('excludes Laravel database/migrations/*.php (named + timestamped)', () => {
            expect(pluginExcludes(plugin, 'database/migrations/create_users_table.php')).toBe(true);
            expect(pluginExcludes(plugin, 'database/migrations/2024_01_15_120000_create_users_table.php')).toBe(true);
        });

        it('excludes generic db/migrations/*.php', () => {
            expect(pluginExcludes(plugin, 'db/migrations/001_init.php')).toBe(true);
        });

        it('does NOT exclude a service folder named "migration-service"', () => {
            // Regression guard: per-framework patterns must not accidentally
            // shadow real service directories that carry `migration` in the
            // name.
            expect(pluginExcludes(plugin, 'src/services/migration-service/index.php')).toBe(false);
        });
    });

    describe('framework conventions already in place', () => {
        // Anchor a few non-migration patterns so the plugin contract is
        // pinned end-to-end, not only on the migration patch.
        it('excludes Symfony bundle public assets', () => {
            expect(pluginExcludes(plugin, 'src/Acme/FooBundle/Resources/public/js/widget.js')).toBe(true);
        });
        it('excludes PHPUnit test files by filename', () => {
            expect(pluginExcludes(plugin, 'src/SomeServiceTest.php')).toBe(true);
        });
        it('excludes vendored dependencies', () => {
            expect(pluginExcludes(plugin, 'vendor/symfony/messenger/Foo.php')).toBe(true);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// TypeScript plugin
// ═════════════════════════════════════════════════════════════════════════════

describe('TypeScriptPlugin.scopeExclusions', () => {
    const plugin = new TypeScriptPlugin();

    describe('database migrations', () => {
        it('excludes the full Prisma migration tree', () => {
            expect(pluginExcludes(plugin, 'prisma/migrations/20240115120000_init/migration.sql')).toBe(true);
            expect(pluginExcludes(plugin, 'prisma/migrations/migration_lock.toml')).toBe(true);
        });

        it('excludes Knex/TypeORM/Sequelize timestamped migrations (underscore)', () => {
            expect(pluginExcludes(plugin, 'migrations/20240115120000_create_orders.ts')).toBe(true);
            expect(pluginExcludes(plugin, 'migrations/20240115120000_create_orders.js')).toBe(true);
            expect(pluginExcludes(plugin, 'migrations/20240115120000_create_orders.mjs')).toBe(true);
        });

        it('excludes Sequelize timestamped migrations (hyphen variant)', () => {
            expect(pluginExcludes(plugin, 'migrations/20240115120000-create-orders.ts')).toBe(true);
        });

        it('excludes generic db/migrations/*.ts', () => {
            expect(pluginExcludes(plugin, 'db/migrations/001_init.ts')).toBe(true);
        });

        it('excludes typeorm-migrations/ explicit layout', () => {
            expect(pluginExcludes(plugin, 'src/typeorm-migrations/1700000000000-Init.ts')).toBe(true);
        });

        it('does NOT exclude a service folder named "migration-service"', () => {
            expect(pluginExcludes(plugin, 'src/services/migration-service/index.ts')).toBe(false);
        });
    });

    describe('framework conventions already in place', () => {
        it('excludes *.test.ts and *.spec.ts test files', () => {
            expect(pluginExcludes(plugin, 'src/foo.test.ts')).toBe(true);
            expect(pluginExcludes(plugin, 'src/foo.spec.tsx')).toBe(true);
        });
        it('excludes Next.js .next/ build output', () => {
            expect(pluginExcludes(plugin, '.next/server/pages/index.js')).toBe(true);
        });
        it('excludes node_modules', () => {
            expect(pluginExcludes(plugin, 'node_modules/lodash/index.js')).toBe(true);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Python plugin
// ═════════════════════════════════════════════════════════════════════════════

describe('PythonPlugin.scopeExclusions', () => {
    const plugin = new PythonPlugin();

    describe('database migrations', () => {
        it('excludes Alembic versions/*.py', () => {
            expect(pluginExcludes(plugin, 'alembic/versions/a1b2c3d4_init.py')).toBe(true);
            expect(pluginExcludes(plugin, 'db/alembic/versions/a1b2c3d4_init.py')).toBe(true);
        });

        it('excludes Django auto-numbered migrations (NNNN_name.py)', () => {
            expect(pluginExcludes(plugin, 'apps/orders/migrations/0001_initial.py')).toBe(true);
            expect(pluginExcludes(plugin, 'apps/orders/migrations/0042_add_status.py')).toBe(true);
        });

        it('does NOT exclude a service folder named "migration-service"', () => {
            expect(pluginExcludes(plugin, 'src/services/migration-service/__init__.py')).toBe(false);
        });

        it('does NOT exclude a non-numbered file under migrations/', () => {
            // Django migration filenames always start with 4 digits; a hand-
            // written helper module under `migrations/` (e.g. `helpers.py`)
            // is real code and should stay analysed.
            expect(pluginExcludes(plugin, 'apps/orders/migrations/helpers.py')).toBe(false);
        });
    });

    describe('framework conventions already in place', () => {
        it('excludes test_*.py and *_test.py', () => {
            expect(pluginExcludes(plugin, 'tests/test_foo.py')).toBe(true);
            expect(pluginExcludes(plugin, 'tests/foo_test.py')).toBe(true);
        });
        it('excludes __pycache__/', () => {
            expect(pluginExcludes(plugin, 'src/__pycache__/foo.cpython-311.pyc')).toBe(true);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Go plugin
// ═════════════════════════════════════════════════════════════════════════════

describe('GoPlugin.scopeExclusions', () => {
    const plugin = new GoPlugin();

    describe('database migrations', () => {
        it('excludes golang-migrate paired SQL files', () => {
            expect(pluginExcludes(plugin, 'migrations/000001_init.up.sql')).toBe(true);
            expect(pluginExcludes(plugin, 'migrations/000001_init.down.sql')).toBe(true);
        });

        it('excludes golang-migrate paired Go files', () => {
            expect(pluginExcludes(plugin, 'migrations/000001_init.up.go')).toBe(true);
            expect(pluginExcludes(plugin, 'migrations/000001_init.down.go')).toBe(true);
        });

        it('excludes generic db/migrations/*.{go,sql}', () => {
            expect(pluginExcludes(plugin, 'db/migrations/001_init.go')).toBe(true);
            expect(pluginExcludes(plugin, 'db/migrations/001_init.sql')).toBe(true);
        });

        it('does NOT exclude a service folder named "migration-service"', () => {
            expect(pluginExcludes(plugin, 'cmd/migration-service/main.go')).toBe(false);
        });
    });

    describe('framework conventions already in place', () => {
        it('excludes *_test.go files', () => {
            expect(pluginExcludes(plugin, 'pkg/orders/orders_test.go')).toBe(true);
        });
        it('excludes vendor/', () => {
            expect(pluginExcludes(plugin, 'vendor/github.com/foo/bar.go')).toBe(true);
        });
        it('excludes generated *.pb.go', () => {
            expect(pluginExcludes(plugin, 'gen/pb/orders.pb.go')).toBe(true);
        });
    });
});
