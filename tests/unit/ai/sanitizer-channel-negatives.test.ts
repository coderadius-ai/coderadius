import { describe, it, expect } from 'vitest';
import { sanitizeAnalysis } from '../../../src/ai/workflows/sanitizer.js';
import { PHPPlugin } from '../../../src/ingestion/core/languages/php.js';
import type { UnifiedAnalysis } from '../../../src/ai/agents/unified-analyzer.js';

// ═════════════════════════════════════════════════════════════════════════════
// Sanitizer — MessageChannel false-positive guards
//
// Pins the deterministic post-LLM rules introduced after the orchestrator audit
// surfaced 5 distinct categories of hallucinated MessageChannel entries:
//   1. MongoDB selectCollection() → should reclassify as Database
//   2. SQL INSERT INTO / UPDATE / DELETE FROM → reclassify as Database (table)
//   3. File-transport sender (SftpSender, S3Uploader, ...) → drop
//   4. Internal argument names ending in _args/_params/_payload/... → drop
//   5. Middle-concat templates `prefix_{var}_suffix` not resolvable → drop
// ═════════════════════════════════════════════════════════════════════════════

function makeAnalysis(infra: any, opts: { sourceCode?: string } = {}): UnifiedAnalysis {
    return {
        has_io: true,
        intent: 'test',
        infrastructure: [infra],
        capabilities: [],
        produced_payloads: [],
        consumed_payloads: [],
    } as UnifiedAnalysis;
}

describe('Sanitizer — MessageChannel false positives', () => {
    it('reclassifies MongoDB selectCollection() as Database', () => {
        const analysis = makeAnalysis({
            name: 'quote_BULK',
            type: 'MessageChannel',
            operation: 'WRITES',
            evidence: "selectCollection call",
        });
        const sourceCode = "$this->client->selectCollection('archive', 'quote_BULK');";
        const result = sanitizeAnalysis(analysis, { sourceCode, plugin: new PHPPlugin() });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect(surviving[0].type).toBe('Database');
        expect(surviving[0].name).toBe('quote_BULK');
    });

    it('reclassifies SQL INSERT INTO as Database with the actual table name', () => {
        const analysis = makeAnalysis({
            name: 'snapshot_log',
            type: 'MessageChannel',
            operation: 'WRITES',
            evidence: 'INSERT INTO statement',
        });
        const sourceCode = "$db->preparedQuery('INSERT INTO price_diff_log (a, b) VALUES (?, ?)', [...]);";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect(surviving[0].type).toBe('Database');
        // Name is rewritten to the actual SQL table extracted from source.
        expect(surviving[0].name).toBe('price_diff_log');
    });

    it('drops file-transport senders (SftpSender, S3Uploader, ...)', () => {
        const analysis = makeAnalysis({
            name: 'sftp_upload',
            type: 'MessageChannel',
            operation: 'WRITES',
            evidence: 'sftp send call',
        });
        const sourceCode = "$this->sftpSender->send($filePath, $fileName);";
        const result = sanitizeAnalysis(analysis, { sourceCode });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });

    it('drops internal argument names ending in _args / _params / _payload', () => {
        for (const name of ['scraper_execution_args', 'http_options', 'request_payload']) {
            const analysis = makeAnalysis({
                name,
                type: 'MessageChannel',
                operation: 'WRITES',
                evidence: 'method arg',
            });
            const result = sanitizeAnalysis(analysis, { sourceCode: 'function exec($args) {}' });
            expect(result.infrastructure ?? [], `should drop ${name}`).toHaveLength(0);
        }
    });

    it('drops middle-concat templates that envVarDict cannot resolve', () => {
        const analysis = makeAnalysis({
            name: 'quote_{tipo}',
            type: 'MessageChannel',
            operation: 'WRITES',
            evidence: 'concat name',
        });
        const result = sanitizeAnalysis(analysis, { sourceCode: "sprintf('quote_%s', $tipo)" });
        expect(result.infrastructure ?? []).toHaveLength(0);
    });

    it('resolves middle-concat templates via envVarDict when possible', () => {
        const analysis = makeAnalysis({
            name: 'quote_{tipo}',
            type: 'MessageChannel',
            operation: 'WRITES',
            evidence: 'concat name',
        });
        const envVarDict = new Map([['tipo', 'auto']]);
        const result = sanitizeAnalysis(analysis, { sourceCode: '...', envVarDict });
        const surviving = result.infrastructure ?? [];
        expect(surviving).toHaveLength(1);
        expect(surviving[0].name).toBe('quote_auto');
    });
});
