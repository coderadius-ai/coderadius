import { useState, useMemo, useCallback } from 'react';
import type { GravityAnalysisResult, GravityNodeSummary, GravityServiceRef } from '@coderadius/shared-types';
import { Flame, ShieldCheck } from 'lucide-react';
import { StatusBar, StatusBarSep, StatusBarDot, StatusBarOk, useOperatorTable, EmptyState } from './design-system';
import { OperatorTable, type OperatorTableColumn } from './OperatorTable';
import { NodeIcon, InfraTechChip } from './Taxonomy';
import { BlastTierChip } from './blast-radius/banner/BlastTierChip';
import { BarredProgress, type BarredProgressTone } from './BarredProgress';
import { SimpleTooltip } from './Tooltip';
import { getBlastTier, type TierKey } from '../lib/blastTier';
import { buildMultiServiceRepoSet, getItemQualification } from '../transformers/utils';

type Tab = 'data-monoliths' | 'service-bottlenecks';

interface GravityViewProps {
    data: GravityAnalysisResult;
    meta?: { cliVersion?: string; generatedAt?: string };
}

interface SpofRow {
    node: GravityNodeSummary;
    score: number;
    tierKey: TierKey;
    writers: GravityServiceRef[];
    readers: GravityServiceRef[];
    dependents: GravityServiceRef[];
    searchText: string;
}

const TIER_TONE: Record<TierKey, BarredProgressTone> = {
    seismic: 'danger',
    critical: 'warn',
    high: 'neutral',
    moderate: 'muted',
    contained: 'ok',
    // SPOF rows carry no gravity evidence, so getBlastTier never returns this
    // key here; present for Record completeness over the shared TierKey.
    unverified: 'muted',
};

function qualifyRefs(
    refs: GravityServiceRef[] | undefined,
    multiServiceRepos: Set<string>,
): GravityServiceRef[] {
    if (!refs) return [];
    return refs.map(r => ({
        ...r,
        context: getItemQualification(r.name, r.repoName, r.repoName ? multiServiceRepos.has(r.repoName) : false) ?? r.context ?? null,
    }));
}

function srvTooltip(services: GravityServiceRef[]): string {
    if (services.length === 0) return '';
    return services.map(s => {
        const prefix = s.context ? `${s.context}/` : '';
        const suffix = s.count ? ` · ${s.count}λ` : '';
        return `${prefix}${s.name}${suffix}`;
    }).join('\n');
}

function buildColumns(): OperatorTableColumn<SpofRow>[] {
    return [
        {
            id: 'index',
            header: '№',
            width: '46px',
            className: 'cr-registry-index',
            render: (_row, index) => String(index + 1).padStart(2, '0'),
        },
        {
            id: 'name',
            header: 'SPOF · Repository',
            width: '28%',
            sortValue: row => row.node.name,
            filterValue: row => `${row.node.name} ${row.node.repository?.name ?? ''} ${row.node.teams?.join(' ') ?? ''}`,
            sortable: true,
            render: row => (
                <div className="cr-registry-primary-cell">
                    <span className="cr-registry-name gravity-name" title={row.node.name}>
                        {row.node.type && <span className="gravity-name__icon"><NodeIcon type={row.node.type} size={13} /></span>}
                        <span className="gravity-name__text">{row.node.name}</span>
                    </span>
                    {row.node.repository && (
                        <span className="cr-registry-owner">{row.node.repository.name}</span>
                    )}
                </div>
            ),
        },
        {
            id: 'tech',
            header: 'Tech',
            width: '110px',
            filterValue: row => row.node.technology ?? '',
            render: row => row.node.technology
                ? <InfraTechChip technology={row.node.technology} nodeType={row.node.type} size={12} />
                : <span className="cr-registry-muted">{'—'}</span>,
        },
        {
            id: 'writers',
            header: 'Writers',
            width: '90px',
            align: 'right',
            sortValue: row => row.writers.length,
            sortable: true,
            className: row => `cr-registry-cell--num${row.writers.length === 0 ? ' cr-registry-empty-num' : ''}`,
            render: row => row.writers.length > 0
                ? <SimpleTooltip content={srvTooltip(row.writers)}><span>{row.writers.length}</span></SimpleTooltip>
                : <span>{'—'}</span>,
        },
        {
            id: 'readers',
            header: 'Readers',
            width: '90px',
            align: 'right',
            sortValue: row => row.readers.length,
            sortable: true,
            className: row => `cr-registry-cell--num${row.readers.length === 0 ? ' cr-registry-empty-num' : ''}`,
            render: row => row.readers.length > 0
                ? <SimpleTooltip content={srvTooltip(row.readers)}><span>{row.readers.length}</span></SimpleTooltip>
                : <span>{'—'}</span>,
        },
        {
            id: 'score',
            header: 'SPOF Score',
            width: '190px',
            sortValue: row => row.score,
            sortable: true,
            render: row => (
                <BarredProgress
                    value={row.score}
                    max={100}
                    bars={16}
                    size="sm"
                    tone={TIER_TONE[row.tierKey]}
                    showValue
                    valueLabel={String(row.score)}
                    ariaLabel={`SPOF score ${row.score}`}
                    className="gravity-score-bar"
                />
            ),
        },
        {
            id: 'tier',
            header: 'Tier',
            width: '140px',
            sortValue: row => -row.score,
            sortable: true,
            filterValue: row => {
                const tier = getBlastTier(row.score);
                return `${tier.grade} ${tier.label}`;
            },
            render: row => <BlastTierChip rawScore={row.node.spofScore} size="sm" variant="minimal" />,
        },
    ];
}

