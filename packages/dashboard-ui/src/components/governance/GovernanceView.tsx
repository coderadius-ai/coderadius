import { useMemo, useState, useCallback, type ReactNode } from 'react';
import type { GovernanceReport } from '@coderadius/shared-types';
import { ChevronRight, Download, ExternalLink, Shield, ScrollText, SearchX } from 'lucide-react';
import { OperatorTable, type OperatorTableColumn } from '../OperatorTable';
import { ActivityBar } from '../ActivityBar';
import {
    StatusBar, StatusBarSep, StatusBarDot, StatusBarOk,
    SegmentedBar, useOperatorTable, OperatorFilter, CrChipGroup, EmptyState,
} from '../design-system';
import type { SegmentedBarSegment, CrChipOption } from '../design-system';
import { downloadCsv, rowsToCsv } from '../../lib/csv';
import { type FlatEvaluationRow, FLAT_EVALUATION_HEADERS } from '../../transformers/governance.transformer';
import {
    buildGovernanceModel,
    type ComplianceRow, type PolicyRow,
} from './governanceModel';
import { toHttpUrl } from '../../transformers/utils';
import type { GovernanceViolationDetail, GovernancePassingRule } from '../GovernanceDrawer';

type GovernanceTab = 'compliance' | 'policies';
type LevelKey = 'error' | 'warning' | 'note';

const TABS: Array<{ id: GovernanceTab; label: string }> = [
    { id: 'compliance', label: 'Repository compliance' },
    { id: 'policies', label: 'Policy catalog' },
];

const LEVEL_GROUP_LABELS: Record<string, string> = {
    error: 'Error',
    warning: 'Warning',
    note: 'Note',
};

const LEVEL_ORDER: Record<string, number> = { error: 0, warning: 1, note: 2 };

const LEVEL_BADGE_TONE: Record<string, string> = {
    error: 'danger',
    warning: 'warn',
    note: 'signal',
};

const ALL_LEVELS: LevelKey[] = ['error', 'warning', 'note'];

// ─── Compliance Column Definitions ─────────────────────────────────────────

const COMPLIANCE_COLUMNS: OperatorTableColumn<ComplianceRow>[] = [
    {
        id: 'score',
        header: 'Score',
        width: '104px',
        sortValue: row => row.complianceScore,
        sortable: true,
        render: row => (
            <div className="cr-gov__score-cell">
                <span className="cr-gov__score-num">{row.complianceScore}</span>
                <span className="cr-gov__score-denom">/100</span>
            </div>
        ),
    },
    {
        id: 'entity',
        header: 'Entity',
        width: '24%',
        sortValue: row => row.entityName,
        filterValue: row => `${row.entityName} ${row.entityType} ${row.teamOwner ?? ''}`,
        sortable: true,
        render: row => {
            return (
                <div className="cr-gov__entity">
                    <div className="cr-gov__entity-row">
                        {row.entityUrl ? (
                            <a href={toHttpUrl(row.entityUrl)} target="_blank" rel="noopener noreferrer"
                               className="cr-ext-link"
                               onClick={e => e.stopPropagation()}>
                                <span className="cr-gov__entity-name">{row.displayName}</span>
                                <ExternalLink size={11} className="cr-ext-link__icon" />
                            </a>
                        ) : (
                            <span className="cr-gov__entity-name">{row.displayName}</span>
                        )}
                        <span className="cr-gov__entity-type">{row.entityType}</span>
                    </div>
                    {row.teamOwner && (
                        <span className="cr-gov__entity-team">{row.teamOwner}</span>
                    )}
                </div>
            );
        },
    },
    {
        id: 'checks',
        header: '',
        width: '100px',
        sortValue: row => row.rulesPassed,
        sortable: true,
        render: row => (
            <span className="cr-gov__checks">
                {row.rulesPassed}/{row.rulesEvaluated}
                <span className="cr-gov__checks-label"> checks</span>
            </span>
        ),
    },
    {
        id: 'bar',
        header: '',
        width: '100px',
        render: row => {
            const segments: SegmentedBarSegment[] = [];
            if (row.rulesPassed > 0) segments.push({ value: row.rulesPassed, color: 'var(--cr-ok)', label: `${row.rulesPassed} passing` });
            if (row.warnings > 0) segments.push({ value: row.warnings, color: 'var(--cr-warn)', label: `${row.warnings} drifts` });
            if (row.errors > 0) segments.push({ value: row.errors, color: 'var(--cr-danger)', label: `${row.errors} violations` });
            if (row.notes > 0) segments.push({ value: row.notes, color: '#22d3ee', label: `${row.notes} advisories` });
            return (
                <div className="cr-gov__bar">
                    <SegmentedBar segments={segments} height={6} />
                </div>
            );
        },
    },
    {
        id: 'summary',
        header: '',
        sortValue: row => row.total,
        sortable: true,
        render: row => {
            if (row.total === 0) {
                return <span className="cr-gov__summary cr-gov__summary-ok">all passing</span>;
            }
            return <ComplianceSummary row={row} />;
        },
    },
    {
        id: 'activity',
        header: 'Activity',
        width: '170px',
        sortValue: row => row.activityScore,
        sortable: true,
        render: row => <ActivityBar score={row.activityScore} commits={row.livenessCommits} />,
    },
    {
        id: 'expand',
        header: '',
        width: '44px',
        align: 'right',
        render: () => (
            <div className="cr-gov__chev">
                <ChevronRight size={13} />
            </div>
        ),
    },
];

