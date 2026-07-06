import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DepsReport } from '@coderadius/shared-types';
import type { Table } from '@tanstack/react-table';
import { Biohazard, Download, ExternalLink, Package as PackageIcon, SearchX } from 'lucide-react';
import { OperatorTable, type OperatorTableColumn } from '../OperatorTable';
import { SimpleTooltip } from '../Tooltip';
import { NodeIcon, EcosystemIcon } from '../Taxonomy';
import { CrButton, CrChipGroup, EmptyState, OperatorFilter, RowExpand, SegmentedBar, StatusBar, StatusBarDot, StatusBarKbd, StatusBarOk, StatusBarSep, ToggleGroup, useOperatorTable } from '../design-system';
import type { CrChipOption } from '../design-system';
import type { SegmentedBarSegment } from '../design-system';
import { downloadCsv, rowsToCsv } from '../../lib/csv';
import { toHttpUrl } from '../../transformers/utils';
import { buildFlatDepsRows, FLAT_DEPS_HEADERS } from '../../transformers/deps.transformer';
import {
    buildPackageRegistryModel,
    filterPackageRows,
    sortCveIdsBySeverity,
    summarizeCveSeverities,
    type PackageRegistryConsumerRow,
    type PackageRegistryFilter,
    type PackageRegistryRow,
    type PackageRegistryTab,
} from './packageRegistryModel';

