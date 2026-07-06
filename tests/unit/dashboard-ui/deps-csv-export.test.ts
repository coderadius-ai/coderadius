import { describe, expect, it } from 'vitest';
import type { DepsReport } from '@coderadius/shared-types';
import {
    rowsToCsv,
} from '../../../packages/dashboard-ui/src/lib/csv';
import {
    FLAT_DEPS_HEADERS,
    buildFlatDepsRows,
    type FlatDepsRow,
} from '../../../packages/dashboard-ui/src/transformers/deps.transformer';

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: flat-CSV export of dependency ecosystem rows
//
// Verifies the header contract, the (package × version × consumer) grain
// of buildFlatDepsRows, the triage sort order, field fidelity, and the
// downstream rowsToCsv emission used by PackageRegistryView export.
// ═══════════════════════════════════════════════════════════════════════════════

function reportFixture(): DepsReport {
    return {
        packages: [
            {
                packageName: 'acme/inventory',
                ecosystem: 'npm',
                isInternal: true,
                latestPublished: '2.1.0',
                versionConfidence: 'tag',
                publishedBy: 'acme-platform',
                totalConsumers: 3,
                hasVersionSkew: true,
                versions: [
                    {
                        displayVersion: '1.0.0',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'major',
                        consumers: [
                            {
                                name: 'orders',
                                type: 'Service',
                                team: 'team-orders',
                                url: 'git@gitlab.com:acme/orders.git',
                                repoName: 'acme-monorepo',
                                requiredVersion: '^1.0.0',
                                livenessCommits: 42,
                            },
                            {
                                name: 'payment',
                                type: 'Service',
                                team: 'team-payments',
                                url: null,
                                repoName: 'acme-monorepo',
                                requiredVersion: '>=1, <2',
                                livenessCommits: null,
                            },
                        ],
                    },
                    {
                        displayVersion: '2.0.0',
                        isLocked: true,
                        isDev: true,
                        driftLevel: 'patch',
                        consumers: [
                            {
                                name: 'shipping',
                                type: 'Service',
                                team: 'team-fulfilment',
                                url: null,
                                repoName: 'acme-shipping',
                                requiredVersion: '^2',
                                livenessCommits: 9,
                            },
                        ],
                    },
                ],
            },
            {
                // Package name contains a comma → forces csvEscape to quote it.
                packageName: 'acme/messaging,beta',
                ecosystem: 'composer',
                isInternal: false,
                totalConsumers: 0,
                hasVersionSkew: false,
                versions: [
                    {
                        displayVersion: '0.9.0',
                        isLocked: false,
                        isDev: false,
                        driftLevel: 'none',
                        consumers: [],
                    },
                ],
            },
        ],
        summary: {
            totalPackages: 2,
            totalWithSkew: 1,
            ecosystems: ['npm', 'composer'],
        },
    };
}

describe('FLAT_DEPS_HEADERS contract', () => {
    it('lists exactly the 17 documented columns in stable order with package_name first', () => {
        expect(FLAT_DEPS_HEADERS).toEqual([
            'package_name', 'ecosystem', 'is_internal',
            'installed_version', 'is_dev', 'is_locked',
            'drift_level', 'required_version',
            'latest_published', 'version_confidence', 'published_by',
            'consumer_name', 'consumer_type', 'consumer_qualified',
            'consumer_repo', 'team', 'commits_12mo',
        ]);
        expect(FLAT_DEPS_HEADERS).toHaveLength(17);
        expect(FLAT_DEPS_HEADERS[0]).toBe('package_name');
    });

    it('FlatDepsRow has a key for every header', () => {
        const rows = buildFlatDepsRows(reportFixture());
        expect(rows.length).toBeGreaterThan(0);
        for (const header of FLAT_DEPS_HEADERS) {
            for (const row of rows) {
                expect(row).toHaveProperty(header);
            }
        }
    });
});

describe('buildFlatDepsRows grain', () => {
    it('emits one row per (package, version, consumer) tuple', () => {
        const rows = buildFlatDepsRows(reportFixture());
        // acme/inventory v1.0.0 → 2 consumers, v2.0.0 → 1 consumer
        // acme/messaging,beta v0.9.0 → 0 consumers → 1 placeholder row
        expect(rows).toHaveLength(4);

        const inventoryRows = rows.filter(r => r.package_name === 'acme/inventory');
        expect(inventoryRows).toHaveLength(3);
    });

    it('emits a placeholder row for versions with empty consumer list', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const orphan = rows.find(r => r.package_name === 'acme/messaging,beta');
        expect(orphan).toBeDefined();
        expect(orphan!.installed_version).toBe('0.9.0');
        expect(orphan!.consumer_name).toBe('');
        expect(orphan!.consumer_type).toBe('');
        expect(orphan!.consumer_repo).toBe('');
        expect(orphan!.team).toBe('');
        expect(orphan!.commits_12mo).toBe('');
        expect(orphan!.required_version).toBe('');
    });
});

