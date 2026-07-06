import { useState, useMemo } from 'react';
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    type SortingState,
    type ColumnFiltersState,
    type ColumnDef,
    type Table,
    type RowData,
} from '@tanstack/react-table';
import type { OperatorTableColumn } from '../OperatorTable';

declare module '@tanstack/react-table' {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface ColumnMeta<TData extends RowData, TValue> {
        align?: 'left' | 'center' | 'right';
        width?: string;
    }
}

export interface UseOperatorTableConfig<T> {
    data: readonly T[];
    columns: readonly OperatorTableColumn<T>[];
    initialSorting?: SortingState;
    pageSize?: number;
    enablePagination?: boolean;
}

export interface UseOperatorTableReturn<T> {
    table: Table<T>;
    globalFilter: string;
    setGlobalFilter: (value: string) => void;
    sorting: SortingState;
    setSorting: (value: SortingState) => void;
    sortingDescription: string;
    columnFilters: ColumnFiltersState;
    setColumnFilters: (value: ColumnFiltersState) => void;
    pageCount: number;
    filteredRowCount: number;
    totalRowCount: number;
}

function buildSearchText<T>(row: T, columns: readonly OperatorTableColumn<T>[]): string {
    const parts: string[] = [];
    for (const col of columns) {
        if (col.filterValue) {
            parts.push(col.filterValue(row));
        } else if (col.sortValue) {
            const v = col.sortValue(row);
            if (v != null) parts.push(String(v));
        }
    }
    return parts.join(' ').toLowerCase();
}

function buildSortingDescription<T>(
    sorting: SortingState,
    columns: readonly OperatorTableColumn<T>[],
): string {
    if (sorting.length === 0) return '';
    const colMap = new Map(columns.map(c => [c.id, c]));
    const parts = sorting.map(s => {
        const col = colMap.get(s.id);
        const label = typeof col?.header === 'string' ? col.header.toLowerCase() : s.id;
        return `${s.desc ? '↓' : '↑'} ${label}`;
    });
    return `sorted ${parts.join(', ')}`;
}

export function useOperatorTable<T>({
    data,
    columns,
    initialSorting = [],
    pageSize = 50,
    enablePagination = true,
}: UseOperatorTableConfig<T>): UseOperatorTableReturn<T> {
    const [sorting, setSorting] = useState<SortingState>(initialSorting);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

    const filterValueFns = useMemo(() => {
        const map = new Map<string, (row: T) => string>();
        for (const col of columns) {
            if (col.filterValue) map.set(col.id, col.filterValue);
        }
        return map;
    }, [columns]);

    const tanstackColumns = useMemo<ColumnDef<T>[]>(() => {
        return columns.map(col => ({
            id: col.id,
            header: () => col.header,
            accessorFn: col.sortValue
                ? (row: T) => col.sortValue!(row)
                : () => null,
            enableSorting: col.sortable ?? !!col.sortValue,
            enableColumnFilter: !!col.filterValue,
            filterFn: col.filterValue
                ? (row: any, _columnId: string, filterValue: string) => {
                    const fn = filterValueFns.get(col.id);
                    if (!fn || !filterValue) return true;
                    const text = fn(row.original as T).toLowerCase();
                    const words = filterValue.split(/\s+/).filter(Boolean);
                    return words.some(w => text.includes(w));
                }
                : undefined,
            meta: { align: col.align, width: col.width },
        }));
    }, [columns, filterValueFns]);

    const searchIndex = useMemo(() => {
        const map = new WeakMap<T & object, string>();
        for (const row of data) {
            if (row && typeof row === 'object') {
                map.set(row as T & object, buildSearchText(row, columns));
            }
        }
        return map;
    }, [data, columns]);

    const table = useReactTable<T>({
        data: data as T[],
        columns: tanstackColumns,
        state: { sorting, globalFilter, columnFilters },
        autoResetAll: false,
        enableMultiSort: true,
        isMultiSortEvent: (e) => (e as MouseEvent).shiftKey,
        onSortingChange: (updater) => {
            setSorting(typeof updater === 'function' ? updater(sorting) : updater);
        },
        onGlobalFilterChange: setGlobalFilter,
        onColumnFiltersChange: setColumnFilters,
        enableFilters: true,
        enableColumnFilters: true,
        globalFilterFn: (row, _columnId, filterValue) => {
            if (!filterValue) return true;
            const text = searchIndex.get(row.original as T & object) ?? '';
            const words: string[] = filterValue.toLowerCase().split(/\s+/).filter(Boolean);
            return words.every((w: string) => text.includes(w));
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        ...(enablePagination ? {
            getPaginationRowModel: getPaginationRowModel(),
            initialState: { pagination: { pageSize } },
        } : {
            manualPagination: true,
            pageCount: 1,
        }),
    });

    const sortingDescription = useMemo(
        () => buildSortingDescription(sorting, columns),
        [sorting, columns],
    );

    return {
        table,
        globalFilter,
        setGlobalFilter,
        sorting,
        setSorting: (value) => setSorting(value),
        sortingDescription,
        columnFilters,
        setColumnFilters,
        pageCount: enablePagination ? table.getPageCount() : 1,
        filteredRowCount: table.getFilteredRowModel().rows.length,
        totalRowCount: data.length,
    };
}
