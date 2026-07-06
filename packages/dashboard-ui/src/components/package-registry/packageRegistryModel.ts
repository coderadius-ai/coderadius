import type { DepsPackageGroup, DepsReport, DepsVulnerability } from '@coderadius/shared-types';
import { resolveVulnerabilityDisplayId } from '@coderadius/shared-types';
import { toHttpUrl } from '../../transformers/utils';

interface CveLabel {
    id: string;
    osvId: string;
    summary?: string;
    severity: string;
}

function extractCveLabels(vulns?: DepsVulnerability[]): CveLabel[] {
    if (!vulns || vulns.length === 0) return [];
    const seen = new Set<string>();
    const labels: CveLabel[] = [];
    for (const v of vulns) {
        const cve = resolveVulnerabilityDisplayId(v);
        if (!seen.has(cve)) {
            seen.add(cve);
            // Some advisories carry no summary and persist the id as fallback; an
            // id masquerading as prose is noise, drop it.
            const summary = v.summary === v.osvId ? undefined : v.summary;
            labels.push({ id: cve, osvId: v.osvId, summary, severity: v.severity });
        }
    }
    // Worst first: the visible slice must surface the most severe advisories.
    return labels.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Re-order raw CVE ids so the visible slice shows the worst ones first. */
export function sortCveIdsBySeverity(cveIds: string[] | undefined, labels: CveLabel[]): string[] | undefined {
    if (!cveIds || cveIds.length < 2) return cveIds;
    const rank = new Map(labels.map(label => [label.id, severityRank(label.severity)]));
    return [...cveIds].sort((a, b) => (rank.get(a) ?? SEVERITY_ORDER.length) - (rank.get(b) ?? SEVERITY_ORDER.length));
}

/** Compact severity distribution, e.g. "2 critical, 9 high, 11 medium". */
export function summarizeCveSeverities(labels: readonly { severity: string }[]): string {
    return SEVERITY_ORDER
        .map(severity => ({ severity, count: labels.filter(label => label.severity === severity).length }))
        .filter(entry => entry.count > 0)
        .map(entry => `${entry.count} ${entry.severity.toLowerCase()}`)
        .join(', ');
}

export type PackageRegistryTab = 'all' | 'internal';
export type PackageRegistryFilter = 'all' | 'drift' | 'blocked' | 'vulnerable';
export type PackageRegistryRisk = 'aligned' | 'patch' | 'minor' | 'major' | 'unknown';
export type PackageRegistryTone = 'signal' | 'danger' | 'warn' | 'ok' | 'neutral' | 'muted';

export interface PackageRegistrySegment {
    value: number;
    label: string;
    tone: PackageRegistryTone;
}

export interface PackageRegistryConsumerRow {
    id: string;
    name: string;
    displayName: string;
    repoName: string | null;
    team: string | null;
    url: string | null;
    version: string;
    requiredVersion: string;
    status: PackageRegistryRisk;
    statusLabel: string;
    cveIds?: string[];
}

export interface PackageRegistryRow {
    rowId: string;
    packageName: string;
    ecosystem: string;
    isInternal: boolean;
    latestVersion: string | null;
    latestLabel: string;
    versionConfidence: string | null;
    versionCount: number;
    consumerCount: number;
    consumerKindLabel: 'services' | 'repos' | 'consumers';
    publisherLabel: string | null;
    teams: string[];
    risk: PackageRegistryRisk;
    riskLabel: string;
    isDrifted: boolean;
    isBlocked: boolean;
    vulnerabilityCount: number;
    criticalVulnCount: number;
    highVulnCount: number;
    hasVulnerabilities: boolean;
    /** Worst severity across known vulnerabilities, null when clean. */
    maxVulnSeverity: DepsVulnerability['severity'] | null;
    cveLabels: CveLabel[];
    adoptionPercent: number | null;
    adoptionSegments: PackageRegistrySegment[];
    breakdown: PackageRegistryConsumerRow[];
    source: DepsPackageGroup;
}

export interface PackageRegistryModel {
    rows: PackageRegistryRow[];
    summary: {
        totalPackages: number;
        internalCount: number;
        driftedCount: number;
        blockedCount: number;
        vulnerableCount: number;
        ecosystems: string[];
    };
}

const DRIFT_RANK: Record<PackageRegistryRisk, number> = {
    major: 4,
    minor: 3,
    patch: 2,
    aligned: 1,
    unknown: 0,
};

export function buildPackageRegistryModel(report: DepsReport): PackageRegistryModel {
    const rows = report.packages
        .map(buildPackageRegistryRow)
        .sort((a, b) =>
            a.ecosystem.localeCompare(b.ecosystem)
            || Number(b.isBlocked) - Number(a.isBlocked)
            || Number(b.isDrifted) - Number(a.isDrifted)
            || b.consumerCount - a.consumerCount
            || a.packageName.localeCompare(b.packageName),
        );

    return {
        rows,
        summary: {
            totalPackages: rows.length,
            internalCount: rows.filter(row => row.isInternal).length,
            driftedCount: rows.filter(row => row.isDrifted).length,
            blockedCount: rows.filter(row => row.isBlocked).length,
            vulnerableCount: rows.filter(row => row.hasVulnerabilities).length,
            ecosystems: [...new Set(rows.map(row => row.ecosystem))].sort(),
        },
    };
}

export function filterPackageRows(
    rows: readonly PackageRegistryRow[],
    tab: PackageRegistryTab,
    filter: PackageRegistryFilter,
) {
    return rows.filter(row => {
        if (tab === 'internal' && !row.isInternal) return false;
        if (filter === 'drift' && !row.isDrifted) return false;
        if (filter === 'blocked' && !row.isBlocked) return false;
        if (filter === 'vulnerable' && !row.hasVulnerabilities) return false;
        return true;
    });
}

function buildPackageRegistryRow(pkg: DepsPackageGroup): PackageRegistryRow {
    const latestVersion = pkg.latestPublished ?? inferLatestVersion(pkg);
    const cveLabels = extractCveLabels(pkg.vulnerabilities);
    const breakdown = buildConsumerBreakdown(pkg, latestVersion, cveLabels);
    const consumerCount = getDistinctConsumerCount(pkg);
    const teams = topTeams(pkg);
    const risk = getPackageRisk(pkg);
    const alignedConsumers = countAlignedConsumers(pkg, latestVersion);
    const adoptionPercent = consumerCount > 0
        ? Math.round((alignedConsumers / consumerCount) * 100)
        : null;
    const adoptionSegments = buildAdoptionSegments(pkg, latestVersion);
    const publisherLabel = pkg.isInternal && pkg.publishedBy
        ? pkg.publishedBy
        : teams[0] ?? null;
    const latestLabel = latestVersion ?? '—';
    const riskLabel = riskToLabel(risk);

    return {
        rowId: `${pkg.ecosystem}:${pkg.packageName}`,
        packageName: pkg.packageName,
        ecosystem: pkg.ecosystem,
        isInternal: pkg.isInternal,
        latestVersion,
        latestLabel,
        versionConfidence: pkg.versionConfidence ?? null,
        versionCount: pkg.versions.length,
        consumerCount,
        consumerKindLabel: consumerKindLabel(pkg),
        publisherLabel,
        teams,
        risk,
        riskLabel,
        isDrifted: risk === 'patch' || risk === 'minor' || risk === 'major',
        isBlocked: risk === 'major',
        vulnerabilityCount: pkg.vulnerabilities?.length ?? 0,
        criticalVulnCount: pkg.vulnerabilities?.filter(v => v.severity === 'CRITICAL').length ?? 0,
        highVulnCount: pkg.vulnerabilities?.filter(v => v.severity === 'HIGH').length ?? 0,
        hasVulnerabilities: (pkg.vulnerabilities?.length ?? 0) > 0,
        maxVulnSeverity: maxVulnSeverity(pkg.vulnerabilities),
        cveLabels,
        adoptionPercent,
        adoptionSegments,
        breakdown,
        source: pkg,
    };
}

const SEVERITY_ORDER: DepsVulnerability['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function severityRank(severity: string): number {
    const rank = SEVERITY_ORDER.indexOf(severity as DepsVulnerability['severity']);
    return rank === -1 ? SEVERITY_ORDER.length : rank;
}

function maxVulnSeverity(vulns?: DepsVulnerability[]): DepsVulnerability['severity'] | null {
    if (!vulns || vulns.length === 0) return null;
    return SEVERITY_ORDER.find(severity => vulns.some(v => v.severity === severity)) ?? 'UNKNOWN';
}

function buildConsumerBreakdown(pkg: DepsPackageGroup, latestVersion: string | null, cveLabels: CveLabel[]): PackageRegistryConsumerRow[] {
    const rows: PackageRegistryConsumerRow[] = [];
    for (const version of pkg.versions) {
        const status = statusFromVersion(version.driftLevel, version.displayVersion, latestVersion);
        for (const consumer of version.consumers) {
            const displayName = consumer.repoName || consumer.name;
            rows.push({
                id: `${version.displayVersion}:${consumer.type}:${consumer.name}:${consumer.repoName ?? ''}`,
                name: consumer.name,
                displayName,
                repoName: consumer.repoName,
                team: consumer.team,
                url: consumer.url ? toHttpUrl(consumer.url) : null,
                version: version.displayVersion || '?',
                requiredVersion: consumer.requiredVersion,
                status,
                statusLabel: consumerStatusLabel(status, latestVersion),
                cveIds: sortCveIdsBySeverity(version.cveIds, cveLabels),
            });
        }
    }
    return rows.sort((a, b) =>
        DRIFT_RANK[b.status] - DRIFT_RANK[a.status]
        || a.displayName.localeCompare(b.displayName)
        || a.name.localeCompare(b.name),
    );
}

function buildAdoptionSegments(pkg: DepsPackageGroup, latestVersion: string | null): PackageRegistrySegment[] {
    const segments = pkg.versions
        .map(version => {
            const value = version.consumers.length;
            const status = statusFromVersion(version.driftLevel, version.displayVersion, latestVersion);
            return {
                value,
                label: `${version.displayVersion || '?'} · ${value} consumer${value === 1 ? '' : 's'}`,
                tone: toneFromStatus(status),
            };
        })
        .filter(segment => segment.value > 0);

    return segments.length > 0
        ? segments
        : [{ value: 1, label: 'No consumers', tone: 'muted' }];
}

function countAlignedConsumers(pkg: DepsPackageGroup, latestVersion: string | null) {
    if (!latestVersion) return 0;
    return pkg.versions.reduce((sum, version) => {
        const status = statusFromVersion(version.driftLevel, version.displayVersion, latestVersion);
        return status === 'aligned' ? sum + version.consumers.length : sum;
    }, 0);
}

function getPackageRisk(pkg: DepsPackageGroup): PackageRegistryRisk {
    const levels = pkg.versions.map(version => statusFromVersion(version.driftLevel, version.displayVersion, pkg.latestPublished ?? null));
    if (pkg.drift?.maxLevel === 'major' || levels.includes('major')) return 'major';
    if (pkg.drift?.maxLevel === 'minor' || levels.includes('minor')) return 'minor';
    if (pkg.drift?.maxLevel === 'patch' || levels.includes('patch')) return 'patch';
    if (pkg.drift?.maxLevel === 'none' || levels.includes('aligned')) return 'aligned';
    return 'unknown';
}

function statusFromVersion(
    driftLevel: DepsPackageGroup['versions'][number]['driftLevel'],
    version: string,
    latestVersion: string | null,
): PackageRegistryRisk {
    if (driftLevel === 'major') return 'major';
    if (driftLevel === 'minor') return 'minor';
    if (driftLevel === 'patch') return 'patch';
    if (driftLevel === 'none') return 'aligned';
    if (latestVersion && sameVersion(version, latestVersion)) return 'aligned';
    return 'unknown';
}

function toneFromStatus(status: PackageRegistryRisk): PackageRegistryTone {
    if (status === 'major') return 'danger';
    if (status === 'minor') return 'warn';
    if (status === 'patch' || status === 'aligned') return 'ok';
    return 'muted';
}

function riskToLabel(status: PackageRegistryRisk) {
    switch (status) {
        case 'major': return 'major drift';
        case 'minor': return 'minor drift';
        case 'patch': return 'patch drift';
        case 'aligned': return 'aligned';
        default: return 'unknown';
    }
}

function consumerStatusLabel(status: PackageRegistryRisk, _latestVersion: string | null) {
    switch (status) {
        case 'major': return 'major behind';
        case 'minor': return 'minor behind';
        case 'patch': return 'patch available';
        case 'aligned': return 'aligned';
        default: return 'unknown';
    }
}

function getDistinctConsumerCount(pkg: DepsPackageGroup) {
    const consumers = new Set<string>();
    for (const version of pkg.versions) {
        for (const consumer of version.consumers) {
            consumers.add(`${consumer.type}:${consumer.repoName ?? ''}:${consumer.name}`);
        }
    }
    return consumers.size || pkg.totalConsumers || 0;
}

function consumerKindLabel(pkg: DepsPackageGroup): PackageRegistryRow['consumerKindLabel'] {
    const types = new Set<string>();
    for (const version of pkg.versions) {
        for (const consumer of version.consumers) {
            types.add(consumer.type);
        }
    }
    if (types.size === 1 && types.has('Service')) return 'services';
    if (types.size === 1 && types.has('Repository')) return 'repos';
    return 'consumers';
}

function topTeams(pkg: DepsPackageGroup) {
    const counts = new Map<string, number>();
    for (const version of pkg.versions) {
        for (const consumer of version.consumers) {
            if (!consumer.team) continue;
            counts.set(consumer.team, (counts.get(consumer.team) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([team]) => team);
}

function inferLatestVersion(pkg: DepsPackageGroup) {
    const versions = pkg.versions
        .map(version => version.displayVersion)
        .filter(Boolean);
    if (versions.length === 0) return null;
    return versions.sort(compareVersionsDesc)[0] ?? null;
}

function compareVersionsDesc(a: string, b: string) {
    const aParts = semverParts(a);
    const bParts = semverParts(b);
    if (aParts && bParts) {
        for (let i = 0; i < 3; i += 1) {
            if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
        }
        return a.localeCompare(b);
    }
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}

function sameVersion(a: string, b: string) {
    return normalizeVersion(a) === normalizeVersion(b);
}

function normalizeVersion(version: string) {
    return version.trim().replace(/^v/i, '');
}

function semverParts(version: string): [number, number, number] | null {
    const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
