/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-monolith-bare
 *
 * Pins the synthetic repo-as-Service fallback path: a tiny PHP monolith with
 * composer.json declaring no production `require` (only the PHP constraint)
 * and 3 source files fails every signal in `php.runtimeServiceSignals` —
 * including the new `manifestPresence` signal — so it's classified as
 * `type: 'library'`. The `collapseToTopology` fallback rescues it by
 * promoting the repo itself to a synthetic :Service stamped with the
 * `autodiscovery-synthetic` source.
 *
 * Without the fallback, the dashboard would have no :Service node to anchor
 * Function ownership and READS/WRITES/CALLS edges on, leaving Impact empty.
 *
 * Zero LLM, zero graph DB. Pure structural pipeline. Deterministic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    discoverAutoComponents,
} from '../../../../src/ingestion/extractors/autodiscovery.js';
import {
    collapseToTopology,
    type DiscoveredComponent,
    type TopologyResult,
} from '../../../../src/ingestion/topology-resolver.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-monolith-bare (synthetic-fallback)', () => {
    let components: DiscoveredComponent[];
    let topology: TopologyResult;
    let stagedRepo: string;

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-monolith-bare-'));
        stagedRepo = path.join(tmp, 'inventory-bare');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });

        const result = await discoverAutoComponents(
            [{ name: 'inventory-bare', path: stagedRepo, org: 'acme' }],
            [],
        );
        components = result.components;
        topology = collapseToTopology(components, [], 'auto', 'inventory-bare', stagedRepo, {} as any);
    });

    afterAll(() => {
        if (stagedRepo) {
            const parent = path.dirname(stagedRepo);
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    it('autodiscovery classifies the bare workspace as type=library (no signal fires)', () => {
        expect(components).toHaveLength(1);
        expect(components[0].type).toBe('library');
        expect(components[0].language).toBe('php');
    });

    it('topology promotes the repo to a synthetic Service via fallback', () => {
        expect(topology.services).toHaveLength(1);
        expect(topology.services[0].component.name).toBe('inventory-bare');
        expect(topology.services[0].component.source).toBe('autodiscovery-synthetic');
        expect(topology.services[0].component.type).toBe('service');
        expect(topology.services[0].component.language).toBe('php');
        expect(topology.services[0].component.catalogFile).toBe(stagedRepo);
    });

    it('the original library component still lands in the libraries bucket alongside the synthetic Service', () => {
        // Synthetic-fallback does not erase the underlying library record;
        // both coexist so the writer emits both a :Service (synthetic) and a
        // :Library (original autodiscovery component).
        const libNames = (topology.libraries ?? []).map(l => l.component.name);
        expect(libNames).toContain('inventory-bare');
    });
});