export function PackageRegistryView({
    report,
    meta,
}: {
    report: DepsReport;
    meta?: { cliVersion?: string; generatedAt?: string };
}) {
    const [activeTab, setActiveTab] = useState<PackageRegistryTab>('all');
    const [activeFilter, setActiveFilter] = useState<PackageRegistryFilter>('all');
    const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
    const [vulnFocusRow, setVulnFocusRow] = useState<string | null>(null);
    const model = useMemo(() => buildPackageRegistryModel(report), [report]);
    const scopedRows = useMemo(
        () => filterPackageRows(model.rows, activeTab, activeFilter),
        [model.rows, activeTab, activeFilter],
    );
    const internalRows = model.rows.filter(row => row.isInternal).length;

    const toggleRow = useCallback((rowId: string) => {
        setVulnFocusRow(null);
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(rowId)) next.delete(rowId);
            else next.add(rowId);
            return next;
        });
    }, []);
    const openVulnerabilities = useCallback((rowId: string) => {
        setVulnFocusRow(rowId);
        setExpandedRows(prev => prev.has(rowId) ? prev : new Set(prev).add(rowId));
    }, []);
    const columns = usePackageColumns(openVulnerabilities);
    const packageTable = useOperatorTable({
        data: scopedRows,
        columns,
        enablePagination: false,
    });

    const handleTabChange = useCallback((tab: PackageRegistryTab) => {
        setActiveTab(tab);
        setActiveFilter('all');
        setExpandedRows(new Set());
        setVulnFocusRow(null);
        packageTable.setGlobalFilter('');
    }, [packageTable]);

    const activeFilterSet = useMemo(() => activeFilter === 'all' ? new Set<PackageRegistryFilter>() : new Set([activeFilter]), [activeFilter]);
    const packageFilterChips = useMemo<CrChipOption<PackageRegistryFilter>[]>(() => [
        { value: 'drift', label: 'Drift', count: model.summary.driftedCount, tone: 'warn' },
        { value: 'blocked', label: 'Blocked', count: model.summary.blockedCount, tone: 'danger' },
        { value: 'vulnerable', label: 'Vulnerable', count: model.summary.vulnerableCount, tone: 'danger' },
    ], [model.summary]);

    const handleExport = () => {
        if (model.summary.totalPackages === 0) return;
        const flatRows = buildFlatDepsRows(report);
        const headers = [...FLAT_DEPS_HEADERS];
        const data = flatRows.map(row => headers.map(header => row[header]));
        downloadCsv(rowsToCsv(headers, data), `package-registry-${new Date().toISOString().slice(0, 10)}.csv`);
    };

    return (
        <section className="cr-page-shell" aria-label="Package Intelligence">
            <div className="cr-page-identity" role="region" aria-label="Package registry summary">
                <div className="cr-page-identity__copy">
                    <h2>
                        <span className="cr-page-identity__mark cr-package-mark" aria-hidden="true">
                            <PackageIcon size={16} />
                        </span>
                        Package Intelligence
                    </h2>
                    <p>Cross-org package inventory and version governance.</p>
                </div>
                <div className="cr-page-kpis" aria-label="Package metrics">
                    <PackageKpi value={model.summary.totalPackages} label="Packages" />
                    <PackageKpi value={model.summary.internalCount} label="Internal" tone="internal" />
                    <span className="cr-page-kpi-sep" aria-hidden="true" />
                    <PackageKpi value={model.summary.driftedCount} label="Drifted" tone="warn" />
                    <PackageKpi value={model.summary.blockedCount} label="Blocked" tone="danger" />
                    {model.summary.vulnerableCount > 0 && (
                        <PackageKpi value={model.summary.vulnerableCount} label="Vulnerable" tone="danger" />
                    )}
                </div>
            </div>

            <div className="cr-page-tabs-strip">
                <nav className="cr-page-tabs" aria-label="Package registry sections">
                    <PackageTab
                        active={activeTab === 'all'}
                        label="All packages"
                        count={model.rows.length}
                        onClick={() => handleTabChange('all')}
                    />
                    <PackageTab
                        active={activeTab === 'internal'}
                        label="Internal registry"
                        count={internalRows}
                        accent="internal"
                        onClick={() => handleTabChange('internal')}
                    />
                </nav>
                <div className="cr-page-actions cr-package-actions">
                    <CrChipGroup
                        options={packageFilterChips}
                        value={activeFilterSet}
                        onChange={v => setActiveFilter(activeFilter === v ? 'all' : v)}
                    />
                    <OperatorFilter
                        columns={columns}
                        data={scopedRows}
                        table={packageTable.table}
                        setGlobalFilter={packageTable.setGlobalFilter}
                        setColumnFilters={packageTable.setColumnFilters}
                        scopes={PACKAGE_FILTER_SCOPES}
                        placeholder="filter package, version, publisher…"
                        className="cr-package-filter-wrap"
                    />
                    <CrButton
                        icon={<Download size={13} />}
                        onClick={handleExport}
                        disabled={model.summary.totalPackages === 0}
                        title={model.summary.totalPackages === 0 ? 'No packages to export' : `Export ${model.summary.totalPackages} packages`}
                    >Export</CrButton>
                </div>
            </div>

            <PackageTable
                table={packageTable.table}
                columns={columns}
                expandedRows={expandedRows}
                onRowClick={toggleRow}
                vulnFocusRow={vulnFocusRow}
            />

            <StatusBar
                className="cr-package-statusbar"
                left={<>
                    {meta?.cliVersion && <span>v{meta.cliVersion}</span>}
                    {meta?.cliVersion && <StatusBarSep />}
                    <span>{formatStatusTimestamp(meta?.generatedAt)}</span>
                    <StatusBarSep />
                    <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                    <StatusBarSep />
                    <span>grouped by ecosystem</span>
                </>}
                right={<>
                    <span>{packageTable.filteredRowCount} of {model.rows.length}</span>
                    <StatusBarSep />
                    <span>{activeFilter}</span>
                    {packageTable.sortingDescription && <>
                        <StatusBarSep />
                        <span>{packageTable.sortingDescription}</span>
                    </>}
                    <StatusBarSep />
                    <span><StatusBarKbd>⌘K</StatusBarKbd> COMMAND</span>
                </>}
            />
        </section>
    );
}

