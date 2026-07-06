import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { crossplanePubsubPlugin } from '../../../../src/ingestion/structural/plugins/contrib/crossplane-pubsub.plugin.js';
import type { PluginContext, StructuralEntity } from '../../../../src/ingestion/structural/types.js';
import { ScopeManager } from '../../../../src/ingestion/core/scope-manager.js';

// ═════════════════════════════════════════════════════════════════════════════
// Crossplane PubSub — Microservices Integration Test
//
// Simulates two microservices sharing a PubSub topic via Helm Crossplane CRDs:
//   order-service         → owns the Topic (AcmePubSubTopicClaim)
//   notification-service  → subscribes to it (AcmePubSubTopicSubscriptionClaim)
//
// Verifies that the plugin:
//   1. Extracts MessageChannel nodes from both services
//   2. Both services reference the SAME topic name (Platform-OrderCreated)
//   3. The subscription emits a ROUTES_TO edge pointing to the topic
//   4. No placeholder garbage leaks into node names
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

interface ExpectedEdge {
    source: string;
    target: string;
}

interface GraphManifest {
    fixture: string;
    description: string;
    expected_nodes: Record<string, string[]>;
    expected_edges?: Record<string, ExpectedEdge[]>;
    negative_nodes?: Record<string, string[]>;
}

function makeContext(relativePath: string, absolutePath: string, repoName: string): PluginContext {
    return {
        relativePath,
        absolutePath,
        repoName,
        repoUrn: `cr:repository:${repoName}`,
        scopeManager: new ScopeManager(path.dirname(absolutePath)),
    };
}

describe('Pattern Eval — crossplane-pubsub-microservices (structural)', () => {
    let manifest: GraphManifest;
    let allEntities: StructuralEntity[];

    beforeAll(() => {
        // Load manifest
        const manifestContent = fs.readFileSync(
            path.resolve(TEST_DIR, 'expected.graph.yaml'), 'utf-8',
        );
        manifest = yaml.load(manifestContent) as GraphManifest;

        // Discover and process all Helm templates in the fixture
        allEntities = [];
        const services = ['order-service', 'notification-service'];

        for (const svc of services) {
            const templatesDir = path.join(FIXTURE_DIR, svc, '.charts', 'templates');
            if (!fs.existsSync(templatesDir)) continue;

            const files = fs.readdirSync(templatesDir).filter(
                f => f.endsWith('.yaml') || f.endsWith('.yml'),
            );

            for (const file of files) {
                const absPath = path.join(templatesDir, file);
                const relPath = `${svc}/.charts/templates/${file}`;
                const basename = path.basename(file);

                // Verify matchFile returns true
                expect(
                    crossplanePubsubPlugin.matchFile(relPath, basename),
                    `matchFile should accept ${relPath}`,
                ).toBe(true);

                const content = fs.readFileSync(absPath, 'utf-8');
                const ctx = makeContext(relPath, absPath, `acme/${svc}`);
                const result = crossplanePubsubPlugin.extract(content, ctx);
                allEntities.push(...result.entities);
            }
        }
    });

    // ── Structural assertions ────────────────────────────────────────────────

    it('should load fixture manifest', () => {
        expect(manifest.fixture).toBe('crossplane-pubsub-microservices');
    });

    it('should extract entities from both services', () => {
        expect(allEntities.length).toBeGreaterThanOrEqual(2);
    });

    // ── Expected Nodes ───────────────────────────────────────────────────────

    it('should emit all expected MessageChannel nodes', () => {
        const channelNames = allEntities
            .filter(e => e.labels.includes('MessageChannel'))
            .map(e => e.properties.name as string);

        for (const expectedName of manifest.expected_nodes.MessageChannel) {
            expect(
                channelNames,
                `Expected MessageChannel "${expectedName}" to be emitted`,
            ).toContain(expectedName);
        }
    });

    it('should emit the topic from order-service', () => {
        const topic = allEntities.find(
            e => e.properties.name === 'Platform-OrderCreated' && e.properties.channelKind === 'topic',
        );
        expect(topic, 'Topic node should exist').toBeDefined();
        expect(topic!.properties.technology).toBe('pubsub');
        expect(topic!.id).toBe('cr:channel:topic:Platform-OrderCreated');
    });

    it('should emit the subscription from notification-service', () => {
        const sub = allEntities.find(
            e => e.properties.name === 'order-notifications' && e.properties.channelKind === 'subscription',
        );
        expect(sub, 'Subscription node should exist').toBeDefined();
        expect(sub!.properties.technology).toBe('pubsub');
        expect(sub!.id).toBe('cr:channel:sub:order-notifications');
    });

    // ── Cross-service Topic Convergence ──────────────────────────────────────

    it('both services should reference the same physical topic URN', () => {
        // order-service emits the topic directly
        // notification-service emits the topic as part of the subscription linkage
        const topicEntities = allEntities.filter(
            e => e.properties.name === 'Platform-OrderCreated' && e.properties.channelKind === 'topic',
        );

        // Both services emit a topic node with the same URN
        expect(topicEntities.length).toBeGreaterThanOrEqual(2);

        const urns = new Set(topicEntities.map(e => e.id));
        expect(urns.size, 'All topic references should resolve to the same URN').toBe(1);
        expect(urns.has('cr:channel:topic:Platform-OrderCreated')).toBe(true);
    });

    // ── ROUTES_TO Edge ───────────────────────────────────────────────────

    it('should emit ROUTES_TO edge from subscription to topic', () => {
        const edgeEntities = allEntities.filter(e => e.edges && e.edges.length > 0);
        expect(edgeEntities.length).toBeGreaterThanOrEqual(1);

        const allEdges = edgeEntities.flatMap(e => e.edges!);
        const routesToEdges = allEdges.filter(e => e.type === 'ROUTES_TO');

        expect(routesToEdges.length).toBeGreaterThanOrEqual(1);

        // Verify the expected edges from manifest (array format: {from, rel, to})
        const expectedSubEdges = (manifest.expected_edges as Array<{ from: string; rel: string; to: string }>)
            .filter(e => e.rel === 'ROUTES_TO');

        for (const expected of expectedSubEdges) {
            const matchingEdge = routesToEdges.find(e =>
                e.sourceUrn.includes(expected.from) &&
                e.targetUrn.includes(expected.to),
            );
            expect(
                matchingEdge,
                `Expected ROUTES_TO edge: ${expected.from} → ${expected.to}`,
            ).toBeDefined();
        }
    });

    // ── Negative Assertions (no placeholder leaks) ───────────────────────────

    it('should NOT emit MessageChannels with placeholder garbage', () => {
        const channelNames = allEntities
            .filter(e => e.labels.includes('MessageChannel'))
            .map(e => e.properties.name as string);

        for (const negativeName of manifest.negative_nodes!.MessageChannel) {
            expect(
                channelNames,
                `MessageChannel "${negativeName}" should NOT be emitted`,
            ).not.toContain(negativeName);
        }
    });

    it('should NOT contain __CR_ prefixes in any entity name', () => {
        for (const entity of allEntities) {
            const name = entity.properties.name as string;
            expect(name, `Entity name "${name}" contains unresolved placeholder`).not.toMatch(/__CR_/);
        }
    });

    // ── Source Property ──────────────────────────────────────────────────────

    it('all emitted entities carry the crossplane discoverySource discriminator', () => {
        for (const entity of allEntities) {
            expect(entity.properties.discoverySource).toBe('crossplane');
        }
    });
});
