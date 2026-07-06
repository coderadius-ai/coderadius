import { describe, expect, it } from 'vitest';
import type { DepsReport } from '@coderadius/shared-types';
import {
    buildPackageRegistryModel,
    filterPackageRows,
    sortCveIdsBySeverity,
    summarizeCveSeverities,
} from '../../../packages/dashboard-ui/src/components/package-registry/packageRegistryModel';

function reportFixture(): DepsReport {
    return {
        packages: [
            {
                packageName: '@acme/freight-sdk',
                ecosystem: 'npm',
                isInternal: true,
                latestPublished: '2.0.0',
                versionConfidence: 'tag',
                publishedBy: 'platform-orders',
                totalConsumers: 3,
                hasVersionSkew: true,
                drift: {
                    maxLevel: 'major',
                    consumersAtMajorDrift: 1,
                    consumersAtMinorDrift: 0,
                    consumersAtPatchDrift: 0,
                    consumersUpToDate: 2,
                },
                versions: [
                    {
                        displayVersion: '2.0.0',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'none',
                        consumers: [
                            { name: 'orders-core', type: 'Service', team: 'platform-orders', url: null, repoName: 'orders-core', requiredVersion: '^2.0.0' },
                            { name: 'checkout-web', type: 'Service', team: 'platform-checkout', url: null, repoName: 'checkout-web', requiredVersion: '^2.0.0' },
                        ],
                    },
                    {
                        displayVersion: '1.0.0',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'major',
                        consumers: [
                            { name: 'audit-log', type: 'Service', team: 'platform-security', url: 'git@gitlab.com:acme/audit-log.git', repoName: 'audit-log', requiredVersion: '^1.0.0' },
                        ],
                    },
                ],
            },
            {
                packageName: 'symfony/http-kernel',
                ecosystem: 'composer',
                isInternal: false,
                latestPublished: '6.4.2',
                totalConsumers: 2,
                hasVersionSkew: true,
                drift: {
                    maxLevel: 'minor',
                    consumersAtMajorDrift: 0,
                    consumersAtMinorDrift: 1,
                    consumersAtPatchDrift: 0,
                    consumersUpToDate: 1,
                },
                versions: [
                    {
                        displayVersion: '6.4.2',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'none',
                        consumers: [
                            { name: 'orders-core', type: 'Repository', team: 'platform-orders', url: null, repoName: 'orders-core', requiredVersion: '^6.4' },
                        ],
                    },
                    {
                        displayVersion: '5.4.32',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'minor',
                        consumers: [
                            { name: 'carrier-portal', type: 'Repository', team: 'platform-distribution', url: null, repoName: 'carrier-portal', requiredVersion: '^5.4' },
                        ],
                    },
                ],
            },
            {
                packageName: 'doctrine/orm',
                ecosystem: 'composer',
                isInternal: false,
                totalConsumers: 1,
                hasVersionSkew: false,
                vulnerabilities: [
                    { osvId: 'GHSA-aaaa-bbbb-cccc', severity: 'MEDIUM', summary: 'Order query injection' },
                    { osvId: 'GHSA-dddd-eeee-ffff', severity: 'HIGH', summary: 'Inventory cache poisoning' },
                    { osvId: 'GHSA-gggg-hhhh-iiii', severity: 'UNKNOWN' },
                ],
                versions: [
                    {
                        displayVersion: '3.0.0',
                        isLocked: true,
                        isDev: false,
                        driftLevel: 'none',
                        consumers: [
                            { name: 'pricing-engine', type: 'Repository', team: 'platform-pricing', url: null, repoName: 'pricing-engine', requiredVersion: '^3' },
                        ],
                    },
                ],
            },
        ],
        summary: {
            totalPackages: 3,
            totalWithSkew: 2,
            ecosystems: ['composer', 'npm'],
        },
    };
}

