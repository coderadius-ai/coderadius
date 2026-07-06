import { useState, useMemo, useCallback } from 'react';
import { ShieldCheck, Puzzle, Download, Terminal } from 'lucide-react';
import { CopyCmd } from '../CopyCmd';
import type { AgentHarnessReport, GovernanceReport } from '@coderadius/shared-types';
import { StatusBar, StatusBarSep, StatusBarDot, StatusBarOk, CrSearch, CrButton, CrChipGroup, useOperatorTable, OperatorFilter, EmptyState } from '../design-system';
import type { CrChipOption } from '../design-system';
import { computeFleetReadiness, hasAgentReadinessData } from './readiness.model';
import type { RepoReadiness } from './readiness.model';
import { buildSkillLibraryView, STATUS_ORDER } from './skill-library.model';
import type { SkillStatus } from './skill-library.model';
import { FleetHeader } from './readiness/FleetHeader';
import { READINESS_COLUMNS } from './readiness/readinessColumns';
import { ReadinessTable } from './readiness/ReadinessTable';
import { SkillLibraryView } from './skill-library/SkillLibraryView';
import { ModalShell } from '../ModalShell';
import type { SortingState } from '@tanstack/react-table';

type Tab = 'readiness' | 'skill-library';

const EMPTY_REPOS: RepoReadiness[] = [];
const READINESS_INITIAL_SORT: SortingState = [{ id: 'score', desc: true }];

interface Props {
    radar: AgentHarnessReport;
    governance: GovernanceReport | null;
    meta: { cliVersion?: string; generatedAt?: string };
}

interface TableMeta {
    filteredRowCount: number;
    sortingDescription: string;
}

function formatStatusTs(ts?: string): string {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
    } catch { return ts; }
}

