import { useMemo, useState } from 'react';
import type { InventoryReport, InventoryRepo, InventoryService, InventoryTeam, TopologyMap } from '@coderadius/shared-types';
import { Database, Download, ExternalLink, LayoutList, Search, SearchX } from 'lucide-react';
import { type BarredProgressTone } from '../BarredProgress';
import { ActivityBar } from '../ActivityBar';
import { MiddleEllipsis } from '../MiddleEllipsis';
import { OperatorTable, type OperatorTableColumn } from '../OperatorTable';
import { SimpleTooltip } from '../Tooltip';
import { TierGlyphBadge, type TierGlyphShape, type TierGlyphTone } from '../TierGlyphBadge';
import { StatusBar, StatusBarSep, StatusBarDot, StatusBarOk, useOperatorTable, OperatorFilter, EmptyState } from '../design-system';
import { TechIconQuiet } from '../Taxonomy';
import type { RegistryDrawerData } from '../RegistryDrawer';
import { downloadCsv, rowsToCsv } from '../../lib/csv';
import { toHttpUrl, activityFromCommits } from '../../transformers/utils';
import { useOrgFilter } from '../../data/OrgFilterContext';
import { buildApiRows, type ApiRow } from './apiCatalogModel';
import { ApiCatalogTable } from './ApiCatalogTable';

type RegistryTab = 'repositories' | 'services' | 'endpoints' | 'teams' | 'contracts';

interface RegistryTierMeta {
    grade: 'T0' | 'T1' | 'T2' | 'T3';
    label: string;
    description: string;
    tone: TierGlyphTone;
    shape: TierGlyphShape;
    rank: number;
}

interface RepoRow {
    repo: InventoryRepo;
    rowId: string;
    owner: string;
    endpoints: number;
    activityScore: number;
    activityTone: BarredProgressTone;
    tier: RegistryTierMeta;
    lastAnalyzed: { label: string; title: string; missing: boolean };
    drawerData: RegistryDrawerData;
    searchText: string;
}

interface ServiceRow {
    service: InventoryService;
    rowId: string;
    drawerData: RegistryDrawerData;
    searchText: string;
}

interface TeamRow {
    team: InventoryTeam;
    searchText: string;
}

const TABS: Array<{ id: RegistryTab; label: string }> = [
    { id: 'repositories', label: 'Repositories' },
    { id: 'services', label: 'Services' },
    { id: 'endpoints', label: 'Endpoints' },
    { id: 'teams', label: 'Teams' },
    { id: 'contracts', label: 'Contracts' },
];