describe('buildPackageRegistryModel', () => {
    it('derives registry counts from real package drift data', () => {
        const model = buildPackageRegistryModel(reportFixture());
        expect(model.summary).toMatchObject({
            totalPackages: 3,
            internalCount: 1,
            driftedCount: 2,
            blockedCount: 1,
        });
    });

    it('falls back to the highest installed version when latestPublished is missing', () => {
        const model = buildPackageRegistryModel(reportFixture());
        const doctrine = model.rows.find(row => row.packageName === 'doctrine/orm')!;
        expect(doctrine.latestVersion).toBe('3.0.0');
        expect(doctrine.latestLabel).toBe('3.0.0');
    });

    it('surfaces the worst vulnerability severity per package', () => {
        const model = buildPackageRegistryModel(reportFixture());
        const doctrine = model.rows.find(row => row.packageName === 'doctrine/orm')!;
        expect(doctrine.hasVulnerabilities).toBe(true);
        expect(doctrine.maxVulnSeverity).toBe('HIGH');

        const clean = model.rows.find(row => row.packageName === 'symfony/http-kernel')!;
        expect(clean.maxVulnSeverity).toBeNull();
    });

    it('sorts CVE labels worst-first so the visible slice shows the most severe', () => {
        const model = buildPackageRegistryModel(reportFixture());
        const doctrine = model.rows.find(row => row.packageName === 'doctrine/orm')!;
        expect(doctrine.cveLabels.map(label => label.severity)).toEqual(['HIGH', 'MEDIUM', 'UNKNOWN']);
    });

    it('drops summaries that merely repeat the advisory id', () => {
        const report = reportFixture();
        report.packages[2].vulnerabilities!.push(
            { osvId: 'GHSA-jjjj-kkkk-llll', severity: 'LOW', summary: 'GHSA-jjjj-kkkk-llll' },
        );
        const model = buildPackageRegistryModel(report);
        const doctrine = model.rows.find(row => row.packageName === 'doctrine/orm')!;
        const echoed = doctrine.cveLabels.find(label => label.osvId === 'GHSA-jjjj-kkkk-llll')!;
        expect(echoed.summary).toBeUndefined();
    });

    it('computes adoption percent from aligned consumers over total consumers', () => {
        const model = buildPackageRegistryModel(reportFixture());
        const sdk = model.rows.find(row => row.packageName === '@acme/freight-sdk')!;
        expect(sdk.adoptionPercent).toBe(67);
        expect(sdk.isBlocked).toBe(true);
        expect(sdk.breakdown[0].status).toBe('major');
    });
});

describe('summarizeCveSeverities', () => {
    it('renders a compact distribution in severity order', () => {
        expect(summarizeCveSeverities([
            { severity: 'MEDIUM' },
            { severity: 'CRITICAL' },
            { severity: 'MEDIUM' },
            { severity: 'HIGH' },
        ])).toBe('1 critical, 1 high, 2 medium');
    });

    it('returns an empty string for no labels', () => {
        expect(summarizeCveSeverities([])).toBe('');
    });
});

describe('sortCveIdsBySeverity', () => {
    const labels = buildPackageRegistryModel(reportFixture())
        .rows.find(row => row.packageName === 'doctrine/orm')!.cveLabels;

    it('re-orders raw ids by their label severity', () => {
        expect(sortCveIdsBySeverity(
            ['GHSA-gggg-hhhh-iiii', 'GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'],
            labels,
        )).toEqual(['GHSA-dddd-eeee-ffff', 'GHSA-aaaa-bbbb-cccc', 'GHSA-gggg-hhhh-iiii']);
    });

    it('passes through undefined and single-element lists', () => {
        expect(sortCveIdsBySeverity(undefined, labels)).toBeUndefined();
        expect(sortCveIdsBySeverity(['GHSA-aaaa-bbbb-cccc'], labels)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    });
});

describe('filterPackageRows', () => {
    it('filters by internal tab, drift chip, blocked chip, and vulnerable chip', () => {
        const model = buildPackageRegistryModel(reportFixture());
        expect(filterPackageRows(model.rows, 'internal', 'all')).toHaveLength(1);
        expect(filterPackageRows(model.rows, 'all', 'drift')).toHaveLength(2);
        expect(filterPackageRows(model.rows, 'all', 'blocked')).toHaveLength(1);
        expect(filterPackageRows(model.rows, 'all', 'vulnerable')).toEqual(
            [expect.objectContaining({ packageName: 'doctrine/orm' })],
        );
    });
});
