import { describe, expect, it } from 'vitest';
import {
    csvEscape,
    rowsToCsv,
} from '../../../packages/dashboard-ui/src/lib/csv';
import {
    FLAT_EVALUATION_HEADERS,
    type FlatEvaluationRow,
} from '../../../packages/dashboard-ui/src/transformers/governance.transformer';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: flat-CSV export of governance evaluations
//
// Verifies the CSV helpers and the governance-export header contract.
// ═══════════════════════════════════════════════════════════════════════════════

const ACME_ROWS: FlatEvaluationRow[] = [
    {
        qualified_name: 'microservices/order-service',
        repo: 'microservices',
        system: 'ecommerce-platform',
        entity_name: 'order-service',
        entity_type: 'Service',
        entity_url: 'https://example.com/order-service',
        team_owner: 'team-checkout',
        commits_12mo: 87,
        rule_id: 'acme-agents-md',
        rule_name: 'AGENTS.md present in the repository',
        level: 'error',
        scope: 'repository',
        tags: 'documentation',
        status: 'fail',
        detail: 'AGENTS.md not found in repository',
        structured_detail: '',
        evaluated_at: '2026-05-12T23:30:19.650Z',
    },
    {
        qualified_name: 'microservices/order-service',
        repo: 'microservices',
        system: 'ecommerce-platform',
        entity_name: 'order-service',
        entity_type: 'Service',
        entity_url: 'https://example.com/order-service',
        team_owner: 'team-checkout',
        commits_12mo: 87,
        rule_id: 'acme-catalog-info',
        rule_name: 'catalog-info.yaml present and populated',
        level: 'error',
        scope: 'service',
        tags: 'backstage',
        status: 'pass',
        detail: '',
        structured_detail: '',
        evaluated_at: '2026-05-12T23:30:19.652Z',
    },
    {
        qualified_name: 'microservices/payment-service',
        repo: 'microservices',
        system: '',
        entity_name: 'payment-service',
        entity_type: 'Service',
        entity_url: '',
        team_owner: 'team-payments',
        commits_12mo: 12,
        rule_id: 'acme-depends-on-reconciliation',
        rule_name: 'Declared dependsOn matches code-inferred dependencies',
        level: 'warning',
        scope: 'service',
        tags: 'backstage,drift',
        // detail contains a comma, must be quoted by csvEscape
        status: 'fail',
        detail: '1 inferred dependency(ies) missing from catalog-info.yaml dependsOn: microservices',
        // structured_detail with JSON quotes, must be escaped with double-quotes
        structured_detail: '{"checks":[{"label":"order-service","status":"fail"}]}',
        evaluated_at: '2026-05-12T23:30:19.655Z',
    },
];

describe('csvEscape', () => {
    it('returns plain string when no special characters', () => {
        expect(csvEscape('hello')).toBe('hello');
    });

    it('quotes and escapes values containing commas', () => {
        expect(csvEscape('a, b, c')).toBe('"a, b, c"');
    });

    it('escapes embedded double quotes by doubling them', () => {
        expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    });

    it('collapses embedded newlines to a single space (CSV-friendly cells)', () => {
        // csvEscape normalises whitespace runs, so a multi-line value becomes
        // a single-line cell. No quoting is required because the collapsed
        // form contains no separator, no quote, and no newline.
        expect(csvEscape('line1\nline2')).toBe('line1 line2');
    });

    it('coerces null and undefined to empty string', () => {
        expect(csvEscape(null)).toBe('');
        expect(csvEscape(undefined)).toBe('');
    });
});

describe('rowsToCsv', () => {
    it('emits the header row first, then one CSV row per data row', () => {
        const csv = rowsToCsv(['a', 'b'], [
            ['x', 'y'],
            ['1', '2'],
        ]);
        expect(csv.split('\n')).toEqual(['a,b', 'x,y', '1,2']);
    });

    it('escapes cell values that contain separators or quotes', () => {
        const csv = rowsToCsv(['col'], [
            ['needs, escaping'],
            ['has "quotes"'],
        ]);
        const lines = csv.split('\n');
        expect(lines[1]).toBe('"needs, escaping"');
        expect(lines[2]).toBe('"has ""quotes"""');
    });
});

describe('FLAT_EVALUATION_HEADERS contract', () => {
    it('lists exactly the 17 documented columns in stable order with qualified_name first', () => {
        expect(FLAT_EVALUATION_HEADERS).toEqual([
            'qualified_name', 'repo', 'system', 'entity_name', 'entity_type',
            'entity_url', 'team_owner', 'commits_12mo',
            'rule_id', 'rule_name', 'level', 'scope', 'tags', 'status', 'detail',
            'structured_detail', 'evaluated_at',
        ]);
    });

    it('FlatEvaluationRow has a key for every header', () => {
        for (const header of FLAT_EVALUATION_HEADERS) {
            for (const row of ACME_ROWS) {
                expect(row).toHaveProperty(header);
            }
        }
    });
});

describe('end-to-end CSV emission', () => {
    it('escapes comma inside detail field for the reconciliation drift row', () => {
        const headers = [...FLAT_EVALUATION_HEADERS];
        const rows = ACME_ROWS.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, rows);
        const lines = csv.split('\n');
        // header + 3 data rows
        expect(lines).toHaveLength(4);
        // Detail "...dependsOn: microservices" has a colon (no escape needed) but
        // structured_detail JSON has quotes (must be quoted+escaped). Verify the
        // last line contains the doubled-quote escape sequence.
        expect(lines[3]).toContain('""checks""');
    });

    it('preserves the ISO 8601 timestamp untouched', () => {
        const headers = [...FLAT_EVALUATION_HEADERS];
        const rows = ACME_ROWS.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, rows);
        expect(csv).toContain('2026-05-12T23:30:19.650Z');
    });

    it('renders empty string for missing system/entity_url, not literal undefined', () => {
        const headers = [...FLAT_EVALUATION_HEADERS];
        const rows = ACME_ROWS.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, rows);
        // payment-service row: 3rd data row, system=='' and entity_url==''
        const paymentLine = csv.split('\n')[3];
        // qualified_name, repo, system(empty), entity_name, entity_type, entity_url(empty), team_owner, commits_12mo, ...
        expect(paymentLine.startsWith('microservices/payment-service,microservices,,payment-service,Service,,team-payments,12,')).toBe(true);
        expect(paymentLine).not.toContain('undefined');
    });
});