function ComplianceSummary({ row }: { row: ComplianceRow }) {
    const parts: Array<{ count: number; level: string; noun: string }> = [];
    if (row.errors > 0) parts.push({ count: row.errors, level: 'error', noun: 'failing' });
    if (row.warnings > 0) parts.push({ count: row.warnings, level: 'warning', noun: 'failing' });
    if (row.notes > 0) parts.push({ count: row.notes, level: 'note', noun: 'advisory' });

    if (parts.length === 0) return null;

    const primary = parts[0];
    const moreCount = parts.slice(1).reduce((sum, p) => sum + p.count, 0);

    return (
        <span className="cr-gov__summary">
            <span className={`cr-gov__summary-count cr-gov__summary-count--${primary.level}`}>
                {primary.count}
            </span>
            {' '}<span className="cr-gov__summary-noun">{primary.noun}</span>
            {moreCount > 0 && (
                <span className="cr-gov__summary-more"> + {moreCount} more</span>
            )}
        </span>
    );
}

// ─── Policy Column Definitions ─────────────────────────────────────────────

const POLICY_COLUMNS: OperatorTableColumn<PolicyRow>[] = [
    {
        id: 'dot',
        header: '',
        width: '28px',
        render: row => (
            <span className={`cr-gov__group-dot cr-gov__group-dot--${row.level}`}
                  style={{ display: 'block', margin: '0 auto' }} />
        ),
    },
    {
        id: 'id',
        header: 'Policy ID',
        width: '140px',
        sortValue: row => row.ruleId,
        filterValue: row => row.ruleId,
        sortable: true,
        render: row => (
            <span className="cr-gov__policy-id">{row.ruleId}</span>
        ),
    },
    {
        id: 'name',
        header: 'Name',
        width: '34%',
        sortValue: row => row.ruleName,
        filterValue: row => `${row.ruleName} ${row.ruleDescription} ${row.tags.join(' ')}`,
        sortable: true,
        render: row => (
            <div className="cr-gov__policy-name-cell">
                <span className="cr-gov__policy-name">{row.ruleName}</span>
                {row.ruleDescription && (
                    <span className="cr-gov__policy-desc">{row.ruleDescription}</span>
                )}
            </div>
        ),
    },
    {
        id: 'level',
        header: 'Impact',
        width: '110px',
        sortValue: row => row.levelRank,
        sortable: true,
        render: row => {
            const label = LEVEL_GROUP_LABELS[row.level] ?? row.level;
            const tone = LEVEL_BADGE_TONE[row.level] ?? 'muted';
            return <span className={`cr-pill cr-pill--${tone}`}>{label}</span>;
        },
    },
    {
        id: 'adoption',
        header: 'Adoption',
        width: '100px',
        sortValue: row => row.evaluatedCount > 0 ? row.compliantCount / row.evaluatedCount : 0,
        sortable: true,
        render: row => {
            if (row.evaluatedCount <= 0) return null;
            const segments: SegmentedBarSegment[] = [
                { value: row.compliantCount, color: 'var(--cr-ok)' },
                { value: row.violationCount, color: 'var(--cr-danger)' },
            ];
            return <SegmentedBar segments={segments} height={5} />;
        },
    },
    {
        id: 'fraction',
        header: 'Pass',
        width: '56px',
        sortValue: row => row.compliantCount,
        sortable: true,
        render: row => (
            <span className="cr-gov__checks">
                <span className="cr-gov__checks-pass">{row.compliantCount}</span>/{row.evaluatedCount}
            </span>
        ),
    },
    {
        id: 'tags',
        header: 'Tags',
        width: '120px',
        filterValue: row => row.tags.join(' '),
        render: row => {
            if (row.tags.length === 0) return null;
            return (
                <div className="cr-gov__tags">
                    {row.tags.map(tag => (
                        <span key={tag} className="cr-gov__tag">{tag}</span>
                    ))}
                </div>
            );
        },
    },
    {
        id: 'expand',
        header: '',
        width: '44px',
        align: 'right',
        render: () => (
            <div className="cr-gov__chev">
                <ChevronRight size={13} />
            </div>
        ),
    },
];

