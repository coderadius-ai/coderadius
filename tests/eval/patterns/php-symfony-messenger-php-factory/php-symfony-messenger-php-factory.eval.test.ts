import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { symfonyMessengerPlugin } from '../../../../src/ingestion/structural/plugins/messaging/symfony-messenger.plugin.js';
import type { PluginContext, StructuralEntity } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import { clearMessageBrokerRegistry } from '../../../../src/ingestion/core/messaging/broker-registry.js';

// ═════════════════════════════════════════════════════════════════════════════
// Pattern test (deterministic, no LLM) — php-symfony-messenger-php-factory
//
// Pins structural extraction for an application that uses symfony/messenger
// BUT configures it through a PHP-factory class (no `config/packages/
// messenger.yaml`). This is the shape observed in real-world legacy/non-
// framework setups: a class with `getMessageMap(): array` returning
//
//   [MessageClass::class => ['queue_name' => 'a.b.c', 'routing_key' => '...']]
//
// The plugin MUST recognise the .php file via MESSAGING_FILE_SIGNALS gate
// and emit the same structural shape as the YAML path:
//   - 1 MessageBroker{provider:'symfony-messenger'} per repo
//   - 1 MessageChannel{scope:'transport'} per queue_name
//   - 1 MessageChannel{scope:'logical'} per MessageClass FQCN
//   - MANIFESTS_AS edges logical → transport
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');
const REPO_NAME = 'acme/inventory-service';

function makeContext(relativePath: string, absolutePath: string): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName: REPO_NAME,
        repoUrn: `cr:repository:${REPO_NAME}`,
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

describe('Pattern Eval — php-symfony-messenger-php-factory', () => {
    let allEntities: StructuralEntity[] = [];

    beforeAll(() => {
        clearMessageBrokerRegistry();

        const phpRel = 'src/Messaging/MessageMap.php';
        const phpAbs = path.join(FIXTURE_DIR, phpRel);
        const phpContent = fs.readFileSync(phpAbs, 'utf-8');

        expect(symfonyMessengerPlugin.matchFile(phpRel, 'MessageMap.php')).toBe(true);

        const result = symfonyMessengerPlugin.extract(
            phpContent,
            makeContext(phpRel, phpAbs),
        );
        allEntities = result.entities;
    });

    afterAll(() => {
        clearMessageBrokerRegistry();
        allEntities = [];
    });

    it('emits a Symfony Messenger meta-broker for the repo', () => {
        const brokers = allEntities.filter(e => e.labels.includes('MessageBroker'));
        const symfonyBrokers = brokers.filter(b => b.properties.provider === 'symfony-messenger');
        expect(symfonyBrokers).toHaveLength(1);
        const meta = symfonyBrokers[0];
        expect(meta.properties.host).toBe(REPO_NAME);
        expect(meta.id).toMatch(/^cr:broker:symfony-messenger:[0-9a-f]+$/);
    });

    it('emits 1 transport channel per queue_name entry', () => {
        const transports = allEntities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'transport');
        const names = transports.map(t => t.properties.name).sort();
        // Note: OrderShipped uses env-var concat `acme.inventory{environment}.order.shipped`
        // which the extractor normalises by stripping the `{environment}` placeholder.
        expect(names).toEqual([
            'acme.inventory.order.placed',
            'acme.inventory.order.shipped',
        ]);
        for (const t of transports) {
            expect(t.properties.technology).toBe('symfony-messenger');
            expect(t.properties.brokerUrn).toMatch(/^cr:broker:symfony-messenger:/);
        }
    });

    it('emits 1 logical channel per routed MessageClass FQCN', () => {
        const logicals = allEntities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'logical');
        const names = logicals.map(l => l.properties.name).sort();
        // FQCN-keyed logical channels mirror the YAML plugin behaviour.
        expect(names).toEqual([
            'Acme\\Inventory\\Messaging\\Message\\OrderPlacedMessage',
            'Acme\\Inventory\\Messaging\\Message\\OrderShippedMessage',
        ]);
        for (const l of logicals) {
            expect(l.properties.channelKind).toBe('topic');
            expect(l.properties.technology).toBe('symfony-messenger');
        }
    });

    it('emits MANIFESTS_AS edges from each logical channel to its transport', () => {
        const logicalOrderPlaced = allEntities.find(e =>
            e.labels.includes('MessageChannel')
            && e.properties.scope === 'logical'
            && (e.properties.name as string).endsWith('OrderPlacedMessage'));
        expect(logicalOrderPlaced).toBeDefined();
        const manifests = logicalOrderPlaced!.edges?.filter(e =>
            e.type === 'MANIFESTS_AS' && e.targetUrn.startsWith('cr:channel:transport:')) ?? [];
        expect(manifests).toHaveLength(1);
        expect(manifests[0].targetUrn).toBe('cr:channel:transport:acme.inventory.order.placed');
    });
});
