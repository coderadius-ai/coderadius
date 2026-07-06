import { ChevronRight } from 'lucide-react';
import type { OperatorTableColumn } from '../../OperatorTable';
import { SegmentedBar } from '../../design-system';
import type { SkillLibraryEntry, SkillStatus } from '../skill-library.model';
import { STATUS_META } from '../skill-library.model';

const STATUS_PILL_TONE: Record<SkillStatus, string> = {
    duplicate: 'warn',
    unique: 'muted',
};

function ConsumerBar({ adopted, total }: { adopted: number; total: number }) {
    if (total === 0) return <span className="cr-skill-lib__consumer-num" aria-label="No consumers">—</span>;
    const remaining = Math.max(0, total - adopted);
    return (
        <div className="cr-skill-lib__consumers" role="img" aria-label={`${adopted} of ${total} repos adopted`}>
            <SegmentedBar
                segments={[
                    { value: adopted, color: 'var(--cr-signal)', label: `${adopted} adopted` },
                    { value: remaining, color: 'var(--cr-line-0)', label: `${remaining} remaining` },
                ]}
                height={5}
            />
            <span className="cr-skill-lib__consumer-num">
                {adopted}<span className="denom">/{total}</span>
            </span>
        </div>
    );
}



export const SKILL_COLUMNS: OperatorTableColumn<SkillLibraryEntry>[] = [
    {
        id: 'name',
        header: 'Skill',
        filterValue: row => `${row.name} ${row.description} ${row.owner} ${row.capabilities.join(' ')}`,
        render: row => {
            const meta = STATUS_META[row.status];
            const pillTone = STATUS_PILL_TONE[row.status];
            return (
                <div>
                    <div className="cr-skill-lib__name">
                        <span className="file">{row.name}</span>
                        {meta.badge && (
                            <span className={`cr-pill cr-pill--${pillTone}`}>
                                {meta.badge}
                            </span>
                        )}
                    </div>
                    <div className="cr-skill-lib__desc">{row.description}</div>
                </div>
            );
        },
    },
    {
        id: 'owner',
        header: 'Owner',
        width: '150px',
        filterValue: row => row.owner,
        render: row => (
            <div className="cr-skill-lib__owner">
                {row.owner}
            </div>
        ),
    },
    {
        id: 'consumers',
        header: 'Consumers',
        width: '120px',
        sortValue: row => row.consumers.total > 0 ? row.consumers.adopted / row.consumers.total : 0,
        render: row => <ConsumerBar adopted={row.consumers.adopted} total={row.consumers.total} />,
    },
    {
        id: 'expand',
        header: '',
        width: '44px',
        align: 'right',
        sortable: false,
        render: () => (
            <span className="cr-skill-lib__chev" aria-hidden="true">
                <ChevronRight size={13} />
            </span>
        ),
    },
];