export function SystemRegistryView({
    report,
    topology,
    meta,
    selectedRowId,
    onRowClick,
}: {
    report: InventoryReport;
    topology?: TopologyMap | null;
    meta?: { cliVersion?: string; generatedAt?: string };
    selectedRowId?: string;
    onRowClick: (data: RegistryDrawerData) => void;
}) {
    const [activeTab, setActiveTab] = useState<RegistryTab>('repositories');
    const [legacyFilter, setLegacyFilter] = useState('');
    const { selectedOrgPaths } = useOrgFilter();
    const model = useMemo(() => buildRegistryModel(report, topology ?? null, selectedOrgPaths), [report, topology, selectedOrgPaths]);
    const legacyQuery = legacyFilter.trim().toLowerCase();

    const repoTable = useOperatorTable<RepoRow>({
        data: model.repoRows,
        columns: REPO_COLUMNS,
        initialSorting: [{ id: 'tier', desc: false }],
        enablePagination: false,
    });

    const serviceRows = useMemo(
        () => filterRows(model.serviceRows, legacyQuery),
        [model.serviceRows, legacyQuery],
    );
    const teamRows = useMemo(
        () => filterRows(model.teamRows, legacyQuery),
        [model.teamRows, legacyQuery],
    );
    const apiRows = useMemo(
        () => filterRows(model.apiRows, legacyQuery),
        [model.apiRows, legacyQuery],
    );

    const activeCount = activeTab === 'repositories'
        ? repoTable.filteredRowCount
        : getTabCount(activeTab, model, [], serviceRows, teamRows, apiRows);
    const activeSortDesc = activeTab === 'repositories' ? repoTable.sortingDescription : '';
    const exportDisabled = activeTab === 'contracts' || activeCount === 0;

    const handleExport = () => {
        if (exportDisabled) return;
        const filteredRepoRows = repoTable.table.getFilteredRowModel().rows.map(r => r.original) as RepoRow[];
        const { headers, rows, filename } = getExportData(activeTab, filteredRepoRows, serviceRows, teamRows, apiRows);
        downloadCsv(rowsToCsv(headers, rows), `${filename}-${new Date().toISOString().slice(0, 10)}.csv`);
    };

    return (
        <section className="cr-page-shell" aria-label="System Registry">
            <div className="cr-page-identity" role="region" aria-label="Catalog summary">
                <div className="cr-page-identity__copy">
                    <h2>
                        <span className="cr-page-identity__mark" aria-hidden="true"><LayoutList size={16} /></span>
                        {model.catalogTitle}
                    </h2>
                    <p>Auto-generated from your architecture graph, not the YAML someone forgot to update.</p>
                </div>
                <div className="cr-page-kpis" aria-label="Catalog metrics">
                    <RegistryKpi value={model.t0Count} label="T0" tone="danger" />
                    <RegistryKpi value={model.t1Count} label="T1" />
                    <span className="cr-page-kpi-sep" aria-hidden="true" />
                    <RegistryKpi value={report.summary.totalRepos} label="Repos" />
                    <RegistryKpi value={report.summary.totalServices} label="Services" />
                    <RegistryKpi value={model.endpointTotal} label="Endpoints" />
                    <RegistryKpi value={report.summary.totalTeams} label="Teams" />
                </div>
            </div>

            <div className="cr-page-tabs-strip">
                <nav className="cr-page-tabs" aria-label="Registry sections">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            className={`cr-page-tab${activeTab === tab.id ? ' cr-page-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <span>{tab.label}</span>
                            <span className="cr-page-tab__count">{model.tabCounts[tab.id]}</span>
                        </button>
                    ))}
                </nav>
                <div className="cr-page-actions">
                    {activeTab === 'repositories' ? (
                        <OperatorFilter
                            columns={REPO_COLUMNS}
                            data={model.repoRows}
                            table={repoTable.table}
                            setGlobalFilter={repoTable.setGlobalFilter}
                            setColumnFilters={repoTable.setColumnFilters}
                            className="cr-registry-filter-wrap"
                        />
                    ) : (
                        <label className="cr-registry-filter">
                            <Search size={14} aria-hidden="true" />
                            <input
                                value={legacyFilter}
                                onChange={(event) => setLegacyFilter(event.target.value)}
                                placeholder="filter team, stack, tier…"
                                aria-label="Filter registry rows"
                            />
                        </label>
                    )}
                    <button
                        type="button"
                        className="cr-registry-export"
                        onClick={handleExport}
                        disabled={exportDisabled}
                        title={exportDisabled ? 'No rows to export' : `Export ${activeCount} row(s)`}
                    >
                        <Download size={13} />
                        Export
                    </button>
                </div>
            </div>

            <div className="cr-page-body">
                {activeTab === 'repositories' && (
                    <RepositoryTable
                        table={repoTable.table}
                        selectedRowId={selectedRowId}
                        onRowClick={onRowClick}
                    />
                )}
                {activeTab === 'services' && (
                    <ServiceTable
                        rows={serviceRows}
                        selectedRowId={selectedRowId}
                        onRowClick={onRowClick}
                    />
                )}
                {activeTab === 'teams' && <TeamTable rows={teamRows} />}
                {activeTab === 'endpoints' && <ApiCatalogTable rows={apiRows} />}
                {activeTab === 'contracts' && (
                    <EmptyState
                        icon={<Database size={20} />}
                        title="Contract registry coming soon"
                        detail="Data structures and schema contracts will use the same dense operator surface."
                    />
                )}
            </div>

            <StatusBar
                className="cr-registry-statusbar"
                left={<>
                    {meta?.cliVersion && <span>v{meta.cliVersion}</span>}
                    {meta?.cliVersion && <StatusBarSep />}
                    <span>{formatStatusTimestamp(meta?.generatedAt)}</span>
                    <StatusBarSep />
                    <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                </>}
                right={<>
                    <span>{activeCount} rows</span>
                    {activeSortDesc && <><StatusBarSep /><span>{activeSortDesc}</span></>}
                </>}
            />
        </section>
    );
}

function RegistryKpi({ value, label, tone }: { value: number | string; label: string; tone?: 'danger' }) {
    return (
        <div className={`cr-page-kpi${tone ? ` cr-page-kpi--${tone}` : ''}`}>
            <span className="cr-page-kpi__num">{value}</span>
            <span className="cr-page-kpi__label">{label}</span>
        </div>
    );
}

const REPO_COLUMNS: OperatorTableColumn<RepoRow>[] = [
    {
        id: 'index',
        header: '№',
        width: '46px',
        className: 'cr-registry-index',
        render: (_row, index) => String(index + 1).padStart(2, '0'),
    },
    {
        id: 'repository',
        header: 'Repository · Owner',
        width: '25%',
        sortValue: row => row.repo.name,
        filterValue: row => `${row.repo.name} ${row.owner} ${row.repo.org ?? ''}`,
        sortable: true,
        render: row => {
            const url = row.repo.url ? toHttpUrl(row.repo.url) : null;
            return (
                <div className="cr-registry-primary-cell">
                    {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer"
                           className="cr-ext-link"
                           onClick={e => e.stopPropagation()}>
                            <span className="cr-registry-name">{row.repo.name}</span>
                            <ExternalLink size={11} className="cr-ext-link__icon" />
                        </a>
                    ) : (
                        <span className="cr-registry-name">{row.repo.name}</span>
                    )}
                    <span className="cr-registry-owner" title={row.owner}>{row.owner}</span>
                </div>
            );
        },
    },
    {
        id: 'tier',
        header: 'Tier',
        width: '150px',
        sortValue: row => row.tier.rank,
        filterValue: row => `${row.tier.grade} ${row.tier.label}`,
        sortable: true,
        render: row => (
            <TierGlyphBadge
                grade={row.tier.grade}
                label={row.tier.label}
                description={row.tier.description}
                tone={row.tier.tone}
                shape={row.tier.shape}
                size="sm"
                variant="minimal"
                className="cr-registry-tier"
            />
        ),
    },
    {
        id: 'depth',
        header: <SimpleTooltip content="Analysis depth per repo. Semantic: full source code. Contracts: API specs. Structure: file tree."><span>Depth</span></SimpleTooltip>,
        width: '120px',
        sortValue: row => row.repo.ingestionLevel === 'semantic' ? 0 : row.repo.ingestionLevel === 'contracts' ? 1 : 2,
        filterValue: row => row.repo.ingestionLevel,
        sortable: true,
        render: row => <DepthPill level={row.repo.ingestionLevel} />,
    },
    {
        id: 'stack',
        header: 'Stack',
        width: '210px',
        filterValue: row => row.repo.languages.join(' '),
        render: row => <StackChips items={row.repo.languages} />,
    },
    {
        id: 'endpoints',
        header: 'Endpoints',
        width: '104px',
        align: 'right',
        sortValue: row => row.endpoints,
        sortable: true,
        className: row => `cr-registry-cell--num cr-registry-endpoints${row.endpoints === 0 ? ' cr-registry-empty-num' : ''}`,
        render: row => String(row.endpoints).padStart(3, '0'),
    },
    {
        id: 'activity',
        header: 'Activity',
        width: '170px',
        sortValue: row => row.activityScore,
        sortable: true,
        render: row => <ActivityBar score={row.activityScore} commits={row.repo.livenessCommits} tone={row.activityTone} />,
    },
    {
        id: 'lastAnalyzed',
        header: 'Last analyzed',
        width: '140px',
        align: 'right',
        sortValue: row => row.repo.lastAnalyzedAt ?? '',
        sortable: true,
        className: row => `cr-registry-cell--num cr-registry-last${row.lastAnalyzed.missing ? ' cr-registry-last--missing' : ''}`,
        render: row => (
            <SimpleTooltip content={row.lastAnalyzed.title}>
                <span>{row.lastAnalyzed.label}</span>
            </SimpleTooltip>
        ),
    },
];

function RepositoryTable({
    table,
    selectedRowId,
    onRowClick,
}: {
    table: import('@tanstack/react-table').Table<RepoRow>;
    selectedRowId?: string;
    onRowClick: (data: RegistryDrawerData) => void;
}) {
    return (
        <OperatorTable
            table={table}
            columns={REPO_COLUMNS}
            getRowKey={row => row.rowId}
            selectedRowKey={selectedRowId}
            getRowClassName={row => row.tier.grade === 'T0' ? 'cr-registry-row--t0' : undefined}
            onRowClick={row => onRowClick(row.drawerData)}
            ariaLabel="Repositories"
            tableClassName="cr-page-table"
            emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No repositories match this filter" detail="Adjust or clear the filter to see more." />}
        />
    );
}

function ServiceTable({
    rows,
    selectedRowId,
    onRowClick,
}: {
    rows: ServiceRow[];
    selectedRowId?: string;
    onRowClick: (data: RegistryDrawerData) => void;
}) {
    const columns: OperatorTableColumn<ServiceRow>[] = [
        {
            id: 'index',
            header: '№',
            width: '46px',
            className: 'cr-registry-index',
            render: (_row, index) => String(index + 1).padStart(2, '0'),
        },
        {
            id: 'service',
            header: 'Service · Repository',
            width: '30%',
            render: row => (
                <div className="cr-registry-primary-cell">
                    <span className="cr-registry-name" title={row.service.name}>{row.service.name}</span>
                    <span className="cr-registry-owner">
                        {row.service.repository.name ? (
                            <MiddleEllipsis text={row.service.repository.name} />
                        ) : 'unassigned'}
                    </span>
                </div>
            ),
        },
        {
            id: 'owner',
            header: 'Owner',
            width: '180px',
            className: 'cr-registry-owner',
            render: row => row.service.team || 'unowned',
        },
        {
            id: 'stack',
            header: 'Stack',
            width: '220px',
            render: row => <StackChips items={row.service.languages} />,
        },
        {
            id: 'functions',
            header: 'Functions',
            width: '120px',
            align: 'right',
            className: 'cr-registry-cell--num',
            render: row => row.service.indexedFunctionCount.toLocaleString(),
        },
        {
            id: 'apis',
            header: 'APIs',
            width: '104px',
            align: 'right',
            className: 'cr-registry-cell--num',
            render: row => row.service.exposedEndpointCount.toLocaleString(),
        },
        {
            id: 'dependencies',
            header: 'Dependencies',
            width: '130px',
            align: 'right',
            className: 'cr-registry-cell--num',
            render: row => row.service.dependencyCount.toLocaleString(),
        },
    ];

    return (
        <OperatorTable
            rows={rows}
            columns={columns}
            getRowKey={row => row.rowId}
            selectedRowKey={selectedRowId}
            onRowClick={row => onRowClick(row.drawerData)}
            ariaLabel="Services"
            tableClassName="cr-page-table"
            emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No services match this filter" detail="Adjust or clear the filter to see more." />}
        />
    );
}

function TeamTable({ rows }: { rows: TeamRow[] }) {
    const columns: OperatorTableColumn<TeamRow>[] = [
        {
            id: 'index',
            header: '№',
            width: '46px',
            className: 'cr-registry-index',
            render: (_row, index) => String(index + 1).padStart(2, '0'),
        },
        {
            id: 'team',
            header: 'Team',
            width: '26%',
            render: row => <span className="cr-registry-name">{row.team.name}</span>,
        },
        {
            id: 'type',
            header: 'Type',
            width: '180px',
            className: 'cr-registry-owner',
            render: row => row.team.teamType || 'unknown',
        },
        {
            id: 'services',
            header: 'Services',
            width: '110px',
            align: 'right',
            className: 'cr-registry-cell--num',
            render: row => row.team.serviceCount,
        },
        {
            id: 'repositories',
            header: 'Repositories',
            width: '140px',
            align: 'right',
            className: 'cr-registry-cell--num',
            render: row => row.team.repoCount,
        },
        {
            id: 'stack',
            header: 'Stack',
            width: '240px',
            render: row => <StackChips items={row.team.languages} />,
        },
    ];

    return (
        <OperatorTable
            rows={rows}
            columns={columns}
            getRowKey={row => row.team.name}
            ariaLabel="Teams"
            tableClassName="cr-page-table"
            emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No teams match this filter" detail="Adjust or clear the filter to see more." />}
        />
    );
}

function DepthPill({ level }: { level: InventoryRepo['ingestionLevel'] }) {
    const meta = {
        contracts: { label: 'Contracts', tone: 'ok', tip: 'Analyzed from API specs (OpenAPI, AsyncAPI, GraphQL schemas)' },
        semantic: { label: 'Semantic', tone: 'neutral', tip: 'Full source analysis: AST parsing, LLM-driven intent extraction, dependency resolution' },
        structure: { label: 'Structure', tone: 'muted', tip: 'File-tree scan only, no source code analysis' },
    }[level];
    return (
        <SimpleTooltip content={meta.tip}>
            <span className={`cr-registry-depth cr-registry-depth--${meta.tone}`}>
                <span className="cr-registry-depth__dot" aria-hidden="true" />
                {meta.label}
            </span>
        </SimpleTooltip>
    );
}

function StackChips({ items }: { items: string[] }) {
    if (items.length === 0) return <span className="cr-registry-muted">—</span>;
    const ordered = [...items].sort((a, b) => a.localeCompare(b));
    const visible = ordered.slice(0, 5);
    const rest = ordered.slice(5);
    return (
        <div className="cr-registry-stack">
            {visible.map(item => (
                <TechIconQuiet key={item} technology={item} size={15} />
            ))}
            {rest.length > 0 && (
                <SimpleTooltip content={rest.join(', ')}>
                    <span className="cr-registry-stack-chip cr-registry-stack-chip--more">+{rest.length}</span>
                </SimpleTooltip>
            )}
        </div>
    );
}

function buildRegistryModel(report: InventoryReport, topology: TopologyMap | null, selectedOrgPaths: string[]) {
    const endpointCountByRepo = new Map<string, number>();
    for (const service of report.services) {
        const repoName = service.repository.name;
        if (!repoName) continue;
        endpointCountByRepo.set(repoName, (endpointCountByRepo.get(repoName) ?? 0) + service.exposedEndpointCount);
    }

    const gravityByRepo = buildGravityByRepo(topology);
    const repoRows = report.repositories
        .map(repo => {
            const rowId = repo.repoHash ?? repo.name;
            const owner = repo.teams[0] ?? 'unowned';
            const endpoints = endpointCountByRepo.get(repo.name) ?? 0;
            const activityScore = activityFromCommits(repo.livenessCommits);
            const tier = tierFromGravity(gravityByRepo.get(repo.name));
            const lastAnalyzed = formatLastAnalyzed(repo.lastAnalyzedAt);
            const webUrl = repo.url ? toHttpUrl(repo.url) : null;
            const drawerData: RegistryDrawerData = {
                _rowId: rowId,
                kind: 'repo',
                name: repo.name,
                url: webUrl,
                branch: repo.branch ?? null,
                defaultBranch: repo.defaultBranch ?? null,
                coreBranches: repo.coreBranches ?? [],
                hostingPlatform: repo.hostingPlatform ?? null,
                ingestionLevel: repo.ingestionLevel,
                livenessCommits: repo.livenessCommits,
                teams: repo.teams,
                languages: repo.languages,
                fileCount: repo.fileCount ?? 0,
                functionCount: repo.functionCount ?? 0,
                repoHash: repo.repoHash ?? null,
                ciPipelines: repo.ciPipelines ?? [],
                dockerImages: repo.dockerImages ?? [],
                toolConfigs: repo.toolConfigs ?? [],
                tasks: repo.tasks ?? [],
            };
            return {
                repo,
                rowId,
                owner,
                endpoints,
                activityScore,
                activityTone: 'neutral' as BarredProgressTone,
                tier,
                lastAnalyzed,
                drawerData,
                searchText: [
                    repo.name,
                    repo.org,
                    owner,
                    repo.ingestionLevel,
                    tier.grade,
                    tier.label,
                    ...repo.languages,
                    ...repo.teams,
                ].filter(Boolean).join(' ').toLowerCase(),
            } satisfies RepoRow;
        })
        .sort((a, b) =>
            a.tier.rank - b.tier.rank
            || b.endpoints - a.endpoints
            || b.activityScore - a.activityScore
            || a.repo.name.localeCompare(b.repo.name),
        );

    const serviceRows = report.services.map(service => {
        const rowId = service.urn || service.name;
        const repoWebUrl = service.repository.url ? toHttpUrl(service.repository.url) : null;
        const drawerData: RegistryDrawerData = {
            _rowId: rowId,
            kind: 'service',
            name: service.name,
            team: service.team ?? null,
            languages: service.languages,
            repositoryName: service.repository.name ?? null,
            repositoryUrl: repoWebUrl,
            indexedFunctionCount: service.indexedFunctionCount,
            exposedEndpointCount: service.exposedEndpointCount,
            dependencyCount: service.dependencyCount,
        };
        return {
            service,
            rowId,
            drawerData,
            searchText: [
                service.name,
                service.team,
                service.repository.name,
                ...service.languages,
            ].filter(Boolean).join(' ').toLowerCase(),
        } satisfies ServiceRow;
    });

    const teamRows = report.teams.map(team => ({
        team,
        searchText: [
            team.name,
            team.teamType,
            ...team.languages,
        ].filter(Boolean).join(' ').toLowerCase(),
    } satisfies TeamRow));

    const endpointTotal = report.services.reduce((sum, service) => sum + service.exposedEndpointCount, 0);
    return {
        // One org selected → that org names the catalog. Otherwise the catalog
        // is the whole workspace: the configured tenant, or "Enterprise".
        catalogTitle: selectedOrgPaths.length === 1
            ? `${humanizeCatalogName(selectedOrgPaths[0])} catalog`
            : `${report.tenant?.name ?? 'Enterprise'} catalog`,
        repoRows,
        serviceRows,
        teamRows,
        apiRows: buildApiRows(report.apiCatalog, report.repositories),
        endpointTotal,
        t0Count: repoRows.filter(row => row.tier.grade === 'T0').length,
        t1Count: repoRows.filter(row => row.tier.grade === 'T1').length,
        tabCounts: {
            repositories: report.summary.totalRepos,
            services: report.summary.totalServices,
            endpoints: endpointTotal,
            teams: report.summary.totalTeams,
            contracts: 0,
        } satisfies Record<RegistryTab, number>,
    };
}

function buildGravityByRepo(topology: TopologyMap | null) {
    const byRepo = new Map<string, number>();
    if (!topology) return byRepo;
    for (const node of Object.values(topology.nodes)) {
        const repoName = node.repository?.name;
        if (!repoName) continue;
        const score = node.gravityScore ?? 0;
        if (score > (byRepo.get(repoName) ?? 0)) {
            byRepo.set(repoName, score);
        }
    }
    return byRepo;
}

function tierFromGravity(score = 0): RegistryTierMeta {
    if (score >= 100) {
        return { grade: 'T0', label: 'Seismic', description: 'Org-wide cascade', tone: 'danger', shape: 'triangle', rank: 0 };
    }
    if (score >= 50) {
        return { grade: 'T1', label: 'Critical', description: 'Multi-team impact', tone: 'warn', shape: 'square', rank: 1 };
    }
    if (score >= 15) {
        return { grade: 'T2', label: 'High', description: 'Single-team impact', tone: 'neutral', shape: 'dot', rank: 2 };
    }
    return { grade: 'T3', label: 'Standard', description: 'Isolated', tone: 'muted', shape: 'dash', rank: 3 };
}

function filterRows<T extends { searchText: string }>(rows: T[], query: string) {
    if (!query) return rows;
    return rows.filter(row => row.searchText.includes(query));
}

function humanizeCatalogName(value: string) {
    return value
        .split(/[\/_-]+/g)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function timeAgo(date: Date): string {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHr / 24);

    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);

    if (diffDays === 0) return `${time} today`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 30) return `${diffDays}d ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
}

function formatLastAnalyzed(value: string | null | undefined) {
    if (!value) return { label: 'not analyzed', title: 'No analysis timestamp recorded', missing: true };
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { label: 'invalid date', title: value, missing: true };
    }
    return {
        label: timeAgo(date),
        title: `UTC ${date.toISOString()}`,
        missing: false,
    };
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

function getTabCount(
    tab: RegistryTab,
    model: ReturnType<typeof buildRegistryModel>,
    repoRows: RepoRow[],
    serviceRows: ServiceRow[],
    teamRows: TeamRow[],
    apiRows: ApiRow[],
) {
    switch (tab) {
        case 'repositories': return repoRows.length;
        case 'services': return serviceRows.length;
        case 'teams': return teamRows.length;
        case 'endpoints': return apiRows.length;
        case 'contracts': return model.tabCounts.contracts;
    }
}

function getExportData(tab: RegistryTab, repos: RepoRow[], services: ServiceRow[], teams: TeamRow[], apis: ApiRow[]) {
    if (tab === 'endpoints') {
        return {
            filename: 'system-registry-apis',
            headers: ['api', 'version', 'source', 'services', 'owner', 'repository', 'endpoints', 'deployments', 'spec', 'consumers'],
            rows: apis.map(row => [
                row.api.title,
                row.api.version,
                row.api.apiSource,
                row.api.exposers.map(e => e.service).join(' | '),
                row.api.team ?? '',
                row.api.repository ?? '',
                row.api.endpoints.length,
                row.api.deployments.map(d => `${d.environment}:${d.visibility} ${d.url}`).join(' | '),
                row.specUrl ?? row.api.specPath ?? '',
                row.api.consumerCount,
            ]),
        };
    }
    if (tab === 'repositories') {
        return {
            filename: 'system-registry-repositories',
            headers: ['repository', 'owner', 'tier', 'depth', 'stack', 'endpoints', 'activity', 'last_analyzed'],
            rows: repos.map(row => [
                row.repo.name,
                row.owner,
                `${row.tier.grade} ${row.tier.label}`,
                row.repo.ingestionLevel,
                row.repo.languages.join(', '),
                row.endpoints,
                row.activityScore,
                row.repo.lastAnalyzedAt ?? '',
            ]),
        };
    }
    if (tab === 'services') {
        return {
            filename: 'system-registry-services',
            headers: ['service', 'owner', 'repository', 'stack', 'functions', 'apis', 'dependencies'],
            rows: services.map(row => [
                row.service.name,
                row.service.team ?? '',
                row.service.repository.name ?? '',
                row.service.languages.join(', '),
                row.service.indexedFunctionCount,
                row.service.exposedEndpointCount,
                row.service.dependencyCount,
            ]),
        };
    }
    return {
        filename: 'system-registry-teams',
        headers: ['team', 'type', 'services', 'repositories', 'stack'],
        rows: teams.map(row => [
            row.team.name,
            row.team.teamType ?? '',
            row.team.serviceCount,
            row.team.repoCount,
            row.team.languages.join(', '),
        ]),
    };
}
