import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { rabbitmqConfigPlugin } from '../../../../src/ingestion/structural/plugins/messaging/rabbitmq-config.plugin.js';
import { symfonyMessengerPlugin } from '../../../../src/ingestion/structural/plugins/messaging/symfony-messenger.plugin.js';
import type { PluginContext, StructuralEntity } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';
import {
    clearMessageBrokerRegistry,
    registerBrokerDeclaration,
} from '../../../../src/ingestion/core/messaging/broker-registry.js';
import { RepoHintsSchema } from '../../../../src/config/repo-hints.js';

// ═════════════════════════════════════════════════════════════════════════════
// Pattern test (deterministic, no LLM) — rabbitmq-messenger-routing
//
// Pins the end-to-end structural extraction for a single broker:
//   1. customer-declared messageBrokers[] in coderadius.yaml
//   2. RabbitMQ definitions.json → MessageBroker + exchanges/queues + ROUTES_TO
//      with pattern (`acme.order.#`) + exact (`acme.order.created`)
//   3. Symfony Messenger messenger.yaml → meta-broker + transports + logical
//      MANIFESTS_AS edges per MessageClass routed
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

function makeContext(relativePath: string, absolutePath: string, repoName: string): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName,
        repoUrn: `cr:repository:${repoName}`,
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

describe('Pattern Eval — rabbitmq-messenger-routing', () => {
    let allEntities: StructuralEntity[] = [];

    beforeAll(() => {
        clearMessageBrokerRegistry();

        // 1. Load coderadius.yaml customer declarations
        const yamlContent = fs.readFileSync(path.join(FIXTURE_DIR, 'coderadius.yaml'), 'utf-8');
        const hints = RepoHintsSchema.parse(yaml.load(yamlContent));
        for (const broker of hints.messageBrokers ?? []) {
            registerBrokerDeclaration(broker);
        }

        // 2. RabbitMQ plugin
        const defsRel = 'rabbitmq/definitions.json';
        const defsAbs = path.join(FIXTURE_DIR, defsRel);
        const defsContent = fs.readFileSync(defsAbs, 'utf-8');
        expect(rabbitmqConfigPlugin.matchFile(defsRel, 'definitions.json')).toBe(true);
        allEntities.push(...rabbitmqConfigPlugin.extract(
            defsContent,
            makeContext(defsRel, defsAbs, 'acme/order-svc'),
        ).entities);

        // 3. Symfony Messenger plugin
        const msgrRel = 'config/packages/messenger.yaml';
        const msgrAbs = path.join(FIXTURE_DIR, msgrRel);
        const msgrContent = fs.readFileSync(msgrAbs, 'utf-8');
        expect(symfonyMessengerPlugin.matchFile(msgrRel, 'messenger.yaml')).toBe(true);
        allEntities.push(...symfonyMessengerPlugin.extract(
            msgrContent,
            makeContext(msgrRel, msgrAbs, 'acme/order-svc'),
        ).entities);
    });

    afterAll(() => {
        clearMessageBrokerRegistry();
        allEntities = [];
    });

    it('emits 2 distinct MessageBroker nodes (rabbitmq + symfony-messenger)', () => {
        // The plugin manager MERGEs structural entities by URN; both the RabbitMQ
        // plugin and the Symfony Messenger plugin emit the same RabbitMQ broker
        // entity (same fingerprint → same URN). Dedup by id to mirror that.
        const brokers = Array.from(new Map(
            allEntities.filter(e => e.labels.includes('MessageBroker')).map(e => [e.id, e]),
        ).values());
        expect(brokers).toHaveLength(2);
        expect(brokers.some(b => b.properties.provider === 'rabbitmq')).toBe(true);
        expect(brokers.some(b => b.properties.provider === 'symfony-messenger')).toBe(true);
    });

    it('honors customer-declared broker (declaredVia=coderadius.yaml, confidence=1.0)', () => {
        const rabbitBroker = allEntities.find(e =>
            e.labels.includes('MessageBroker') && e.properties.provider === 'rabbitmq')!;
        expect(rabbitBroker.properties.declaredVia).toBe('coderadius.yaml');
        expect(rabbitBroker.properties.confidence).toBe(1.0);
        expect(rabbitBroker.properties.host).toBe('rmq.example.com');
        expect(rabbitBroker.properties.env).toBe('prod');
    });

    it('emits physical exchange and queue channels with brokerUrn', () => {
        const channels = allEntities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'physical');
        // Two exchanges + two queues (the inventory and payment queues from definitions
        // + the queue created by the Symfony transport `inventory`).
        expect(channels.length).toBeGreaterThanOrEqual(4);
        for (const ch of channels) {
            expect(ch.properties.brokerUrn).toBeTruthy();
        }
        const ordersExchange = channels.find(c => c.properties.name === 'acme.orders');
        expect(ordersExchange).toBeDefined();
        expect(ordersExchange!.properties.channelKind).toBe('topic');
    });

    it('emits ROUTES_TO with isPattern=true for `acme.order.#`', () => {
        const ordersExchange = allEntities.find(e =>
            e.labels.includes('MessageChannel') && e.properties.name === 'acme.orders')!;
        const routes = ordersExchange.edges?.filter(e => e.type === 'ROUTES_TO') ?? [];
        expect(routes).toHaveLength(2);
        const pattern = routes.find(r => r.properties?.bindingKey === 'acme.order.#');
        expect(pattern).toBeDefined();
        expect(pattern!.properties!.isPattern).toBe(true);
        const re = new RegExp(pattern!.properties!.patternRegex as string);
        expect(re.test('acme.order.created')).toBe(true);
        expect(re.test('acme.invoice.paid')).toBe(false);
    });

    it('emits ROUTES_TO with isPattern=false for the exact binding', () => {
        const ordersExchange = allEntities.find(e =>
            e.labels.includes('MessageChannel') && e.properties.name === 'acme.orders')!;
        const routes = ordersExchange.edges?.filter(e => e.type === 'ROUTES_TO') ?? [];
        const exact = routes.find(r => r.properties?.bindingKey === 'acme.order.created');
        expect(exact).toBeDefined();
        expect(exact!.properties!.isPattern).toBe(false);
    });

    it('emits Symfony Messenger transport channels with BACKED_BY edges', () => {
        const inventoryTransport = allEntities.find(e =>
            e.labels.includes('MessageChannel')
            && e.properties.name === 'inventory'
            && e.properties.scope === 'transport')!;
        expect(inventoryTransport).toBeDefined();
        const backedBy = inventoryTransport.edges?.find(e => e.type === 'BACKED_BY');
        expect(backedBy).toBeDefined();
        expect(backedBy!.targetUrn).toContain('cr:channel:queue:inventory@');
    });

    it('emits LogicalChannel per routed MessageClass with MANIFESTS_AS to transports', () => {
        const logicals = allEntities.filter(e =>
            e.labels.includes('MessageChannel') && e.properties.scope === 'logical');
        expect(logicals).toHaveLength(2);

        const orderUpdated = logicals.find(c =>
            (c.properties.name as string).endsWith('OrderUpdated'))!;
        const manifestsToTransports = orderUpdated.edges?.filter(e =>
            e.type === 'MANIFESTS_AS' && e.targetUrn.startsWith('cr:channel:transport:')) ?? [];
        // OrderUpdated is routed to BOTH transports: 2 MANIFESTS_AS edges.
        expect(manifestsToTransports).toHaveLength(2);
    });
});
