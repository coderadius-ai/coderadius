import { useState, useCallback } from 'react';
import { SearchX } from 'lucide-react';
import type { Table } from '@tanstack/react-table';
import type { OperatorTableColumn } from '../../OperatorTable';
import { OperatorTable } from '../../OperatorTable';
import { EmptyState } from '../../design-system';
import type { RepoReadiness } from '../readiness.model';
import { RepoDetail } from './RepoDetail';

interface Props {
    table: Table<RepoReadiness>;
    columns: readonly OperatorTableColumn<RepoReadiness>[];
}

export function ReadinessTable({ table, columns }: Props) {
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

    const handleRowClick = useCallback((row: RepoReadiness) => {
        setExpandedKeys(prev => {
            const key = row.repoName;
            if (prev.has(key)) return new Set();
            return new Set([key]);
        });
    }, []);

    const renderExpandedRow = useCallback((row: RepoReadiness) => (
        <RepoDetail repo={row} />
    ), []);

    return (
        <OperatorTable
            table={table}
            columns={columns}
            getRowKey={row => row.repoName}
            onRowClick={handleRowClick}
            expandedRowKeys={expandedKeys}
            renderExpandedRow={renderExpandedRow}
            className="cr-readiness-scroll"
            tableClassName="cr-registry-table cr-readiness-table"
            emptyState={
                <EmptyState size="inline" icon={<SearchX size={20} />} title="No repos match this filter" detail="Adjust or clear the filter to see more." />
            }
        />
    );
}
