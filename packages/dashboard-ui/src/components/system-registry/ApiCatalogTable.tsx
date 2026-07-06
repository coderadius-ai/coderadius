/**
 * ApiCatalogTable — the API catalog tab of the System Registry.
 *
 * One lean row per logical API surface (exposing services, owner team, spec
 * format, endpoint count, consumers with a Blast Radius deep link). The
 * expanded row is a small workspace with segmented views, same pattern as
 * Package Intelligence: Endpoints (scrollable, filterable when long) and
 * Deployments (environment, visibility, full URL), with the OAS spec path
 * linked in the header.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, SearchX } from 'lucide-react';
import type { InventoryApiDeployment, InventoryApiEndpoint } from '@coderadius/shared-types';
import { OperatorTable, type OperatorTableColumn } from '../OperatorTable';
import { SimpleTooltip } from '../Tooltip';
import { BlastRadiusButton } from '../BlastRadiusButton';
import { EmptyState, RowExpand, ToggleGroup, useOperatorTable } from '../design-system';
import { deploymentHref, deploymentLabel, type ApiRow } from './apiCatalogModel';

const METHOD_ACCENTS: Record<string, string> = {
    GET: '#22d3ee',
    POST: '#3cc58e',
    PUT: '#f2b445',
    PATCH: '#f2b445',
    DELETE: '#f04a5c',
};

const VISIBILITY_ACCENTS: Record<string, string> = {
    public: '#f2b445',
    partner: '#a78bfa',
    admin: '#f04a5c',
    internal: 'var(--cr-ink-2)',
};

const hasBreakdown = (row: ApiRow): boolean =>
    row.api.endpoints.length > 0 || row.api.deployments.length > 0 || row.specUrl != null;

function MethodBadge({ method }: { method: string | null }) {
    // Null for non-HTTP operations (GraphQL SDL): keep the column, mute the slot.
    const label = method?.toUpperCase() ?? '—';
    const accent = method ? METHOD_ACCENTS[label] ?? 'var(--cr-ink-2)' : 'var(--cr-ink-mute)';
    return (
        <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9.5px',
            fontWeight: 600,
            letterSpacing: '0.06em',
            color: accent,
            width: '52px',
            flexShrink: 0,
        }}>
            {label}
        </span>
    );
}

function EndpointsView({ endpoints }: { endpoints: InventoryApiEndpoint[] }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '264px', overflowY: 'auto' }}>
            {endpoints.map(ep => (
                <div key={`${ep.method} ${ep.path}`} style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                    <MethodBadge method={ep.method} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--cr-ink-1)' }}>
                        {ep.path}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** One deployment per row: environment/host, visibility, full URL (linked only when real). */