function ServiceList({ label, services }: { label: string; services: GravityServiceRef[] }) {
    if (services.length === 0) return null;
    return (
        <div className="gravity-expanded__group">
            <span className="gravity-expanded__label">{label} ({services.length})</span>
            <div className="gravity-expanded__services">
                {services.map((srv, i) => (
                    <span key={i} className="gravity-expanded__srv">
                        {srv.context && <span className="gravity-expanded__ctx">{srv.context}<span className="gravity-expanded__sep">/</span></span>}
                        <span className="gravity-expanded__name">{srv.name}</span>
                        {srv.count !== undefined && srv.count > 0 && (
                            <span className="gravity-expanded__count"> · {srv.count}λ</span>
                        )}
                    </span>
                ))}
            </div>
        </div>
    );
}

const SPOF_COLUMNS = buildColumns();

export function GravityView({ data, meta }: GravityViewProps) {
    const [activeTab, setActiveTab] = useState<Tab>('data-monoliths');
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

    const tabs: Array<{ id: Tab; label: string; count: number }> = [
        { id: 'data-monoliths', label: 'Data Monoliths', count: data.dataMonoliths.length },
        { id: 'service-bottlenecks', label: 'Service Bottlenecks', count: data.serviceBottlenecks.length },
    ];

    const multiServiceRepos = useMemo(() => {
        const refs: GravityServiceRef[] = [];
        for (const list of [data.dataMonoliths, data.serviceBottlenecks]) {
            for (const node of list) {
                refs.push(...(node.writeServices ?? []), ...(node.readServices ?? []), ...(node.dependentServices ?? []));
            }
        }
        return buildMultiServiceRepoSet(refs.map(r => r.repoName));
    }, [data]);

    const rows = useMemo(() => {
        const nodes = activeTab === 'data-monoliths' ? data.dataMonoliths : data.serviceBottlenecks;
        return nodes.map(node => {
            const score = Math.round(node.spofScore);
            const tier = getBlastTier(score);
            return {
                node,
                score,
                tierKey: tier.key,
                writers: qualifyRefs(node.writeServices, multiServiceRepos),
                readers: qualifyRefs(node.readServices, multiServiceRepos),
                dependents: qualifyRefs(node.dependentServices, multiServiceRepos),
                searchText: [
                    node.name,
                    node.repository?.name,
                    node.technology,
                    tier.grade,
                    tier.label,
                    ...(node.teams ?? []),
                ].filter(Boolean).join(' ').toLowerCase(),
            } satisfies SpofRow;
        });
    }, [data, activeTab, multiServiceRepos]);

    const table = useOperatorTable<SpofRow>({
        data: rows,
        columns: SPOF_COLUMNS,
        initialSorting: [{ id: 'score', desc: true }],
        enablePagination: false,
    });

    const handleRowClick = useCallback((row: SpofRow) => {
        setExpandedKeys(prev => {
            const next = new Set(prev);
            if (next.has(row.node.urn)) next.delete(row.node.urn);
            else next.add(row.node.urn);
            return next;
        });
    }, []);

    const renderExpandedRow = useCallback((row: SpofRow) => {
        const hasServices = row.writers.length > 0 || row.readers.length > 0 || row.dependents.length > 0;
        return (
            <div className="gravity-expanded">
                {hasServices ? (
                    <div className="gravity-expanded__body">
                        <ServiceList label="writers" services={row.writers} />
                        <ServiceList label="readers" services={row.readers} />
                        <ServiceList label="dependents" services={row.dependents} />
                    </div>
                ) : (
                    <div className="gravity-expanded__empty">No coupled services detected.</div>
                )}
                <a
                    href={`#blast:${row.node.urn}`}
                    className="gravity-expanded__blast-link"
                    onClick={e => e.stopPropagation()}
                >
                    View in Blast Radius {'→'}
                </a>
            </div>
        );
    }, []);

    const tierCounts = useMemo(() => {
        const allNodes = [...data.dataMonoliths, ...data.serviceBottlenecks];
        const counts = { seismic: 0, critical: 0, high: 0 };
        for (const node of allNodes) {
            if (node.spofScore >= 100) counts.seismic++;
            else if (node.spofScore >= 50) counts.critical++;
            else if (node.spofScore >= 15) counts.high++;
        }
        return counts;
    }, [data]);

    const uniqueServiceCount = useMemo(() => {
        const names = new Set<string>();
        for (const list of [data.dataMonoliths, data.serviceBottlenecks]) {
            for (const node of list) {
                for (const srv of [...(node.writeServices ?? []), ...(node.readServices ?? []), ...(node.dependentServices ?? [])]) {
                    names.add(srv.name);
                }
            }
        }
        return names.size;
    }, [data]);

    return (
        <section className="cr-page-shell" aria-label="Single Points of Failure">
            <div className="cr-page-identity gravity-identity" role="region" aria-label="SPOF summary">
                <div className="cr-page-identity__copy">
                    <h2>
                        <span className="cr-page-identity__mark gravity-mark" aria-hidden="true"><Flame size={16} /></span>
                        Architectural Gravity
                    </h2>
                    <p>Single points of failure and coupling bottlenecks.</p>
                </div>
                <div className="cr-page-kpis" aria-label="Severity metrics">
                    {tierCounts.seismic > 0 && <GravityKpi value={tierCounts.seismic} label="Seismic" tone="danger" />}
                    {tierCounts.critical > 0 && <GravityKpi value={tierCounts.critical} label="Critical" tone="warn" />}
                    {tierCounts.high > 0 && <GravityKpi value={tierCounts.high} label="High" />}
                    {uniqueServiceCount > 0 && (
                        <>
                            <span className="cr-page-kpi-sep" aria-hidden="true" />
                            <GravityKpi value={uniqueServiceCount} label="Services at Risk" />
                        </>
                    )}
                </div>
            </div>

            <div className="cr-page-tabs-strip">
                <nav className="cr-page-tabs" aria-label="SPOF categories">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            className={`cr-page-tab${activeTab === tab.id ? ' cr-page-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <span>{tab.label}</span>
                            <span className="cr-page-tab__count">{tab.count}</span>
                        </button>
                    ))}
                </nav>
            </div>

            <div className="cr-page-body">
                <OperatorTable
                    table={table.table}
                    columns={SPOF_COLUMNS}
                    getRowKey={row => row.node.urn}
                    onRowClick={handleRowClick}
                    expandedRowKeys={expandedKeys}
                    renderExpandedRow={renderExpandedRow}
                    ariaLabel={activeTab === 'data-monoliths' ? 'Data Monoliths' : 'Service Bottlenecks'}
                    tableClassName="cr-page-table"
                    emptyState={
                        <EmptyState
                            tone="positive"
                            icon={<ShieldCheck size={20} />}
                            title={activeTab === 'data-monoliths'
                                ? 'No data monoliths detected'
                                : 'No service bottlenecks detected'}
                            detail={activeTab === 'data-monoliths'
                                ? 'No datastore is shared widely enough to become a single point of failure.'
                                : 'No service concentrates enough coupling to choke the rest of the architecture.'}
                        />
                    }
                />
            </div>

            <StatusBar
                className="cr-registry-statusbar"
                left={<>
                    {meta?.cliVersion && <span>v{meta.cliVersion}</span>}
                    {meta?.cliVersion && <StatusBarSep />}
                    <span>{formatTs(meta?.generatedAt)}</span>
                    <StatusBarSep />
                    <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                </>}
                right={<>
                    <span>{table.filteredRowCount} rows</span>
                    {table.sortingDescription && <><StatusBarSep /><span>{table.sortingDescription}</span></>}
                </>}
            />
        </section>
    );
}

function GravityKpi({ value, label, tone }: { value: number; label: string; tone?: 'danger' | 'warn' }) {
    return (
        <div className={`cr-page-kpi${tone ? ` cr-page-kpi--${tone}` : ''}`}>
            <span className="cr-page-kpi__num">{value}</span>
            <span className="cr-page-kpi__label">{label}</span>
        </div>
    );
}

function formatTs(value: string | undefined) {
    if (!value) return new Date().toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
}
