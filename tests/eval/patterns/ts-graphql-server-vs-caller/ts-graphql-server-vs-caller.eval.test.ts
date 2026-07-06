/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — ts-graphql-server-vs-caller
 *
 * Pins the GraphQL server detection + INBOUND gate behavior in a monorepo.
 *
 * Fixture topology:
 *   - apps/orders-api      → Dockerfile + GraphQLModule.forRoot in App.module → :Service + role 'graphql-server'
 *   - apps/orders-worker   → Dockerfile + NestFactory.createApplicationContext (no GraphQL) → :Service, NO 'graphql-server' role
 *   - apps/orders-client   → Dockerfile + fetch /graphql (caller only) → :Service, NO 'graphql-server' role
 *   - libs/orders-resolvers → resolver classes only, exports for reuse → :Library (no entrypoint, no Dockerfile)
 *
 * Asserts that:
 *   ✓ orders-api gets the 'graphql-server' role (entrypoint pattern fires)
 *   ✓ orders-worker DOES NOT get 'graphql-server' even though it imports OrderResolver
 *     (the EXPOSES_API leak that Fix #2 INBOUND gate prevents)
 *   ✓ orders-client DOES NOT get 'graphql-server' (it is a GQL caller, not a server)
 *   ✓ libs/orders-resolvers stays a Library and never EXPOSES_API anything
 *
 * Zero LLM, zero graph DB. Structural classification only. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverAutoComponents,
    type DiscoveredService,
} from '../../../../src/ingestion/extractors/autodiscovery.js';
import {
    collapseToTopology,
    type DiscoveredComponent,
    type TopologyResult,
} from '../../../../src/ingestion/topology-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — ts-graphql-server-vs-caller', () => {
    let components: DiscoveredComponent[];
    let serviceRoots: DiscoveredService[];
    let topology: TopologyResult;
    let stagedRepo: string;

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gql-eval-'));
        stagedRepo = path.join(tmp, 'orders-monorepo');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });
        const result = await discoverAutoComponents(
            [{ name: 'orders-monorepo', path: stagedRepo, org: 'acme' }],
            [],
        );
        components = result.components;
        serviceRoots = result.serviceRoots;
        topology = collapseToTopology(components, [], 'monorepo', 'orders-monorepo', '/tmp/orders-monorepo', {} as any);
    });

    afterAll(() => {
        if (stagedRepo) fs.rmSync(path.dirname(stagedRepo), { recursive: true, force: true });
    });

    it('discovers four workspaces', () => {
        const names = components.map(c => c.name).sort();
        expect(names).toEqual(['orders-api', 'orders-client', 'orders-resolvers', 'orders-worker']);
    });

    // ─── Type classification ────────────────────────────────────────────────

    it('orders-api → type=service', () => {
        expect(components.find(c => c.name === 'orders-api')!.type).toBe('service');
    });

    it('orders-worker → type=service', () => {
        expect(components.find(c => c.name === 'orders-worker')!.type).toBe('service');
    });

    it('orders-client → type=service', () => {
        expect(components.find(c => c.name === 'orders-client')!.type).toBe('service');
    });

    it('orders-resolvers → type=library', () => {
        expect(components.find(c => c.name === 'orders-resolvers')!.type).toBe('library');
    });

    // ─── frameworkRoles classification ──────────────────────────────────────

    it('orders-api → frameworkRoles includes graphql-server (App.module forRoot detected)', () => {
        const svc = serviceRoots.find(s => s.name === 'orders-api')!;
        expect(svc.frameworkRoles?.has('graphql-server')).toBe(true);
    });

    it('orders-worker → frameworkRoles does NOT include graphql-server (no bootstrap, only dep)', () => {
        const svc = serviceRoots.find(s => s.name === 'orders-worker')!;
        // Worker imports @nestjs/graphql for typings and OrderResolver from libs.
        // It must NOT get graphql-server role — that is exactly the leak Fix #2 prevents.
        expect(svc.frameworkRoles?.has('graphql-server') ?? false).toBe(false);
    });

    it('orders-client → frameworkRoles does NOT include graphql-server (caller only)', () => {
        const svc = serviceRoots.find(s => s.name === 'orders-client')!;
        expect(svc.frameworkRoles?.has('graphql-server') ?? false).toBe(false);
    });

    it('orders-resolvers (library) → no frameworkRoles entries with graphql-server', () => {
        const svc = serviceRoots.find(s => s.name === 'orders-resolvers')!;
        // Library carries the dep marker but its bootstrap files don't exist;
        // since dep-marker-alone was removed for @nestjs/graphql, the lib must
        // NOT get the role.
        expect(svc.frameworkRoles?.has('graphql-server') ?? false).toBe(false);
    });

    // ─── Topology bucketing ─────────────────────────────────────────────────

    it('topology services bucket contains the three runtime apps only', () => {
        const names = topology.services.map(s => s.component.name).sort();
        expect(names).toEqual(['orders-api', 'orders-client', 'orders-worker']);
    });

    it('topology libraries bucket contains orders-resolvers', () => {
        const names = (topology.libraries ?? []).map(l => l.component.name).sort();
        expect(names).toEqual(['orders-resolvers']);
    });

    it('topology pendingTriage bucket is empty', () => {
        expect(topology.pendingTriage ?? []).toEqual([]);
    });
});