function PackageTable({
    table,
    columns,
    expandedRows,
    onRowClick,
    vulnFocusRow,
}: {
    table: Table<PackageRegistryRow>;
    columns: OperatorTableColumn<PackageRegistryRow>[];
    expandedRows: ReadonlySet<string>;
    onRowClick: (rowId: string) => void;
    vulnFocusRow: string | null;
}) {
    const handleRowClick = useCallback((row: PackageRegistryRow) => onRowClick(row.rowId), [onRowClick]);
    return (
        <div className="cr-page-body">
            <OperatorTable
                table={table}
                columns={columns}
                getRowKey={row => row.rowId}
                onRowClick={handleRowClick}
                groupBy={row => row.ecosystem}
                renderGroupHeader={(ecosystem, groupRows) => <PackageGroupHeader ecosystem={ecosystem} rows={groupRows} />}
                expandedRowKeys={expandedRows}
                renderExpandedRow={row => (
                    <PackageBreakdown row={row} initialView={row.rowId === vulnFocusRow ? 'vulns' : undefined} />
                )}
                tableClassName="cr-package-table"
                minWidth="1120px"
                hidePagination
                emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No packages match this filter" detail="Adjust or clear the filter to see more." />}
            />
        </div>
    );
}

const PACKAGE_FILTER_SCOPES = [
    { columnId: 'package', label: 'Package', color: '#5B7CFF' },
    { columnId: 'ecosystem', label: 'Ecosystem', color: '#4ade80' },
    { columnId: 'adoption', label: 'Risk', color: '#E2A23E' },
    { columnId: 'consumers', label: 'Consumer', color: '#46A758' },
    { columnId: 'publisher', label: 'Team', color: '#A78BFA' },
];

function usePackageColumns(onVulnFocus: (rowId: string) => void) {
    return useMemo<OperatorTableColumn<PackageRegistryRow>[]>(() => [
        {
            id: 'package',
            header: 'Package',
            width: '46%',
            sortValue: row => `${row.packageName}`,
            filterValue: row => [
                row.packageName,
                row.ecosystem,
                row.isInternal ? 'internal' : 'external',
            ].join(' '),
            render: row => <PackageNameCell row={row} onVulnFocus={onVulnFocus} />,
        },
        {
            id: 'latest',
            header: 'Latest',
            width: '120px',
            className: 'cr-package-latest',
            sortValue: row => versionSortValue(row.latestVersion),
            filterValue: row => row.latestLabel,
            render: row => (
                <SimpleTooltip content={row.versionConfidence ? `Version confidence: ${row.versionConfidence}` : undefined}>
                    <span>{row.latestLabel}</span>
                </SimpleTooltip>
            ),
        },
        {
            id: 'adoption',
            header: 'Adoption health',
            width: '270px',
            align: 'right',
            sortValue: row => row.adoptionPercent ?? -1,
            filterValue: row => [
                row.riskLabel,
                row.risk,
                row.isDrifted ? 'drift drifted' : 'aligned',
                row.isBlocked ? 'blocked' : '',
                row.adoptionPercent,
            ].filter(Boolean).join(' '),
            render: row => <AdoptionHealth row={row} />,
        },
        {
            id: 'consumers',
            header: 'Consumers',
            width: '150px',
            className: 'cr-package-consumers-cell',
            align: 'right',
            sortValue: row => row.consumerCount,
            filterValue: row => [
                row.consumerCount,
                row.consumerKindLabel,
                ...row.breakdown.flatMap(item => [item.name, item.displayName, item.repoName, item.team, item.version, item.statusLabel]),
            ].filter(Boolean).join(' '),
            render: row => {
                const label = row.consumerCount === 1 ? row.consumerKindLabel.replace(/s$/, '') : row.consumerKindLabel;
                return (
                    <span className="cr-package-consumers">
                        <span className="cr-package-consumers__num">{row.consumerCount}</span>
                        {label}
                    </span>
                );
            },
        },
        {
            id: 'publisher',
            header: 'Publisher / Teams',
            width: '210px',
            sortValue: row => row.publisherLabel ?? '',
            filterValue: row => [
                row.publisherLabel,
                ...row.teams,
            ].filter(Boolean).join(' '),
            render: row => <PublisherCell row={row} />,
        },
        {
            id: 'ecosystem',
            header: '',
            hidden: true,
            filterValue: row => row.ecosystem,
            render: () => null,
        },
        {
            id: 'expand',
            header: '',
            width: '52px',
            align: 'right',
            sortable: false,
            render: () => <RowExpand />,
        },
    ], [onVulnFocus]);
}

