/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-monolith-without-entrypoint
 *
 * Pins the RC0 fix semantics: a PHP workspace with composer.json
 * declaring a `require` block and ≥10 .php source files but NO strong
 * runtime signal (no public/index.php, no bin/console, no Dockerfile,
 * no symfony/runtime marker) must NOT be auto-classified as Service.
 *
 * RC0 rationale (from acme-platform ingestion analysis): the previous design
 * fired `manifestPresence` standalone, so any NestJS/Symfony `libs/*`
 * workspace with ≥10 source files (acme-platform `libs/helper`, `libs/product`)
 * was wrongly promoted to `:Service`. The safer default for an
 * un-bootstrapped workspace is `:Library` with `needsReview=true`; if
 * the user wants Service classification they can:
 *   - add a `coderadius.yaml componentRoleOverride`, or
 *   - add a real entrypoint (`public/index.php`, `bin/console`, ...)
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

describe('Pattern Eval — php-monolith-without-entrypoint', () => {
    let components: DiscoveredComponent[];
    let topology: TopologyResult;
    let stagedRepo: string;

    beforeAll(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-monolith-presence-'));
        stagedRepo = path.join(tmp, 'inventory');
        fs.cpSync(FIXTURE_DIR, stagedRepo, { recursive: true });

        const result = await discoverAutoComponents(
            [{ name: 'inventory', path: stagedRepo, org: 'acme' }],
            [],
        );
        components = result.components;
        topology = collapseToTopology(components, [], 'auto', 'inventory', stagedRepo, {} as any);
    });

    afterAll(() => {
        if (stagedRepo) {
            const parent = path.dirname(stagedRepo);
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    it('autodiscovery surfaces the single root workspace named "inventory"', () => {
        expect(components.map(c => c.name)).toEqual(['inventory']);
    });

    it('no strong runtime signal → inferredType is "library" (PHP plugin declares signals)', () => {
        // Before RC0, manifestPresence (≥10 .php files + require block)
        // fired standalone and produced type='service'. Post-RC0 the same
        // signal is supporting-only; since the PHP plugin declares
        // runtimeServiceSignals AND none fire, autodiscovery picks the
        // safer 'library' default (vs 'undefined' which would happen for
        // a language with no plugin signals at all).
        expect(components[0].type).toBe('library');
        expect(components[0].language).toBe('php');
    });

    it('topology routes the library to the libraries bucket; synthetic :Service still created for the monolith repo', () => {
        // 'library' inferredType maps to topology.libraries. The auto-mode
        // synthetic-repo-as-Service fallback (topology-resolver.ts:594)
        // still creates a Service node so the dashboard has something to
        // hang Function ownership on, but the original autodiscovered
        // component stays in libraries (NOT promoted to runtime).
        expect(topology.libraries ?? []).toHaveLength(1);
        expect(topology.libraries![0].component.name).toBe('inventory');
        expect(topology.libraries![0].component.source).toBe('autodiscovery');

        // Synthetic Service fallback: the repo itself is promoted with a
        // distinct `autodiscovery-synthetic` source so callers can tell it
        // apart from a real autodiscovered Service.
        expect(topology.services).toHaveLength(1);
        expect(topology.services[0].component.source).toBe('autodiscovery-synthetic');

        expect(topology.pendingTriage ?? []).toEqual([]);
    });
});
