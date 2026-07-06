import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getNeo4jSession, closeNeo4j, initSchema } from '../../src/graph/neo4j.js';
import { discoverMessageClassRegistry, weldMessagePublishersByClass } from '../../src/graph/mutations/message-channels.js';
import { clearRepoHintsCache } from '../../src/config/repo-hints.js';

// ═════════════════════════════════════════════════════════════════════════════
// Fix B (v8) — class_routes YAML override
//
// When `coderadius.yaml.message_channels.class_routes` declares a CQRS class
// mapping, it wins over the PHP extractor (the customer knows the routing
// key better than any heuristic). Covers the case where:
//   - PHP extractor cannot resolve the routing key (dynamic loader, cross-
//     class constant, etc.).
//   - PHP extractor returns a DIFFERENT routing key than what the customer
//     actually deploys (e.g. environment-specific suffix not visible to AST).
// ═════════════════════════════════════════════════════════════════════════════

describe('discoverMessageClassRegistry + class_routes YAML override', () => {
    let repoRoot: string;

    function writeFixture(yamlContent: string, phpFiles: Array<{ rel: string; body: string }>): void {
        if (fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.mkdirSync(repoRoot, { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'coderadius.yaml'), yamlContent, 'utf-8');
        for (const f of phpFiles) {
            const abs = path.join(repoRoot, f.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.body, 'utf-8');
        }
    }

    beforeAll(async () => { await initSchema({ silent: true }); });

    beforeEach(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'class-routes-'));
        clearRepoHintsCache();
    });

    afterAll(async () => {
        if (repoRoot && fs.existsSync(repoRoot)) fs.rmSync(repoRoot, { recursive: true, force: true });
        await closeNeo4j();
    });

    it('YAML override fills the registry when PHP has no extractable routing key', () => {
        // PHP routing config uses an unresolvable dynamic loader → extractor returns nothing.
        writeFixture(
            `message_channels:
  class_routes:
    - class: NotPurchasableEvent
      routing_key: acme.inventory.events.not-purchasable
`,
            [{
                rel: 'src/Messaging/AmqpConfig.php',
                body: `<?php
namespace Acme\\Messaging;
class AmqpConfig {
    public function getMessageMap(): array {
        return DynamicLoader::loadRouting();
    }
}`,
            }],
        );
        const registry = discoverMessageClassRegistry([repoRoot]);
        expect(registry.get('NotPurchasableEvent')).toBe('acme.inventory.events.not-purchasable');
    });

    it('YAML override WINS over PHP extraction when both produce a value (customer authoritative)', () => {
        // PHP says one thing; YAML overrides to a different value.
        writeFixture(
            `message_channels:
  class_routes:
    - class: OrderPlacedEvent
      routing_key: acme.inventory.order.canonical
`,
            [{
                rel: 'src/Messaging/AmqpConfig.php',
                body: `<?php
namespace Acme\\Messaging;
class AmqpConfig {
    public function getMessageMap(): array {
        return [
            OrderPlacedEvent::class => [
                'routing_key' => 'acme.inventory.order.from_php',
            ],
        ];
    }
}`,
            }],
        );
        const registry = discoverMessageClassRegistry([repoRoot]);
        expect(registry.get('OrderPlacedEvent')).toBe('acme.inventory.order.canonical');
    });

    it('Empty class_routes leaves PHP extraction untouched', () => {
        writeFixture(
            `# no class_routes declared
decorators: []
`,
            [{
                rel: 'src/Messaging/AmqpConfig.php',
                body: `<?php
namespace Acme\\Messaging;
class AmqpConfig {
    public function getMessageMap(): array {
        return [
            ShipmentReadyEvent::class => [
                'routing_key' => 'acme.shipping.ready',
            ],
        ];
    }
}`,
            }],
        );
        const registry = discoverMessageClassRegistry([repoRoot]);
        expect(registry.get('ShipmentReadyEvent')).toBe('acme.shipping.ready');
    });
});
