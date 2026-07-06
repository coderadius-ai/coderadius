import { describe, it, expect } from 'vitest';
import { doctrineMigrationsPlugin } from '../../../../src/ingestion/structural/plugins/doctrine-migrations.plugin.js';
import type { PluginContext } from '../../../../src/ingestion/structural/types.js';

const ctx: PluginContext = {
    relativePath: 'data/Migrations/Version20240101120000.php',
    absolutePath: '/tmp/fake/data/Migrations/Version20240101120000.php',
    repoName: 'acme/orders',
    repoUrn: 'cr:repository:acme/orders',
    scopeManager: {} as never,
};

const MIGRATION = `<?php
declare(strict_types=1);

namespace AcmeMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20240101120000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE acme_orders (id INT AUTO_INCREMENT NOT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE TABLE IF NOT EXISTS \`acme_order_items\` (id INT NOT NULL)');
        $this->addSql('ALTER TABLE acme_payments ADD COLUMN status VARCHAR(32)');
        $this->addSql("RENAME TABLE acme_tmp TO acme_shipments");
        $this->addSql('DROP TABLE acme_legacy_only');
        $this->addSql('CREATE INDEX idx_x ON acme_orders (id)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE acme_orders');
    }
}
`;

describe('doctrineMigrationsPlugin.matchFile', () => {
    it('matches Version*.php under a Migrations dir', () => {
        expect(doctrineMigrationsPlugin.matchFile(
            'data/Migrations/Version20240101120000.php', 'Version20240101120000.php')).toBe(true);
        expect(doctrineMigrationsPlugin.matchFile(
            'db/migrations/Version20211231235959.php', 'Version20211231235959.php')).toBe(true);
    });
    it('ignores non-migration php', () => {
        expect(doctrineMigrationsPlugin.matchFile('src/Service/OrderService.php', 'OrderService.php')).toBe(false);
    });
});

describe('doctrineMigrationsPlugin.extract', () => {
    const result = doctrineMigrationsPlugin.extract(MIGRATION, ctx);
    const containers = result.entities.filter((e) => e.labels.includes('DataContainer'));
    const names = containers.map((e) => e.properties.name as string).sort();

    it('emits DataContainers for CREATE / ALTER / RENAME-target tables', () => {
        expect(names).toEqual(['acme_order_items', 'acme_orders', 'acme_payments', 'acme_shipments']);
    });

    it('never emits drop-only tables or index names', () => {
        expect(names).not.toContain('acme_legacy_only');
        expect(names).not.toContain('acme_tmp');
        expect(names).not.toContain('idx_x');
    });

    it('uses the canonical datacontainer URN + repo scope + DEFINES provenance', () => {
        const orders = containers.find((e) => e.properties.name === 'acme_orders')!;
        expect(orders.id).toBe('cr:datacontainer:acme/orders:acme_orders');
        expect(orders.properties.scope).toBe('acme/orders');
        expect(orders.relationshipType).toBe('DEFINES');
        expect(orders.properties.evidence_extractors).toEqual(['doctrine-migrations@v1']);
    });

    it('carries _sourcePath so the StructuralFile DEFINES edge can form (orphan-GC liveness)', () => {
        for (const c of containers) {
            expect(c.properties._sourcePath).toBe('data/Migrations/Version20240101120000.php');
        }
    });

    it('dedupes a table touched by multiple statements', () => {
        expect(containers.filter((e) => e.properties.name === 'acme_orders')).toHaveLength(1);
    });

    it('multiline addSql strings are parsed (real-world DDL spans lines)', () => {
        const multiline = MIGRATION.replace(
            "$this->addSql('CREATE TABLE acme_orders (id INT AUTO_INCREMENT NOT NULL, PRIMARY KEY(id))');",
            '$this->addSql("CREATE TABLE \`acme_multiline\` (\n  id INT NOT NULL,\n  PRIMARY KEY(id)\n)");',
        );
        const r = doctrineMigrationsPlugin.extract(multiline, ctx);
        expect(r.entities.some((e) => e.properties.name === 'acme_multiline')).toBe(true);
    });

    it('heredoc-assigned SQL is scanned (addSql($sql) with <<<SQL bodies)', () => {
        const heredoc = `<?php
use Doctrine\\Migrations\\AbstractMigration;
final class Version20240202000000 extends AbstractMigration
{
    public function up($schema): void
    {
        $sql = <<<TEXTSQL
CREATE TABLE acme_tokens (id INT NOT NULL, PRIMARY KEY(id));
CREATE TABLE acme_tokens_to_scope (a INT, b INT);
ALTER TABLE acme_grants ADD COLUMN x INT;
TEXTSQL;
        $this->addSql($sql);
    }
}`;
        const r = doctrineMigrationsPlugin.extract(heredoc, ctx);
        const names = r.entities.map((e) => e.properties.name as string).sort();
        expect(names).toEqual(['acme_grants', 'acme_tokens', 'acme_tokens_to_scope']);
    });

    it('content signatures gate on the published doctrine/migrations API', () => {
        const sigs = doctrineMigrationsPlugin.contentSignatures!;
        expect(sigs.some((s) => s.test(MIGRATION))).toBe(true);
        expect(sigs.some((s) => s.test('<?php class Foo { function up() {} }'))).toBe(false);
    });
});