export function AgentHarnessView({ radar, governance, meta }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>('readiness');
    const [skillMeta, setSkillMeta] = useState<TableMeta | null>(null);
    const [showExportModal, setShowExportModal] = useState(false);
    // 'duplicate' is the only real status; the rest is the neutral default. So the
    // filter is a single "Duplicated" toggle, not a peer-status selector.
    const [duplicatesOnly, setDuplicatesOnly] = useState(false);
    const [skillQuery, setSkillQuery] = useState('');

    const toggleDuplicatesOnly = useCallback(() => setDuplicatesOnly(v => !v), []);

    const skillStatuses = useMemo<Set<SkillStatus>>(
        () => duplicatesOnly ? new Set(['duplicate']) : new Set(STATUS_ORDER),
        [duplicatesOnly],
    );

    const hasReadiness = useMemo(() => hasAgentReadinessData(governance), [governance]);

    const fleet = useMemo(
        () => hasReadiness ? computeFleetReadiness(governance!, radar) : null,
        [governance, radar, hasReadiness],
    );

    const skillLibrary = useMemo(
        () => buildSkillLibraryView(radar),
        [radar],
    );

    const skillChipOptions: CrChipOption<SkillStatus>[] = useMemo(() => [{
        value: 'duplicate',
        label: 'Duplicated',
        count: skillLibrary.stats.duplicated,
        tone: 'warn',
        dot: true,
    }], [skillLibrary.stats.duplicated]);

    const chipValue = useMemo<Set<SkillStatus>>(
        () => duplicatesOnly ? new Set(['duplicate']) : new Set(),
        [duplicatesOnly],
    );

    const readinessData = fleet?.repos ?? EMPTY_REPOS;
    const readinessTable = useOperatorTable({
        data: readinessData,
        columns: READINESS_COLUMNS,
        initialSorting: READINESS_INITIAL_SORT,
        enablePagination: false,
    });

    const statusRight = useMemo(() => {
        if (activeTab === 'readiness') {
            const parts: string[] = [];
            if (readinessTable.filteredRowCount !== (fleet?.repos.length ?? 0)) {
                parts.push(`${readinessTable.filteredRowCount} of ${fleet?.repos.length ?? 0} repos`);
            } else {
                parts.push(`${fleet?.repos.length ?? 0} repos scored`);
            }
            if (readinessTable.sortingDescription) parts.push(readinessTable.sortingDescription);
            return parts.join(' · ');
        }
        if (skillMeta) {
            const parts: string[] = [];
            parts.push(`${skillMeta.filteredRowCount} skills`);
            if (skillMeta.sortingDescription) parts.push(skillMeta.sortingDescription);
            return parts.join(' · ');
        }
        return `${skillLibrary.stats.totalSkills} skills`;
    }, [activeTab, readinessTable, fleet, skillMeta, skillLibrary.stats.totalSkills]);

    return (
        <section className="cr-page-shell" aria-label="Agent Harness">
            {/* Identity strip */}
            <div className="cr-page-identity" role="region" aria-label="Harness summary">
                <div className="cr-page-identity__copy">
                    <h2>
                        <span className="cr-page-identity__mark" aria-hidden="true">
                            {activeTab === 'skill-library'
                                ? <Puzzle size={16} />
                                : <ShieldCheck size={16} />
                            }
                        </span>
                        {activeTab === 'skill-library' ? 'Skill Library' : 'Agent Readiness'}
                    </h2>
                    <p>
                        {activeTab === 'skill-library'
                            ? 'Every agent skill across the org. Spot the ones duplicated across teams.'
                            : 'Autonomy, supervision, and no-go zones for every agent in the fleet.'
                        }
                    </p>
                </div>
                <div className="cr-page-kpis" aria-label="Radar metrics">
                    {activeTab === 'skill-library' ? (<>
                        <RadarKpi value={skillLibrary.stats.totalSkills} label="Skills" />
                        <RadarKpi value={skillLibrary.stats.duplicated} label="Duplicated" tone="warn" />
                    </>) : null}
                </div>
            </div>

            {/* Tabs strip */}
            <div className="cr-page-tabs-strip">
                <nav className="cr-page-tabs" aria-label="Harness sections">
                    <button
                        type="button"
                        className={`cr-page-tab${activeTab === 'readiness' ? ' cr-page-tab--active' : ''}`}
                        onClick={() => setActiveTab('readiness')}
                    >
                        <span>Readiness</span>
                    </button>
                    <button
                        type="button"
                        className={`cr-page-tab${activeTab === 'skill-library' ? ' cr-page-tab--active' : ''}`}
                        onClick={() => setActiveTab('skill-library')}
                    >
                        <span>Skill Library</span>
                        <span className="cr-page-tab__count">{skillLibrary.stats.totalSkills}</span>
                    </button>
                </nav>
                <div className="cr-page-actions">
                    {activeTab === 'readiness' && (<>
                        <OperatorFilter
                            columns={READINESS_COLUMNS}
                            data={readinessData}
                            table={readinessTable.table}
                            setGlobalFilter={readinessTable.setGlobalFilter}
                            setColumnFilters={readinessTable.setColumnFilters}
                            placeholder="filter verdict, team, repo..."
                            className="cr-registry-filter-wrap" style={{ minWidth: 280 }}
                        />
                        <CrButton icon={<Download size={11} />} onClick={() => setShowExportModal(true)}>Export policy</CrButton>
                    </>)}
                    {activeTab === 'skill-library' && (<>
                        <CrChipGroup
                            options={skillChipOptions}
                            value={chipValue}
                            onChange={toggleDuplicatesOnly}
                        />
                        <CrSearch
                            placeholder="filter skill name, team..."
                            value={skillQuery}
                            onChange={e => setSkillQuery(e.target.value)}
                            maxWidth={260}
                        />
                    </>)}
                </div>
            </div>

            {/* Body */}
            <div className="cr-page-body">
                {activeTab === 'readiness' && (
                    fleet ? (
                        <div className="cr-readiness-pane">
                            <FleetHeader fleet={fleet} />
                            <ReadinessTable
                                table={readinessTable.table}
                                columns={READINESS_COLUMNS}
                            />
                        </div>
                    ) : (
                        <EmptyState
                            icon={<ShieldCheck size={20} />}
                            title="No readiness data"
                            detail="Readiness scores are computed automatically during ingestion."
                            action={<CopyCmd text="cr analyze code" />}
                        />
                    )
                )}
                {activeTab === 'skill-library' && (
                    <SkillLibraryView
                        data={skillLibrary}
                        onTableMeta={setSkillMeta}
                        activeStatuses={skillStatuses}
                        query={skillQuery}
                    />
                )}
            </div>

            {/* Status bar */}
            <StatusBar
                left={<>
                    {meta.cliVersion && <span>v{meta.cliVersion}</span>}
                    {meta.cliVersion && <StatusBarSep />}
                    <span>{formatStatusTs(meta.generatedAt)}</span>
                    <StatusBarSep />
                    <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                </>}
                right={<span>{statusRight}</span>}
            />

            {showExportModal && (
                <ExportPolicyModal onClose={() => setShowExportModal(false)} />
            )}
        </section>
    );
}

function ExportPolicyModal({ onClose }: { onClose: () => void }) {
    return (
        <ModalShell ariaLabel="Export readiness policy" onClose={onClose} width="480px">
            <div className="cr-export-modal">
                <div className="cr-export-modal__header">
                    <Terminal size={18} />
                    <h3>Export readiness policy</h3>
                </div>
                <p className="cr-export-modal__desc">
                    Exports the <code>agent-readiness</code> policy pack to <code>.coderadius/policies/</code> for local customization.
                </p>
                <CopyCmd text="cr policy export agent-readiness" />
                <div className="cr-export-modal__hint">
                    <span className="cr-export-modal__hint-label">CI gate</span>
                    <CopyCmd text="cr policy verify --rules-path agent-readiness --fail-on warning" />
                </div>
            </div>
        </ModalShell>
    );
}

function RadarKpi({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
    return (
        <div className={`cr-page-kpi${tone ? ` cr-page-kpi--${tone}` : ''}`}>
            <span className="cr-page-kpi__num">{value}</span>
            <span className="cr-page-kpi__label">{label}</span>
        </div>
    );
}