function versionSortValue(value: string | null) {
    if (!value) return '';
    return value
        .split(/[^0-9A-Za-z]+/)
        .filter(Boolean)
        .map(part => /^\d+$/.test(part) ? part.padStart(8, '0') : part)
        .join('.');
}

function PackageKpi({ value, label, tone }: { value: number | string; label: string; tone?: 'internal' | 'warn' | 'danger' }) {
    return (
        <div className={`cr-page-kpi${tone ? ` cr-page-kpi--${tone}` : ''}`}>
            <span className="cr-page-kpi__num">{value}</span>
            <span className="cr-page-kpi__label">{label}</span>
        </div>
    );
}

function PackageTab({
    active,
    label,
    count,
    accent,
    onClick,
}: {
    active: boolean;
    label: string;
    count: number;
    accent?: 'internal';
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={`cr-page-tab${active ? ' cr-page-tab--active' : ''}${accent ? ` cr-package-tab--${accent}` : ''}`}
            onClick={onClick}
        >
            <span>{label}</span>
            <span className="cr-page-tab__count">{count}</span>
        </button>
    );
}


function PackageNameCell({ row, onVulnFocus }: { row: PackageRegistryRow; onVulnFocus: (rowId: string) => void }) {
    return (
        <div className="cr-package-name-cell">
            <span
                className={`cr-package-risk cr-package-risk--${row.isInternal ? 'internal' : row.risk}`}
                title={row.isInternal ? 'Internal package' : row.riskLabel}
                aria-hidden="true"
            />
            <div className="cr-package-name-copy">
                <span className="cr-package-name-row">
                    <span className="cr-package-name" title={row.packageName}>{row.packageName}</span>
                    {row.hasVulnerabilities && <VulnerabilityFlag row={row} />}
                </span>
                <span className="cr-package-meta">
                    {row.isInternal && <span className="cr-package-meta__internal">internal</span>}
                    <span>{row.ecosystem}</span>
                    {row.cveLabels.length > 0 && row.cveLabels.slice(0, 2).map(cve => (
                        <CveBadge key={cve.id} cve={cve} />
                    ))}
                    {row.cveLabels.length > 2 && (
                        <OverflowCveBadge hidden={row.cveLabels.slice(2)} onOpen={() => onVulnFocus(row.rowId)} />
                    )}
                </span>
            </div>
        </div>
    );
}

function VulnerabilityFlag({ row }: { row: PackageRegistryRow }) {
    const color = CVE_SEVERITY_COLOR[row.maxVulnSeverity ?? 'UNKNOWN'] ?? CVE_SEVERITY_COLOR.UNKNOWN;
    const label = `${row.vulnerabilityCount} known ${row.vulnerabilityCount === 1 ? 'vulnerability' : 'vulnerabilities'}`;
    return (
        <SimpleTooltip content={label}>
            <span className="cr-package-vuln-flag" style={{ color }} aria-label={label}>
                <Biohazard size={12} />
            </span>
        </SimpleTooltip>
    );
}

const TONE_TO_COLOR: Record<string, string> = {
    ok: '#3CC58E',
    warn: '#F2B445',
    danger: '#F04A5C',
    signal: '#5B7CFF',
    neutral: '#B5BCC4',
    muted: '#525B64',
};

function AdoptionHealth({ row }: { row: PackageRegistryRow }) {
    const valueLabel = row.adoptionPercent == null ? '—' : `${row.adoptionPercent}%`;
    const segments: SegmentedBarSegment[] = row.adoptionSegments.map(s => ({
        value: s.value,
        color: TONE_TO_COLOR[s.tone] ?? TONE_TO_COLOR.muted,
        label: s.label,
    }));
    const dominantTone = row.adoptionSegments.reduce((best, s) => s.value > best.value ? s : best, row.adoptionSegments[0]);
    const valueColor = TONE_TO_COLOR[dominantTone?.tone] ?? TONE_TO_COLOR.muted;

    return (
        <div className="cr-package-adoption">
            <div className="cr-package-adoption__bar-row">
                <SegmentedBar segments={segments} height={6} />
                <span className="cr-package-adoption__pct" style={{ color: valueColor }}>{valueLabel}</span>
            </div>
            <span className="cr-package-adoption__meta">
                {row.versionCount} version{row.versionCount === 1 ? '' : 's'} · {row.consumerCount} consumer{row.consumerCount === 1 ? '' : 's'}
            </span>
        </div>
    );
}

