import { ChevronRight, ExternalLink } from 'lucide-react';
import type { OperatorTableColumn } from '../../OperatorTable';
import type { RepoReadiness } from '../readiness.model';
import { SignalBar } from './SignalBar';
import { ActivityBar } from '../../ActivityBar';
import { SimpleTooltip } from '../../Tooltip';
import { toHttpUrl } from '../../../transformers/utils';

const VERDICT_CLS: Record<string, string> = {
    autonomous: 'auto',
    supervised: 'sup',
    'off-limits': 'off',
};

export const READINESS_COLUMNS: OperatorTableColumn<RepoReadiness>[] = [
    {
        id: 'score',
        header: 'Score',
        width: '100px',
        sortValue: row => row.score,
        render: row => (
            <div className="cr-readiness__score-cell">
                <span className={`cr-readiness__score-num${row.verdict === 'off-limits' ? ' cr-readiness__score-num--off' : ''}`}>
                    {row.score}
                </span>
                <span className="cr-readiness__score-denom">/100</span>
            </div>
        ),
    },
    {
        id: 'repo',
        header: 'Repository',
        width: '38%',
        sortValue: row => row.repoName,
        filterValue: row => `${row.repoName} ${row.repoQualifier ?? ''} ${row.teamName} ${row.verdict} ${row.verdictLabel}`,
        render: row => (
            <div>
                <div className="cr-readiness__repo-name">
                    {row.repoUrl ? (
                        <a href={toHttpUrl(row.repoUrl)} target="_blank" rel="noopener noreferrer"
                           className="cr-ext-link"
                           onClick={e => e.stopPropagation()}>
                            {row.repoName}
                            <ExternalLink size={11} className="cr-ext-link__icon" />
                        </a>
                    ) : row.repoName}
                    {row.repoQualifier && (
                        <span className="cr-readiness__repo-qualifier" title="Distinct repository identity">{row.repoQualifier}</span>
                    )}
                </div>
                <div className="cr-readiness__repo-meta">{row.teamName}</div>
            </div>
        ),
    },
    {
        id: 'verdict',
        header: 'Verdict',
        width: '150px',
        sortValue: row => row.verdict === 'autonomous' ? 2 : row.verdict === 'supervised' ? 1 : 0,
        filterValue: row => `${row.verdict} ${row.verdictLabel}`,
        render: row => {
            const cls = VERDICT_CLS[row.verdict] ?? 'off';
            return (
                <div className={`cr-readiness__verdict cr-readiness__verdict--${cls}`}>
                    <span className="cr-readiness__verdict-dot" />
                    {row.verdictLabel}
                </div>
            );
        },
    },
    {
        id: 'signal',
        header: 'Checks',
        sortValue: row => row.checks.filter(c => c.status === 'pass').length,
        render: row => <SignalBar checks={row.checks} />,
    },
    {
        id: 'activity',
        header: (
            <SimpleTooltip content="Repository liveness, from commits in the trailing 12 months">
                <span>Activity</span>
            </SimpleTooltip>
        ),
        width: '170px',
        sortValue: row => row.activityScore,
        render: row => <ActivityBar score={row.activityScore} commits={row.livenessCommits} />,
    },
    {
        id: 'expand',
        header: '',
        width: '52px',
        align: 'right',
        sortable: false,
        render: () => (
            <div className="cr-readiness__chev">
                <ChevronRight size={13} />
            </div>
        ),
    },
];