// ─── Compliance Expanded Row ───────────────────────────────────────────────

function ComplianceExpandedRow({ row, onOpenPolicy }: { row: ComplianceRow; onOpenPolicy: (ruleId: string) => void }) {
    const grouped = row.violations.reduce<Record<string, GovernanceViolationDetail[]>>(
        (acc, v) => {
            if (!acc[v.level]) acc[v.level] = [];
            acc[v.level].push(v);
            return acc;
        },
        {},
    );
    const orderedLevels = Object.keys(grouped).sort(
        (a, b) => (LEVEL_ORDER[a] ?? 99) - (LEVEL_ORDER[b] ?? 99),
    );

    return (
        <div className="cr-gov__expanded">
            {orderedLevels.map(lvlKey => {
                const viols = grouped[lvlKey];
                const label = LEVEL_GROUP_LABELS[lvlKey] ?? lvlKey;
                return (
                    <div key={lvlKey} className="cr-gov__group">
                        <div className="cr-gov__group-header">
                            <span className={`cr-gov__group-dot cr-gov__group-dot--${lvlKey}`} />
                            <span className="cr-gov__group-label">
                                {label} {'·'} Failing
                            </span>
                            <span className="cr-gov__group-count">{viols.length}</span>
                        </div>
                        <div className="cr-gov__cards">
                            {viols.map((v, i) => (
                                <ComplianceViolationCard key={i} v={v} onOpenPolicy={onOpenPolicy} />
                            ))}
                        </div>
                    </div>
                );
            })}

            {row.passingRules.length > 0 && (
                <div className="cr-gov__group">
                    <div className="cr-gov__group-header">
                        <span className="cr-gov__group-dot cr-gov__group-dot--pass" />
                        <span className="cr-gov__group-label">Passing</span>
                        <span className="cr-gov__group-count">{row.passingRules.length}</span>
                    </div>
                    <div className="cr-gov__cards">
                        {row.passingRules.map((r, i) => (
                            <CompliancePassingCard key={i} rule={r} onOpenPolicy={onOpenPolicy} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function PolicyLink({ ruleId, children, className, onOpenPolicy }: {
    ruleId: string;
    children: ReactNode;
    className?: string;
    onOpenPolicy: (ruleId: string) => void;
}) {
    return (
        <a href={`#nav:governance?policy=${ruleId}`}
           className={`cr-ext-link${className ? ` ${className}` : ''}`}
           onClick={e => {
               e.stopPropagation();
               // Same-page navigation: the hashchange alone doesn't re-render
               // GovernanceView, so switch tab + expand the policy directly.
               onOpenPolicy(ruleId);
           }}>
            {children}
        </a>
    );
}

function ComplianceViolationCard({ v, onOpenPolicy }: { v: GovernanceViolationDetail; onOpenPolicy: (ruleId: string) => void }) {
    const iconCls =
        v.level === 'error' ? 'cr-gov__card-icon--fail' :
        v.level === 'warning' ? 'cr-gov__card-icon--warn' :
        'cr-gov__card-icon--info';
    return (
        <div className="cr-gov__card">
            <span className={`cr-gov__card-icon ${iconCls}`}>{'✗'}</span>
            <div className="cr-gov__card-body">
                <div className="cr-gov__card-title-row">
                    <PolicyLink ruleId={v.ruleId} className="cr-gov__card-name" onOpenPolicy={onOpenPolicy}>
                        {v.ruleName}
                    </PolicyLink>
                    <span className="cr-gov__card-id">{v.ruleId}</span>
                </div>
                {v.detail && <span className="cr-gov__card-detail">{v.detail}</span>}
            </div>
        </div>
    );
}

function CompliancePassingCard({ rule, onOpenPolicy }: { rule: GovernancePassingRule; onOpenPolicy: (ruleId: string) => void }) {
    return (
        <div className="cr-gov__pass-row">
            <span className="cr-gov__card-icon cr-gov__card-icon--pass">{'✓'}</span>
            <div className="cr-gov__pass-name">
                <PolicyLink ruleId={rule.ruleId} onOpenPolicy={onOpenPolicy}>
                    <span>{rule.ruleName}</span>
                </PolicyLink>
                <span className="cr-gov__card-id">{rule.ruleId}</span>
            </div>
        </div>
    );
}

// ─── Policy Expanded Row ───────────────────────────────────────────────────

function PolicyExpandedRow({ row }: { row: PolicyRow }) {
    const [cypherOpen, setCypherOpen] = useState(false);
    const appliedTo = buildAppliedToText(row.scope, row.evaluatedCount);

    return (
        <div className="cr-gov__policy-expanded">
            <div className="cr-gov__policy-grid">
                {/* Left column */}
                <div className="cr-gov__policy-left">
                    <div className="cr-gov__section">
                        <span className="cr-gov__section-label">What this policy checks</span>
                        <div className="cr-gov__section-card">
                            <p className="cr-gov__section-body">{row.ruleDescription || 'No description provided.'}</p>
                        </div>
                    </div>

                    {row.violations.length > 0 && (
                        <CappedEntityList
                            label={`Violating entities · ${row.violationCount} of ${row.evaluatedCount}`}
                            entities={row.violations}
                            status="fail"
                        />
                    )}

                    {row.compliants.length > 0 && (
                        <CappedEntityList
                            label={`Compliant · ${row.compliantCount}`}
                            entities={row.compliants}
                            status="pass"
                        />
                    )}
                </div>

                {/* Right column */}
                <div className="cr-gov__policy-right">
                    <div className="cr-gov__section">
                        <span className="cr-gov__section-label">Applied to</span>
                        <div className="cr-gov__section-card">
                            <p className="cr-gov__section-body">{appliedTo}</p>
                        </div>
                    </div>

                    {row.query && (
                        <div className="cr-gov__section">
                            <button
                                type="button"
                                className="cr-gov__disclosure"
                                onClick={() => setCypherOpen(p => !p)}
                            >
                                <ChevronRight
                                    size={12}
                                    className={`cr-gov__disclosure-icon${cypherOpen ? ' cr-gov__disclosure-icon--open' : ''}`}
                                />
                                <span className="cr-gov__section-label" style={{ margin: 0 }}>
                                    How it's evaluated {'·'} Cypher query
                                </span>
                            </button>
                            {cypherOpen && (
                                <CypherBlock query={row.query} />
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function PolicyEntityCard({ name, detail, team, url, status }: {
    name: string;
    detail?: string;
    team: string | null;
    url?: string | null;
    status: 'fail' | 'pass';
}) {
    const isFail = status === 'fail';
    return (
        <div className={`cr-gov__entity-card${isFail ? ' cr-gov__entity-card--fail' : ''}`}>
            <div className="cr-gov__entity-card-main">
                <div className="cr-gov__entity-card-info">
                    {url ? (
                        <a href={toHttpUrl(url)} target="_blank" rel="noopener noreferrer"
                           className="cr-ext-link"
                           onClick={e => e.stopPropagation()}>
                            <span className="cr-gov__entity-card-name">{name}</span>
                            <ExternalLink size={10} className="cr-ext-link__icon" />
                        </a>
                    ) : (
                        <span className="cr-gov__entity-card-name">{name}</span>
                    )}
                    {detail && <span className="cr-gov__card-detail">{detail}</span>}
                </div>
                <div className="cr-gov__entity-card-meta">
                    {team && <span className="cr-gov__entity-card-team">{team}</span>}
                    {isFail && <span className="cr-gov__entity-card-status">{'▲'} Fail</span>}
                    {!isFail && <span className="cr-gov__entity-card-pass">{'✓'}</span>}
                </div>
            </div>
        </div>
    );
}

const ENTITY_LIST_CAP = 5;

function CappedEntityList({ label, entities, status }: {
    label: string;
    entities: Array<{ entityName: string; entityUrl?: string | null; detail?: string; teamOwner: string | null }>;
    status: 'fail' | 'pass';
}) {
    const [showAll, setShowAll] = useState(false);
    const capped = !showAll && entities.length > ENTITY_LIST_CAP;
    const visible = capped ? entities.slice(0, ENTITY_LIST_CAP) : entities;
    const remaining = entities.length - ENTITY_LIST_CAP;

    return (
        <div className="cr-gov__section">
            <span className="cr-gov__section-label">{label}</span>
            <div className="cr-gov__cards">
                {visible.map((e, i) => (
                    <PolicyEntityCard
                        key={i}
                        name={e.entityName}
                        detail={e.detail}
                        team={e.teamOwner}
                        url={e.entityUrl}
                        status={status}
                    />
                ))}
                {capped && (
                    <button type="button" className="cr-gov__show-more" onClick={() => setShowAll(true)}>
                        + {remaining} more
                    </button>
                )}
                {showAll && entities.length > ENTITY_LIST_CAP && (
                    <button type="button" className="cr-gov__show-more" onClick={() => setShowAll(false)}>
                        show less
                    </button>
                )}
            </div>
        </div>
    );
}

function CypherBlock({ query }: { query: string }) {
    const [copied, setCopied] = useState(false);
    const lines = query.split('\n');

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(query).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [query]);

    return (
        <div className="cr-gov__cypher">
            <button
                type="button"
                className={`cr-gov__cypher-copy${copied ? ' cr-gov__cypher-copy--done' : ''}`}
                onClick={handleCopy}
                title={copied ? 'Copied!' : 'Copy query'}
                aria-label="Copy query"
            >
                {copied ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="4" y="1" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><rect x="1" y="3.5" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="#0d0d0e"/></svg>
                )}
            </button>
            <pre className="cr-gov__cypher-pre">
                {lines.map((line, i) => {
                    const highlighted = line
                        .replace(
                            /\b(MATCH|WHERE|RETURN|WITH|OPTIONAL|MERGE|SET|UNWIND|AS|CASE|WHEN|THEN|ELSE|END|OR|AND|NOT|IN|IS|NULL|TRUE|FALSE|CONTAINS|STARTS|ENDS|EXISTS|COUNT|COLLECT|DISTINCT|ORDER|BY|LIMIT|SKIP|DESC|ASC|CREATE|DELETE|DETACH|REMOVE|CALL|YIELD)\b/g,
                            '<span class="cr-gov__cypher-kw">$1</span>',
                        )
                        .replace(
                            /(:[A-Za-z][A-Za-z0-9_]*)/g,
                            '<span class="cr-gov__cypher-label">$1</span>',
                        )
                        .replace(
                            /('(?:[^'\\]|\\.)*')/g,
                            '<span class="cr-gov__cypher-str">$1</span>',
                        );
                    return (
                        <div key={i} className="cr-gov__cypher-line">
                            <span className="cr-gov__cypher-ln">{i + 1}</span>
                            <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                        </div>
                    );
                })}
            </pre>
        </div>
    );
}

function buildAppliedToText(scope: string, evaluatedCount: number): string {
    const kind = scope || 'any';
    const noun = kind === 'repository' ? 'Repositories' : kind === 'service' ? 'Services' : 'Entities';
    const count = evaluatedCount >= 0 ? evaluatedCount : 0;
    return `${noun} matching kind: ${kind}, currently ${count} ${count === 1 ? 'entity' : 'entities'}.`;
}

// ─── Sub-components ────────────────────────────────────────────────────────

function GovernanceKpi({ value, label, tone }: { value: number | string; label: string; tone?: 'danger' | 'warn' | 'ok' }) {
    return (
        <div className={`cr-page-kpi${tone ? ` cr-page-kpi--${tone}` : ''}`}>
            <span className="cr-page-kpi__num">{value}</span>
            <span className="cr-page-kpi__label">{label}</span>
        </div>
    );
}

// ─── Main View ─────────────────────────────────────────────────────────────

export function GovernanceView({
    report,
    evaluations,
    meta,
    deepLinkPolicyId,
}: {
    report: GovernanceReport;
    evaluations: FlatEvaluationRow[];
    meta?: { cliVersion?: string; generatedAt?: string };
    selectedRowId?: string;
    onRowClick?: (data: Record<string, unknown>) => void;
    deepLinkPolicyId?: string;
}) {
    const [activeTab, setActiveTab] = useState<GovernanceTab>(deepLinkPolicyId ? 'policies' : 'compliance');
    const [complianceExpanded, setComplianceExpanded] = useState<Set<string>>(new Set());
    const [policyExpanded, setPolicyExpanded] = useState<Set<string>>(() =>
        deepLinkPolicyId ? new Set([deepLinkPolicyId]) : new Set(),
    );
    const [policyLevels, setPolicyLevels] = useState<Set<LevelKey>>(() => new Set(ALL_LEVELS));
    const model = useMemo(() => buildGovernanceModel(report), [report]);

    const filteredPolicyRows = useMemo(
        () => model.policyRows.filter(r => policyLevels.has(r.level)),
        [model.policyRows, policyLevels],
    );

    const levelChipOptions = useMemo<CrChipOption<LevelKey>[]>(() => [
        { value: 'error', label: 'Errors', count: model.policyLevelCounts.error, tone: 'danger', dot: true },
        { value: 'warning', label: 'Warnings', count: model.policyLevelCounts.warning, tone: 'warn', dot: true },
        { value: 'note', label: 'Notes', count: model.policyLevelCounts.note, tone: 'signal', dot: true },
    ], [model.policyLevelCounts]);

    const toggleLevel = useCallback((r: LevelKey) => {
        setPolicyLevels(prev => {
            const next = new Set(prev);
            if (next.has(r)) next.delete(r);
            else next.add(r);
            return next;
        });
    }, []);

    const complianceTable = useOperatorTable<ComplianceRow>({
        data: model.complianceRows,
        columns: COMPLIANCE_COLUMNS,
        initialSorting: [{ id: 'score', desc: false }],
        enablePagination: false,
    });

    const policyTable = useOperatorTable<PolicyRow>({
        data: filteredPolicyRows,
        columns: POLICY_COLUMNS,
        initialSorting: [{ id: 'level', desc: false }],
        enablePagination: false,
    });

    const activeCount = activeTab === 'compliance'
        ? complianceTable.filteredRowCount
        : policyTable.filteredRowCount;
    const activeSortDesc = activeTab === 'compliance'
        ? complianceTable.sortingDescription
        : policyTable.sortingDescription;

    const handleComplianceRowClick = useCallback((row: ComplianceRow) => {
        setComplianceExpanded(prev => {
            const key = row.entityId;
            if (prev.has(key)) return new Set();
            return new Set([key]);
        });
    }, []);

    const openPolicy = useCallback((ruleId: string) => {
        // Re-enable the policy's level chip if it's filtered out, otherwise the
        // expanded row would be invisible in the catalog table.
        const target = model.policyRows.find(r => r.ruleId === ruleId);
        if (target) {
            setPolicyLevels(prev => {
                if (prev.has(target.level)) return prev;
                const next = new Set(prev);
                next.add(target.level);
                return next;
            });
        }
        setActiveTab('policies');
        setPolicyExpanded(new Set([ruleId]));
    }, [model.policyRows]);

    const handlePolicyRowClick = useCallback((row: PolicyRow) => {
        setPolicyExpanded(prev => {
            const key = row.ruleId;
            if (prev.has(key)) return new Set();
            return new Set([key]);
        });
    }, []);

    const renderComplianceExpanded = useCallback((row: ComplianceRow) => (
        <ComplianceExpandedRow row={row} onOpenPolicy={openPolicy} />
    ), [openPolicy]);

    const renderPolicyExpanded = useCallback((row: PolicyRow) => (
        <PolicyExpandedRow row={row} />
    ), []);

    const handleExport = () => {
        if (evaluations.length === 0) return;
        const headers = [...FLAT_EVALUATION_HEADERS];
        const rows = evaluations.map(e => headers.map(h => e[h]));
        const date = new Date().toISOString().slice(0, 10);
        downloadCsv(rowsToCsv(headers, rows), `governance-report-${date}.csv`);
    };

    return (
        <section className="cr-page-shell" aria-label="Governance">
            <div className="cr-page-identity" role="region" aria-label="Governance summary">
                <div className="cr-page-identity__copy">
                    <h2>
                        <span className="cr-page-identity__mark" aria-hidden="true">
                            {activeTab === 'policies' ? <ScrollText size={16} /> : <Shield size={16} />}
                        </span>
                        {activeTab === 'policies' ? 'Policy catalog' : 'Repository compliance'}
                    </h2>
                    <p>
                        {activeTab === 'policies'
                            ? 'Governance rules enforced across your architecture graph.'
                            : 'Policy compliance and architectural standards enforcement.'}
                    </p>
                </div>
                <div className="cr-page-kpis" aria-label="Governance metrics">
                    {activeTab === 'policies' ? (<>
                        <GovernanceKpi value={model.totalRules} label="Policies" />
                        <GovernanceKpi value={model.passingRules} label="Compliant" tone="ok" />
                        <GovernanceKpi value={model.totalRules - model.passingRules} label="At risk" tone={model.totalRules - model.passingRules > 0 ? 'danger' : undefined} />
                    </>) : (<>
                        <GovernanceKpi value={`${model.compliancePct}%`} label="Compliance" tone={model.complianceTone} />
                        <GovernanceKpi value={`${model.passingRules}/${model.totalRules}`} label="Passing" tone={model.rulesTone} />
                        <span className="cr-page-kpi-sep" aria-hidden="true" />
                        {model.errorViolations > 0 && (
                            <GovernanceKpi value={model.errorViolations} label="Errors" tone="danger" />
                        )}
                        {model.warningViolations > 0 && (
                            <GovernanceKpi value={model.warningViolations} label="Warnings" tone="warn" />
                        )}
                        {model.noteViolations > 0 && (
                            <GovernanceKpi value={model.noteViolations} label="Notes" />
                        )}
                        <GovernanceKpi value={model.entityCount} label="Entities" />
                        <GovernanceKpi value={model.totalRules} label="Rules" />
                    </>)}
                </div>
            </div>

            <div className="cr-page-tabs-strip">
                <nav className="cr-page-tabs" aria-label="Governance sections">
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
                    {activeTab === 'compliance' ? (
                        <OperatorFilter
                            columns={COMPLIANCE_COLUMNS}
                            data={model.complianceRows}
                            table={complianceTable.table}
                            setGlobalFilter={complianceTable.setGlobalFilter}
                            setColumnFilters={complianceTable.setColumnFilters}
                            placeholder="filter entity, team, type..."
                            className="cr-registry-filter-wrap" style={{ minWidth: 320 }}
                        />
                    ) : (<>
                        <CrChipGroup
                            options={levelChipOptions}
                            value={policyLevels}
                            onChange={toggleLevel}
                        />
                        <OperatorFilter
                            columns={POLICY_COLUMNS}
                            data={filteredPolicyRows}
                            table={policyTable.table}
                            setGlobalFilter={policyTable.setGlobalFilter}
                            setColumnFilters={policyTable.setColumnFilters}
                            placeholder="filter policy id, name, tag..."
                            className="cr-registry-filter-wrap" style={{ minWidth: 280 }}
                        />
                    </>)}
                    <button
                        type="button"
                        className="cr-registry-export"
                        onClick={handleExport}
                        disabled={evaluations.length === 0}
                        title={evaluations.length === 0
                            ? 'No evaluations to export'
                            : `Export ${evaluations.length} evaluation(s) as CSV`}
                    >
                        <Download size={13} />
                        Export
                    </button>
                </div>
            </div>

            <div className="cr-page-body">
                {activeTab === 'compliance' && (
                    <OperatorTable
                        table={complianceTable.table}
                        columns={COMPLIANCE_COLUMNS}
                        getRowKey={row => row.entityId}
                        onRowClick={handleComplianceRowClick}
                        expandedRowKeys={complianceExpanded}
                        renderExpandedRow={renderComplianceExpanded}
                        ariaLabel="Compliance"
                        tableClassName="cr-page-table cr-gov-table"
                        emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No entities match this filter" detail="Adjust or clear the filter to see more." />}
                    />
                )}
                {activeTab === 'policies' && (
                    <OperatorTable
                        table={policyTable.table}
                        columns={POLICY_COLUMNS}
                        getRowKey={row => row.ruleId}
                        onRowClick={handlePolicyRowClick}
                        expandedRowKeys={policyExpanded}
                        renderExpandedRow={renderPolicyExpanded}
                        ariaLabel="Policy catalog"
                        tableClassName="cr-page-table cr-gov-table"
                        emptyState={<EmptyState size="inline" icon={<SearchX size={20} />} title="No policies match this filter" detail="Adjust or clear the filter to see more." />}
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

function formatStatusTimestamp(value: string | undefined) {
    if (!value) return 'unknown';
    try {
        const d = new Date(value);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return value;
    }
}