function PublisherCell({ row }: { row: PackageRegistryRow }) {
    if (!row.publisherLabel) {
        return <span className="cr-package-null">—</span>;
    }
    return (
        <SimpleTooltip content={row.teams.length > 1 ? row.teams.join(', ') : undefined}>
            <span className={`cr-package-publisher${row.isInternal ? ' cr-package-publisher--internal' : ''}`}>
                {row.publisherLabel}
            </span>
        </SimpleTooltip>
    );
}

const ECOSYSTEM_COLOR: Record<string, string> = {
    npm: '#cb3837',
    composer: '#885630',
    go: '#00add8',
    pypi: '#3775a9',
    maven: '#c71a36',
    nuget: '#004880',
    cargo: '#dea584',
    gem: '#e9573f',
};

function PackageGroupHeader({ ecosystem, rows }: { ecosystem: string; rows: readonly PackageRegistryRow[] }) {
    const internalCount = rows.filter(row => row.isInternal).length;
    return (
        <div className="cr-package-group-head">
            <EcosystemIcon ecosystem={ecosystem} size={16} />
            <span>{ecosystem}</span>
            <span className="cr-package-group-head__count">
                · {rows.length} package{rows.length === 1 ? '' : 's'}
                {internalCount > 0 && <span className="cr-package-group-head__internal"> · {internalCount} internal</span>}
            </span>
        </div>
    );
}

type BreakdownView = 'consumer' | 'version' | 'vulns';

/**
 * The expanded row is a small workspace with segmented views: consumers,
 * version groups, and the full advisory list. Views never stack, so none of
 * them can push another below the fold.
 */
function PackageBreakdown({ row, initialView }: { row: PackageRegistryRow; initialView?: BreakdownView }) {
    const [view, setView] = useState<BreakdownView>(initialView ?? 'consumer');

    // The +N chip can land here while the row is already expanded.
    useEffect(() => {
        if (initialView) setView(initialView);
    }, [initialView]);

    const options = [
        { value: 'consumer' as const, label: 'Consumers' },
        ...(row.source.versions.length > 1 ? [{ value: 'version' as const, label: 'Versions' }] : []),
        ...(row.cveLabels.length > 0 ? [{ value: 'vulns' as const, label: `Vulnerabilities · ${row.cveLabels.length}` }] : []),
    ];

    return (
        <div className="cr-package-breakdown">
            {options.length > 1 && (
                <div className="cr-package-breakdown__view-toggle">
                    <ToggleGroup options={options} value={view} onChange={setView} size="sm" />
                </div>
            )}
            {view === 'consumer' && (row.breakdown.length === 0 ? (
                <div className="cr-package-breakdown--empty">No consumers recorded.</div>
            ) : (
                <>
                    <div className="cr-package-breakdown__col-headers">
                        <span />
                        <SimpleTooltip content="Repo and service using this package"><span>Consumer</span></SimpleTooltip>
                        <SimpleTooltip content="Manifest range resolved to lockfile version"><span>Version</span></SimpleTooltip>
                        <SimpleTooltip content="Drift level and known vulnerabilities"><span>Status</span></SimpleTooltip>
                        <span />
                    </div>
                    <div className="cr-package-breakdown__rows">
                        {row.breakdown.map(item => <PackageBreakdownRow key={item.id} item={item} cveLabels={row.cveLabels} />)}
                    </div>
                </>
            ))}
            {view === 'version' && <VersionFirstBreakdown row={row} />}
            {view === 'vulns' && <VulnerabilityList labels={row.cveLabels} />}
        </div>
    );
}

