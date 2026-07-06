/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-dynamic-sql (DETERMINISTIC static-bypass slice)
 *
 * No LLM. Pins the deterministic static path for dynamic SQL where the table
 * name is built by local concatenation:
 *
 *     $table = 'shipment_log_' . $carrierType;
 *     $db->prepare("INSERT INTO {$table} ...");
 *
 * The static value resolver must recognise the literal prefix `shipment_log_`
 * and emit a dynamic-table STUB (`shipment_log_…`) so the DataEntityPostProcessor
 * can later prefix-expand it to the concrete tables seeded by ShipmentLogReader.
 *
 * Before the fix: the static bypass abstained (table token `{$table}` was
 * unparseable), the function fell through to the LLM, which emitted the opaque
 * `<DYNAMIC>` sentinel — dropped by the sanitizer — so persistTracking ended up
 * with zero WRITES edges and the dynamic write was lost.
 *
 * This is the deterministic counterpart of the integration assertion
 * `tests/integration/eval-graph.test.ts` › "rewire ShipmentLogWriter.persistTracking".
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
    runStaticPipelineOnFixture,
    runStaticBypassForMethod,
} from '../_helpers/di-pipeline-runner.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixture');

describe('Pattern Eval — php-dynamic-sql (static bypass, deterministic)', () => {
    const result = runStaticPipelineOnFixture(FIXTURE_DIR, 'acme/inventory-service');

    it('persistTracking — pure dynamic INSERT emits a prefixed table stub (no LLM)', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'App\\Service\\ShipmentLogWriter',
            'persistTracking',
        );

        // The static path must NOT abstain: the literal prefix `shipment_log_`
        // is ground truth in the AST, so we can resolve a rewireable stub.
        expect(staticAnalysis, 'static bypass must resolve the dynamic table from its literal prefix').not.toBeNull();

        const dbStub = staticAnalysis!.infrastructure.find(
            i => i.type === 'Database' && i.name.startsWith('shipment_log_'),
        );
        expect(dbStub, 'must emit a shipment_log_* Database stub').toBeDefined();
        expect(dbStub!.operation).toBe('WRITES'); // INSERT → WRITES
        // The emitted name is a dynamic stub the post-processor can expand
        // (trailing `_` prefix or `{var}` placeholder).
        expect(/_$|\{[a-zA-Z_]\w*\}/.test(dbStub!.name)).toBe(true);
    });

    it('archiveOldLogs — keeps the literal archive table AND resolves the dynamic source', () => {
        const { staticAnalysis } = runStaticBypassForMethod(
            result,
            'App\\Service\\ShipmentLogWriter',
            'archiveOldLogs',
        );
        expect(staticAnalysis).not.toBeNull();
        const names = staticAnalysis!.infrastructure.filter(i => i.type === 'Database').map(i => i.name);
        // Literal archive table is still captured.
        expect(names).toContain('shipment_log_archive');
        // Dynamic source table resolved to a rewireable stub.
        expect(names.some(n => n !== 'shipment_log_archive' && n.startsWith('shipment_log_'))).toBe(true);
    });
});
