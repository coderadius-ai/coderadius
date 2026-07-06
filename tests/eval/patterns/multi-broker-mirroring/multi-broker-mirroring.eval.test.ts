import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { RepoHintsSchema } from '../../../../src/config/repo-hints.js';
import {
    clearMessageBrokerRegistry,
    registerBrokerDeclaration,
    registerMirror,
    listRegisteredBrokers,
    listMirrors,
    getBrokerById,
} from '../../../../src/ingestion/core/messaging/broker-registry.js';
import { makePhysicalChannelUrn } from '../../../../src/ingestion/structural/plugins/messaging/messaging-helpers.js';

// ═════════════════════════════════════════════════════════════════════════════
// Pattern test (deterministic, no LLM, no DB) — multi-broker-mirroring
//
// Pins strict broker isolation + customer-declared cross-broker mirror.
//
// Two RabbitMQ clusters (eu / us) host the same-name exchange `acme.orders`.
// Without an explicit `channelAliases` entry, no welder MAY fuse them. With
// the explicit declaration, a single LogicalChannel materializes through both
// physicals via MANIFESTS_AS while the physicals stay distinct.
//
// The test does NOT spin up Memgraph; it exercises the registry/helpers
// directly to lock in the URN strategy and the "alias is declarative only"
// contract.
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

describe('Pattern Eval — multi-broker-mirroring', () => {
    beforeAll(() => {
        clearMessageBrokerRegistry();
        const yamlContent = fs.readFileSync(path.join(FIXTURE_DIR, 'coderadius.yaml'), 'utf-8');
        const hints = RepoHintsSchema.parse(yaml.load(yamlContent));
        for (const broker of hints.messageBrokers ?? []) {
            registerBrokerDeclaration(broker);
        }
        for (const mirror of hints.message_channels?.mirrors ?? []) {
            registerMirror(mirror);
        }
    });

    afterAll(() => clearMessageBrokerRegistry());

    it('registers two distinct brokers from coderadius.yaml', () => {
        const brokers = listRegisteredBrokers();
        expect(brokers).toHaveLength(2);
        const eu = getBrokerById('rmq-eu')!;
        const us = getBrokerById('rmq-us')!;
        expect(eu.fingerprint).not.toBe(us.fingerprint);
        expect(eu.urn).not.toBe(us.urn);
        expect(eu.region).toBe('eu-west-1');
        expect(us.region).toBe('us-east-1');
    });

    it('strict isolation: same channel name on each broker → distinct URNs', () => {
        const eu = getBrokerById('rmq-eu')!;
        const us = getBrokerById('rmq-us')!;
        const euUrn = makePhysicalChannelUrn('acme.orders', 'topic', eu.fingerprint);
        const usUrn = makePhysicalChannelUrn('acme.orders', 'topic', us.fingerprint);
        expect(euUrn).not.toBe(usUrn);
        // Both URNs share the legacy `cr:channel:topic:<name>` prefix but carry
        // a different broker fingerprint suffix; this is what guarantees the
        // welder never collapses them via name-only matching.
        expect(euUrn.startsWith('cr:channel:topic:acme.orders@')).toBe(true);
        expect(usUrn.startsWith('cr:channel:topic:acme.orders@')).toBe(true);
    });

    it('registers the OrderCreated mirror with two physical descriptors', () => {
        const mirrors = listMirrors();
        expect(mirrors).toHaveLength(1);
        const mirror = mirrors[0];
        expect(mirror.logical).toBe('OrderCreated');
        expect(mirror.kind).toBe('topic');
        expect(mirror.physical).toHaveLength(2);
        const brokerIds = mirror.physical.map(p => p.broker).sort();
        expect(brokerIds).toEqual(['rmq-eu', 'rmq-us']);
    });

    it('every physical mirror entry resolves to a declared broker (no dangling refs)', () => {
        const mirrors = listMirrors();
        for (const p of mirrors[0].physical) {
            expect(getBrokerById(p.broker)).toBeDefined();
        }
    });
});