/**
 * Full advisory list, the destination of the +N overflow chip. Severity
 * appears as text (the 10px hue ramp on the chips is glanceable, not
 * decodable); each row links to OSV.
 */
function VulnerabilityList({ labels }: { labels: PackageRegistryRow['cveLabels'] }) {
    return (
        <div className="cr-package-vulns">
            <div className="cr-package-vulns__col-headers">
                <span>Severity</span>
                <span>Advisory</span>
                <span>Summary</span>
            </div>
            <div className="cr-package-vulns__rows">
                {labels.map(cve => (
                    <a
                        key={cve.id}
                        href={`https://osv.dev/vulnerability/${cve.osvId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cr-package-vulns__row"
                        onClick={e => e.stopPropagation()}
                    >
                        <span
                            className="cr-package-vulns__sev"
                            style={{ color: CVE_SEVERITY_COLOR[cve.severity] ?? CVE_SEVERITY_COLOR.UNKNOWN }}
                        >
                            {cve.severity.toLowerCase()}
                        </span>
                        <span className="cr-package-vulns__id">{cve.id}</span>
                        {cve.summary
                            ? <span className="cr-package-vulns__summary">{cve.summary}</span>
                            : <span className="cr-package-vulns__summary cr-package-vulns__summary--none">—</span>}
                    </a>
                ))}
            </div>
        </div>
    );
}

function VersionFirstBreakdown({ row }: { row: PackageRegistryRow }) {
    return (
        <div className="cr-package-breakdown__versions">
            {row.source.versions.map(v => (
                <div key={v.displayVersion} className="cr-package-breakdown__version-group">
                    <div className="cr-package-breakdown__version-header">
                        <span className={`cr-package-breakdown__state cr-package-breakdown__state--${v.driftLevel ?? 'unknown'}`}>
                            {v.displayVersion}
                        </span>
                        <span className="cr-package-breakdown__version-meta">
                            {v.consumers.length} consumer{v.consumers.length === 1 ? '' : 's'}
                            {v.driftLevel && v.driftLevel !== 'none' && (
                                <span className={`cr-package-breakdown__state cr-package-breakdown__state--${v.driftLevel === 'major' ? 'major' : v.driftLevel === 'minor' ? 'minor' : v.driftLevel === 'patch' ? 'patch' : 'aligned'}`}>
                                    {v.driftLevel} behind
                                </span>
                            )}
                        </span>
                        {v.cveIds && v.cveIds.length > 0 && (
                            <span className="cr-package-breakdown__cves-inline">
                                {sortCveIdsBySeverity(v.cveIds, row.cveLabels)!.slice(0, 2).map(cveId => {
                                    const meta = row.cveLabels.find(c => c.id === cveId);
                                    if (meta) return <CveBadge key={cveId} cve={meta} />;
                                    return <span key={cveId} className="cr-package-meta__cve">{cveId}</span>;
                                })}
                            </span>
                        )}
                    </div>
                    <div className="cr-package-breakdown__version-consumers">
                        {v.consumers.map(c => (
                            <div key={`${c.name}:${c.repoName}`} className="cr-package-breakdown__version-consumer">
                                <NodeIcon type={c.type} size={10} />
                                <span className="cr-package-breakdown__vc-name">
                                    {c.repoName && c.repoName !== c.name && (
                                        <span className="cr-package-breakdown__vc-repo">{c.repoName} / </span>
                                    )}
                                    {c.url ? (
                                        <a href={toHttpUrl(c.url) ?? '#'} target="_blank" rel="noopener noreferrer" className="cr-ext-link" onClick={e => e.stopPropagation()}>
                                            {c.name}
                                            <ExternalLink size={10} className="cr-ext-link__icon" />
                                        </a>
                                    ) : c.name}
                                </span>
                                {c.team && <span className="cr-package-breakdown__team">{c.team}</span>}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function PackageBreakdownRow({ item, cveLabels }: { item: PackageRegistryConsumerRow; cveLabels: PackageRegistryRow['cveLabels'] }) {
    const hasVuln = item.cveIds && item.cveIds.length > 0;
    const dotStatus = hasVuln ? 'major' : item.status;
    return (
        <div className="cr-package-breakdown-row">
            <span className={`cr-package-status cr-package-status--${dotStatus}`} aria-hidden="true" />
            <span className="cr-package-breakdown__name">
                {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="cr-ext-link" onClick={e => e.stopPropagation()}>
                        {item.displayName}
                        <ExternalLink size={10} className="cr-ext-link__icon" />
                    </a>
                ) : item.displayName}
                {item.name !== item.displayName && (
                    <span className="cr-package-breakdown__service"> / {item.name}</span>
                )}
            </span>
            <span className="cr-package-breakdown__version">
                {showRequiredVersion(item.requiredVersion, item.version) && (
                    <span className="cr-package-breakdown__required">{item.requiredVersion} →</span>
                )}
                {item.version}
            </span>
            <span className={`cr-package-breakdown__state cr-package-breakdown__state--${item.status}`}>
                {item.statusLabel}
                {hasVuln && item.cveIds!.slice(0, 2).map(cveId => {
                    const meta = cveLabels.find(c => c.id === cveId);
                    if (meta) return <CveBadge key={cveId} cve={meta} />;
                    return <span key={cveId} className="cr-package-meta__cve">{cveId}</span>;
                })}
            </span>
        </div>
    );
}

function showRequiredVersion(required: string, installed: string): boolean {
    if (required === installed) return false;
    if (required === '*' || installed === '*') return false;
    if (/^[\^~>=<]/.test(required)) return true;
    return false;
}

/**
 * Severity maps onto the system state vocabulary (DESIGN.md: danger covers
 * critical/high, warn covers medium). LOW/UNKNOWN stay on a muted rose, never
 * ink/grey: a vulnerability is never neutral.
 */
const CVE_SEVERITY_COLOR: Record<string, string> = {
    CRITICAL: 'var(--cr-danger)',
    HIGH: '#f87171',
    MEDIUM: 'var(--cr-warn)',
    LOW: '#c9939b',
    UNKNOWN: '#c9939b',
};

/**
 * Overflow counter for CVE chips past the visible slice. Inherits the worst
 * hidden severity (labels are sorted worst-first) so a counter never shouts
 * louder than the threats it hides; the tooltip gives the distribution, not
 * an unreadable id dump.
 */
function OverflowCveBadge({ hidden, onOpen }: { hidden: PackageRegistryRow['cveLabels']; onOpen: () => void }) {
    const color = CVE_SEVERITY_COLOR[hidden[0]?.severity] ?? CVE_SEVERITY_COLOR.UNKNOWN;
    return (
        <SimpleTooltip content={summarizeCveSeverities(hidden)}>
            <button
                type="button"
                className="cr-package-meta__cve cr-package-meta__cve--more"
                style={{ color }}
                onClick={e => { e.stopPropagation(); onOpen(); }}
            >
                +{hidden.length}
            </button>
        </SimpleTooltip>
    );
}

function CveBadge({ cve }: { cve: PackageRegistryRow['cveLabels'][number] }) {
    const color = CVE_SEVERITY_COLOR[cve.severity] ?? CVE_SEVERITY_COLOR.UNKNOWN;
    const url = `https://osv.dev/vulnerability/${cve.osvId}`;
    const severity = cve.severity.toLowerCase();
    return (
        <SimpleTooltip content={cve.summary ? `${severity}: ${cve.summary}` : severity}>
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="cr-package-cve-link"
                style={{ color }}
                onClick={e => e.stopPropagation()}
            >
                {cve.id}
            </a>
        </SimpleTooltip>
    );
}

function formatStatusTimestamp(value: string | undefined) {
    if (!value) return new Date().toLocaleString(undefined, statusDateFormatOptions());
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, statusDateFormatOptions());
}

function statusDateFormatOptions(): Intl.DateTimeFormatOptions {
    return {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    };
}