describe('buildFlatDepsRows sort order', () => {
    it('orders by package → drift severity → repo → consumer', () => {
        const rows = buildFlatDepsRows(reportFixture());
        // Expected order:
        //  1. acme/inventory @ v1.0.0 (major) / orders     (repo acme-monorepo)
        //  2. acme/inventory @ v1.0.0 (major) / payment    (repo acme-monorepo)
        //  3. acme/inventory @ v2.0.0 (patch) / shipping   (repo acme-shipping)
        //  4. acme/messaging,beta @ v0.9.0 (none) / —
        expect(rows.map(r => `${r.package_name}|${r.drift_level}|${r.consumer_name}`)).toEqual([
            'acme/inventory|major|orders',
            'acme/inventory|major|payment',
            'acme/inventory|patch|shipping',
            'acme/messaging,beta|none|',
        ]);
    });
});

describe('buildFlatDepsRows field fidelity', () => {
    it('round-trips drift_level, required_version, commits_12mo and is_dev/is_locked flags', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const orders = rows.find(r => r.consumer_name === 'orders')!;
        expect(orders.drift_level).toBe('major');
        expect(orders.required_version).toBe('^1.0.0');
        expect(orders.commits_12mo).toBe(42);
        expect(orders.is_dev).toBe('');
        expect(orders.is_locked).toBe('yes');
        expect(orders.is_internal).toBe('yes');
        expect(orders.installed_version).toBe('1.0.0');
        expect(orders.latest_published).toBe('2.1.0');
        expect(orders.version_confidence).toBe('tag');
        expect(orders.published_by).toBe('acme-platform');
        expect(orders.team).toBe('team-orders');
    });

    it('emits empty string when livenessCommits is null (no "undefined" leakage)', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const payment = rows.find(r => r.consumer_name === 'payment')!;
        expect(payment.commits_12mo).toBe('');
    });

    it('emits "yes" for isDev versions', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const shipping = rows.find(r => r.consumer_name === 'shipping')!;
        expect(shipping.is_dev).toBe('yes');
    });

    it('qualifies consumers from monorepos with the repo prefix and leaves single-service repos bare', () => {
        const rows = buildFlatDepsRows(reportFixture());
        // acme-monorepo hosts orders + payment → multi-service repo → qualify both
        const orders = rows.find(r => r.consumer_name === 'orders')!;
        const payment = rows.find(r => r.consumer_name === 'payment')!;
        expect(orders.consumer_qualified).toBe('acme-monorepo');
        expect(payment.consumer_qualified).toBe('acme-monorepo');
        // acme-shipping hosts only shipping (non-generic name) → no qualification
        const shipping = rows.find(r => r.consumer_name === 'shipping')!;
        expect(shipping.consumer_qualified).toBe('');
    });
});

describe('end-to-end CSV emission', () => {
    it('quotes a package name that contains a comma', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const headers = [...FLAT_DEPS_HEADERS];
        const data = rows.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, data);
        const lines = csv.split('\n');
        // header + 4 data rows
        expect(lines).toHaveLength(5);
        const orphanLine = lines.find(l => l.startsWith('"acme/messaging,beta",'))!;
        expect(orphanLine).toBeDefined();
        expect(orphanLine.startsWith('"acme/messaging,beta",composer,,0.9.0,,,none,')).toBe(true);
    });

    it('preserves the >= comparator in required_version, raw, no double-encoding', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const headers = [...FLAT_DEPS_HEADERS];
        const data = rows.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, data);
        expect(csv).toContain('"');
        // The payment row has required_version=">=1, <2" (has a comma → quoted).
        expect(csv).toContain('">=1, <2"');
    });

    it('does not leak the literal string "undefined" for empty fields', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const headers = [...FLAT_DEPS_HEADERS];
        const data = rows.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, data);
        expect(csv).not.toContain('undefined');
    });

    it('header row matches the FLAT_DEPS_HEADERS tuple exactly', () => {
        const rows = buildFlatDepsRows(reportFixture());
        const headers = [...FLAT_DEPS_HEADERS];
        const data = rows.map(r => headers.map(h => r[h]));
        const csv = rowsToCsv(headers, data);
        const headerLine = csv.split('\n')[0];
        expect(headerLine).toBe(FLAT_DEPS_HEADERS.join(','));
    });
});

describe('buildFlatDepsRows empty payload', () => {
    it('returns an empty array when report.packages is empty', () => {
        const empty: DepsReport = { packages: [], summary: { totalPackages: 0, totalWithSkew: 0, ecosystems: [] } };
        const rows: FlatDepsRow[] = buildFlatDepsRows(empty);
        expect(rows).toEqual([]);
    });
});
