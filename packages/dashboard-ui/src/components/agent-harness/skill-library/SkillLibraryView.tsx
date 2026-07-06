import { useState, useMemo, useCallback, useEffect } from 'react';
import { SearchX } from 'lucide-react';
import type { SkillLibraryView as SkillLibraryViewData, SkillStatus, SkillLibraryEntry } from '../skill-library.model';
import { STATUS_ORDER, sortSkills, filterSkills } from '../skill-library.model';
import { useOperatorTable, EmptyState } from '../../design-system';
import { OperatorTable } from '../../OperatorTable';
import { SkillGroup } from './SkillGroup';
import { SkillDetail } from './SkillDetail';
import { SKILL_COLUMNS } from './skillColumns';

interface Props {
    data: SkillLibraryViewData;
    onTableMeta?: (meta: { filteredRowCount: number; sortingDescription: string }) => void;
    activeStatuses: Set<SkillStatus>;
    query: string;
}

export function SkillLibraryView({ data, onTableMeta, activeStatuses, query }: Props) {
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

    const counts: Record<SkillStatus, number> = {
        duplicate: data.stats.duplicated,
        unique: data.stats.totalSkills - data.stats.duplicated,
    };

    const tableData = useMemo(() => {
        const filtered = filterSkills(data.skills, query, activeStatuses);
        return sortSkills(filtered, 'adoption');
    }, [data.skills, query, activeStatuses]);

    const table = useOperatorTable<SkillLibraryEntry>({
        data: tableData,
        columns: SKILL_COLUMNS,
        enablePagination: false,
    });

    useEffect(() => {
        onTableMeta?.({
            filteredRowCount: table.filteredRowCount,
            sortingDescription: '',
        });
    }, [table.filteredRowCount, onTableMeta]);

    const handleRowClick = useCallback((row: SkillLibraryEntry) => {
        setExpandedKeys(prev => {
            const key = row.id;
            if (prev.has(key)) return new Set();
            return new Set([key]);
        });
    }, []);

    const renderExpandedRow = useCallback((row: SkillLibraryEntry) => (
        <SkillDetail skill={row} />
    ), []);

    return (
        <div className="cr-skill-lib">
            <OperatorTable
                table={table.table}
                columns={SKILL_COLUMNS}
                getRowKey={row => row.id}
                onRowClick={handleRowClick}
                expandedRowKeys={expandedKeys}
                renderExpandedRow={renderExpandedRow}
                groupBy={row => row.status}
                groupOrder={STATUS_ORDER}
                renderGroupHeader={(status, rows) => (
                    <SkillGroup status={status as SkillStatus} count={rows.length} total={counts[status as SkillStatus] ?? rows.length} />
                )}
                getRowClassName={row => `cr-skill-lib__row--${row.status}`}
                className="cr-skill-lib-scroll"
                tableClassName="cr-registry-table cr-skill-lib-table"
                emptyState={
                    <EmptyState
                        size="inline"
                        icon={<SearchX size={20} />}
                        title="No skills match"
                        detail="Try adjusting filters or search query."
                    />
                }
            />
        </div>
    );
}