function DeploymentsView({ deployments }: { deployments: InventoryApiDeployment[] }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {deployments.map(d => {
                const href = deploymentHref(d);
                const accent = VISIBILITY_ACCENTS[d.visibility] ?? 'var(--cr-ink-mute)';
                return (
                    <div key={d.url} style={{ display: 'flex', alignItems: 'baseline', gap: '12px', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', width: '200px', flexShrink: 0, color: 'var(--cr-ink-1)' }}>
                            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: accent, flexShrink: 0 }} />
                            {deploymentLabel(d)}
                        </span>
                        <span style={{ width: '80px', flexShrink: 0, fontSize: '10px', color: 'var(--cr-ink-3)' }}>
                            {d.visibility}
                        </span>
                        {href ? (
                            <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                                style={{ color: 'var(--cr-ink-1)', textDecoration: 'none' }}
                            >
                                {d.url}
                            </a>
                        ) : (
                            <span style={{ color: 'var(--cr-ink-mute)' }}>{d.url}</span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

type ApiView = 'endpoints' | 'deployments';

const SPEC_KIND_LABELS: Record<string, string> = {
    openapi: 'OpenAPI',
    sdl: 'GraphQL SDL',
};

/**
 * Expanded-row workspace: segmented views that never stack, plus the spec
 * file deep link in the header (path visible, not an anonymous icon).
 */
function ApiBreakdown({ row }: { row: ApiRow }) {
    const { endpoints, deployments } = row.api;
    const [view, setView] = useState<ApiView>(endpoints.length > 0 ? 'endpoints' : 'deployments');
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Expanding the last row would otherwise render below the fold:
    // 'nearest' scrolls just enough, and not at all when already visible.
    useEffect(() => {
        containerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, []);

    const options = [
        ...(endpoints.length > 0 ? [{ value: 'endpoints' as const, label: 'Endpoints' }] : []),
        ...(deployments.length > 0 ? [{ value: 'deployments' as const, label: 'Deployments' }] : []),
    ];

    return (
        <div ref={containerRef} style={{ padding: '10px 16px 14px 58px', background: 'var(--cr-bg-1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                {options.length > 1
                    ? <ToggleGroup options={options} value={view} onChange={setView} size="sm" />
                    : <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-ink-3)' }}>{options[0]?.label ?? ''}</span>}
                {row.specUrl && (
                    <a
                        className="cr-api-spec-link"
                        href={row.specUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                    >
                        <span className="cr-api-spec-link__kind">{SPEC_KIND_LABELS[row.api.apiSource] ?? 'Spec'}</span>
                        <span className="cr-api-spec-link__path">{row.api.specPath}</span>
                        <ExternalLink size={11} style={{ flexShrink: 0 }} />
                    </a>
                )}
            </div>
            {view === 'endpoints' && endpoints.length > 0 && <EndpointsView endpoints={endpoints} />}
            {view === 'deployments' && deployments.length > 0 && <DeploymentsView deployments={deployments} />}
        </div>
    );
}

export function ApiCatalogTable({ rows }: { rows: ApiRow[] }) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const toggle = (row: ApiRow) => {
        if (!hasBreakdown(row)) return;
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(row.api.urn)) next.delete(row.api.urn);
            else next.add(row.api.urn);
            return next;
        });
    };

    const columns = useMemo<OperatorTableColumn<ApiRow>[]>(() => [
        {
            id: 'index',
            header: '№',
            width: '46px',
            className: 'cr-registry-index',
            sortable: false,
            render: (_row, index) => String(index + 1).padStart(2, '0'),
        },
        {
            id: 'api',
            header: 'API · Services',
            width: '34%',
            sortValue: row => row.api.title.toLowerCase(),
            render: row => (
                <div className="cr-registry-primary-cell">
                    <span className="cr-registry-name">
                        {row.api.title}
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--cr-ink-3)', marginLeft: '8px' }}>
                            {row.api.version}
                        </span>
                    </span>
                    <span className="cr-registry-owner">
                        {row.api.exposers.length > 0 ? row.api.exposers.map(e => e.service).join(' · ') : 'unassigned'}
                    </span>
                </div>
            ),
        },
        {
            id: 'owner',
            header: 'Owner',
            width: '180px',
            className: 'cr-registry-owner',
            sortValue: row => row.api.team ?? '',
            render: row => row.api.team || 'unowned',
        },
        {
            id: 'source',
            header: 'Source',
            width: '110px',
            sortValue: row => row.api.apiSource,
            // Categorical label, not state: the muted pill is the house tone.
            render: row => <span className="cr-pill cr-pill--muted">{row.api.apiSource}</span>,
        },
        {
            id: 'deployments',
            header: 'Deployments',
            width: '120px',
            align: 'right',
            className: 'cr-registry-cell--num',
            sortValue: row => row.api.deployments.length,
            render: row => row.api.deployments.length > 0
                ? row.api.deployments.length.toLocaleString()
                : <span style={{ color: 'var(--cr-ink-mute)' }}>—</span>,
        },
        {
            id: 'endpoints',
            header: 'Endpoints',
            width: '110px',
            align: 'right',
            className: 'cr-registry-cell--num',
            sortValue: row => row.api.endpoints.length,
            render: row => row.api.endpoints.length.toLocaleString(),
        },
        {
            id: 'consumers',
            header: 'Consumers',
            width: '120px',
            align: 'right',
            sortValue: row => row.api.consumerCount,
            render: row => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                    {row.api.consumerCount > 0 ? (
                        <span className="cr-registry-cell--num">{row.api.consumerCount.toLocaleString()}</span>
                    ) : (
                        // Honest zero: no CONSUMES_API edges yet is absence of
                        // data, not "nobody uses this".
                        <SimpleTooltip content="No consumer data yet" side="top">
                            <span style={{ color: 'var(--cr-ink-mute)' }}>—</span>
                        </SimpleTooltip>
                    )}
                    {row.api.exposers[0] && (
                        <BlastRadiusButton variant="icon" size="md" urn={row.api.exposers[0].serviceUrn} label="Consumers in Blast Radius" />
                    )}
                </span>
            ),
        },
        {
            id: 'expand',
            header: '',
            width: '52px',
            align: 'right',
            sortable: false,
            render: row => hasBreakdown(row) ? <RowExpand /> : null,
        },
    ], []);

    const table = useOperatorTable<ApiRow>({
        data: rows,
        columns,
        initialSorting: [{ id: 'api', desc: false }],
        enablePagination: false,
    });

    return (
        <OperatorTable
            table={table.table}
            columns={columns}
            getRowKey={row => row.api.urn}
            onRowClick={toggle}
            expandedRowKeys={expanded}
            renderExpandedRow={row => <ApiBreakdown row={row} />}
            ariaLabel="API catalog"
            tableClassName="cr-page-table"
            emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No APIs match this filter" detail="Adjust or clear the filter to see more." />}
        />
    );
}
