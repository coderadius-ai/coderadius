/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pattern Eval — php-dynamic-sql
 *
 * Real-world case: Dynamic SQL generation and complex I/O directionality.
 *
 * Verifies that the LLM + pipeline:
 *   ✓ Extracts SQL stubs accurately (e.g. shipment_log_{carrierType})
 *   ✓ Correctly assigns READS vs WRITES per infrastructure item
 *   ✓ Detects external API calls alongside DB operations
 *
 * Fixture: tests/eval/patterns/php-dynamic-sql/fixture/
 * Manifest: tests/eval/patterns/php-dynamic-sql/expected.graph.yaml
 *
 * Modes: replay (default, ~1s) | live | refresh
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { analyzeFunction} from '../../../../src/ai/agents/unified-analyzer.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../../helpers/llm-replay-cache.js';
import {
    loadFixtureChunks,
    loadFixtureManifest,
    scoreAnalysis,
} from '../../helpers/pattern-eval.js';

const TEST_DIR = import.meta.dirname;
const FIXTURE_DIR = path.resolve(TEST_DIR, 'fixture');

// Wire replay cache (generic + per-language agents — see with-replay.ts)
await wireUnifiedAnalyzerReplay();

describe('Pattern Eval — php-dynamic-sql', () => {
    let chunks: CodeChunk[];
    let manifest: ReturnType<typeof loadFixtureManifest>;

    beforeAll(() => {
        console.log(`[Pattern Eval] php-dynamic-sql | Mode: ${EVAL_LLM_MODE}`);
        chunks = loadFixtureChunks(FIXTURE_DIR);
        manifest = loadFixtureManifest(TEST_DIR);
    });

    it('should load fixture code and manifest', () => {
        expect(chunks.length).toBeGreaterThan(0);
        expect(manifest.fixture).toBe('php-dynamic-sql');
    });

    it('DataSyncCommand — should correctly assign READS vs WRITES and extract API calls', async () => {
        const chunk = chunks.find(c => c.name === 'DataSyncCommand');
        expect(chunk, 'Fixture must contain DataSyncCommand class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'DataSyncCommand', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:audit_log');
        expect(score.truePositives).toContain('DataContainer:sync_checkpoints');
        
        // Assert directionality
        const infra = result!.analysis.infrastructure;
        
        const auditLog = infra.find(i => i.name === 'audit_log');
        expect(auditLog?.operation).toBe('READS');

        const syncCheckpoints = infra.find(i => i.name === 'sync_checkpoints');
        expect(syncCheckpoints?.operation).toBe('WRITES');

        // Note: The external API URL uses env var $partnerApiUrl.
        // It might be extracted as '{PARTNER_API_URL}/api/v1/partner/push' or similar
        // by the LLM. Let's rely on scoreAnalysis to fuzz match it.
        // Or if it is in emergent_api_calls:
        const apis = (result!.analysis as any).emergent_api_calls || [];
        const partnerApi = apis.find((api: any) => api.path.includes('/api/v1/partner/push'));
        expect(partnerApi).toBeDefined();
    });

    it('DynamicTableWriter — should extract dynamic SQL stub booking_slot_{type}', async () => {
        const chunk = chunks.find(c => c.name === 'DynamicTableWriter');
        expect(chunk, 'Fixture must contain DynamicTableWriter class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'DynamicTableWriter', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:booking_slot_{type}');
        
        const infra = result!.analysis.infrastructure;
        const bookingSlot = infra.find(i => i.name.includes('booking_slot_'));
        expect(bookingSlot?.operation).toBe('WRITES'); // DELETE is considered WRITES
    });

    it('ShipmentLogWriter — should extract dynamic SQL stub shipment_log_{carrierType}', async () => {
        const chunk = chunks.find(c => c.name === 'ShipmentLogWriter');
        expect(chunk, 'Fixture must contain ShipmentLogWriter class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'ShipmentLogWriter', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:shipment_log_{carrierType}');
        
        const infra = result!.analysis.infrastructure;
        const shipmentLog = infra.find(i => i.name.includes('shipment_log_'));
        expect(shipmentLog?.operation).toBe('WRITES'); // INSERT is considered WRITES
    });

    it('ShipmentLogReader — should extract static references shipment_log_express and shipment_log_freight', async () => {
        const chunk = chunks.find(c => c.name === 'ShipmentLogReader');
        expect(chunk, 'Fixture must contain ShipmentLogReader class').toBeDefined();

        const result = await analyzeFunction(chunk!, 'fast');
        const score = scoreAnalysis(manifest, 'ShipmentLogReader', result!.analysis);

        expect(score.truePositives).toContain('DataContainer:shipment_log_express');
        expect(score.truePositives).toContain('DataContainer:shipment_log_freight');
        
        const infra = result!.analysis.infrastructure;
        const express = infra.find(i => i.name === 'shipment_log_express');
        expect(express?.operation).toBe('READS');
        const freight = infra.find(i => i.name === 'shipment_log_freight');
        expect(freight?.operation).toBe('READS');
    });
});
