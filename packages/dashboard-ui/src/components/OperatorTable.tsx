import { Fragment, useRef, useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { Table } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

export type OperatorTableAlign = 'left' | 'center' | 'right';

export interface OperatorTableColumn<T> {
    id: string;
    header: ReactNode;
    render: (row: T, index: number) => ReactNode;
    width?: string;
    align?: OperatorTableAlign;
    className?: string | ((row: T, index: number) => string | undefined);
    headerClassName?: string;
    sortValue?: (row: T) => string | number | null;
    filterValue?: (row: T) => string;
    sortable?: boolean;
    hidden?: boolean;
}

export interface OperatorTableProps<T> {
    rows?: readonly T[];
    columns: readonly OperatorTableColumn<T>[];
    getRowKey: (row: T, index: number) => string;
    ariaLabel?: string;
    className?: string;
    tableClassName?: string;
    minWidth?: string;
    selectedRowKey?: string;
    getRowClassName?: (row: T, index: number) => string | undefined;
    onRowClick?: (row: T, index: number) => void;
    emptyState?: ReactNode;
    table?: Table<T>;
    groupBy?: (row: T, index: number) => string | null | undefined;
    groupOrder?: readonly string[];
    renderGroupHeader?: (groupKey: string, rows: readonly T[]) => ReactNode;
    expandedRowKeys?: ReadonlySet<string> | readonly string[];
    renderExpandedRow?: (row: T, index: number) => ReactNode;
    hidePagination?: boolean;
}

const VIRTUALIZE_THRESHOLD = 100;
const ROW_HEIGHT_ESTIMATE = 44;
const GROUP_HEIGHT_ESTIMATE = 42;
const EXPANDED_HEIGHT_ESTIMATE = 200;
const OVERSCAN = 20;

type RenderItem<T> =
    | { kind: 'group'; key: string; groupKey: string; groupRows: readonly T[] }
    | { kind: 'data'; key: string; row: T; rowIndex: number; expanded: boolean }
    | { kind: 'expanded'; key: string; row: T; rowIndex: number };

function buildRenderItems<T>(
    rows: readonly T[],
    getRowKey: (row: T, index: number) => string,
    groupBy: ((row: T, index: number) => string | null | undefined) | undefined,
    groupMap: Map<string, T[]> | undefined,
    expandedSet: ReadonlySet<string> | undefined,
    hasExpandedRenderer: boolean,
): RenderItem<T>[] {
    const items: RenderItem<T>[] = [];
    let prevGroup: string | null | undefined;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowKey = getRowKey(row, i);
        const groupKey = groupBy?.(row, i) ?? null;

        if (groupKey != null && groupKey !== prevGroup) {
            items.push({ kind: 'group', key: `g:${groupKey}`, groupKey, groupRows: groupMap?.get(groupKey) ?? [] });
            prevGroup = groupKey;
        }

        const expanded = hasExpandedRenderer && (expandedSet?.has(rowKey) ?? false);
        items.push({ kind: 'data', key: rowKey, row, rowIndex: i, expanded });

        if (expanded) {
            items.push({ kind: 'expanded', key: `x:${rowKey}`, row, rowIndex: i });
        }
    }
    return items;
}

export function OperatorTable<T>({
    rows: rowsProp,
    columns,
    getRowKey,
    ariaLabel,
    className,
    tableClassName,
    minWidth,
    selectedRowKey,
    getRowClassName,
    onRowClick,
    emptyState,
    table,
    groupBy,
    groupOrder,
    renderGroupHeader,
    expandedRowKeys,
    renderExpandedRow,
    hidePagination = false,
}: OperatorTableProps<T>) {
    const isPowered = !!table;
    const rawRows = isPowered
        ? table.getRowModel().rows.map(r => r.original)
        : (rowsProp ?? []);
    const rows = groupBy && groupOrder
        ? sortByGroupOrder(rawRows, groupBy, groupOrder)
        : rawRows;

    const visibleColumns = columns.filter(c => !c.hidden);
    const interactive = Boolean(onRowClick);
    const tableStyle = minWidth
        ? ({ '--cr-operator-table-min-width': minWidth } as CSSProperties)
        : undefined;
    const expandedSet = toExpandedSet(expandedRowKeys);
    const groupMap = useMemo(
        () => groupBy ? buildGroupRows(rows, groupBy) : undefined,
        [rows, groupBy],
    );

    const renderItems = useMemo(
        () => buildRenderItems(rows, getRowKey, groupBy, groupMap, expandedSet, !!renderExpandedRow),
        [rows, getRowKey, groupBy, groupMap, expandedSet, renderExpandedRow],
    );

    const shouldVirtualize = renderItems.length > VIRTUALIZE_THRESHOLD;

    return (
        <div className={cx('cr-operator-table-host', className)}>
            <table
                className={cx('cr-operator-table', tableClassName)}
                style={tableStyle}
                aria-label={ariaLabel}
            >
                <colgroup>
                    {visibleColumns.map(column => (
                        <col key={column.id} style={column.width ? { width: column.width } : undefined} />
                    ))}
                </colgroup>
                <thead>
                    <tr>
                        {isPowered ? (() => {
                            const sortCount = table.getState().sorting.length;
                            const visibleIds = new Set(visibleColumns.map(c => c.id));
                            const colById = new Map(visibleColumns.map(c => [c.id, c]));
                            return table.getHeaderGroups()[0].headers
                                .filter(h => visibleIds.has(h.column.id))
                                .map((header) => {
                                const col = colById.get(header.column.id)!;
                                const sorted = header.column.getIsSorted();
                                const canSort = header.column.getCanSort();
                                const sortIndex = sorted ? header.column.getSortIndex() : -1;
                                return (
                                    <th
                                        key={col.id}
                                        className={cx(
                                            'cr-operator-table__header',
                                            alignClass(col.align),
                                            canSort && 'cr-operator-table__header--sortable',
                                            sorted && 'cr-operator-table__header--sorted',
                                            col.headerClassName,
                                        )}
                                        scope="col"
                                        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                                        aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                                    >
                                        <span className="cr-operator-table__header-content">
                                            {col.header}
                                            {sorted && (
                                                <span className="cr-operator-table__sort-icon" aria-hidden="true">
                                                    {sorted === 'asc' ? '↑' : '↓'}
                                                    {sortCount > 1 && (
                                                        <sup className="cr-operator-table__sort-ordinal">{sortIndex + 1}</sup>
                                                    )}
                                                </span>
                                            )}
                                        </span>
                                    </th>
                                );
                            });
                        })() : (
                            visibleColumns.map(column => (
                                <th
                                    key={column.id}
                                    className={cx(
                                        'cr-operator-table__header',
                                        alignClass(column.align),
                                        column.headerClassName,
                                    )}
                                    scope="col"
                                >
                                    {column.header}
                                </th>
                            ))
                        )}
                    </tr>
                </thead>
                {shouldVirtualize ? (
                    <VirtualizedBody
                        renderItems={renderItems}
                        visibleColumns={visibleColumns}
                        interactive={interactive}
                        selectedRowKey={selectedRowKey}
                        getRowClassName={getRowClassName}
                        onRowClick={onRowClick}
                        renderGroupHeader={renderGroupHeader}
                        renderExpandedRow={renderExpandedRow}
                    />
                ) : (
                    <PlainBody
                        rows={rows}
                        visibleColumns={visibleColumns}
                        interactive={interactive}
                        selectedRowKey={selectedRowKey}
                        getRowKey={getRowKey}
                        getRowClassName={getRowClassName}
                        onRowClick={onRowClick}
                        groupBy={groupBy}
                        groupMap={groupMap}
                        renderGroupHeader={renderGroupHeader}
                        expandedSet={expandedSet}
                        renderExpandedRow={renderExpandedRow}
                    />
                )}
            </table>
            {rows.length === 0 && emptyState}

            {isPowered && !hidePagination && table.getPageCount() > 1 && (
                <div className="cr-operator-table__pagination">
                    <span className="cr-operator-table__page-info">
                        Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                    </span>
                    <div className="cr-operator-table__page-buttons">
                        <button
                            className="cr-operator-table__page-btn"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                            aria-label="Previous page"
                        >
                            ‹
                        </button>
                        <button
                            className="cr-operator-table__page-btn"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                            aria-label="Next page"
                        >
                            ›
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function VirtualizedBody<T>({
    renderItems,
    visibleColumns,
    interactive,
    selectedRowKey,
    getRowClassName,
    onRowClick,
    renderGroupHeader,
    renderExpandedRow,
}: {
    renderItems: RenderItem<T>[];
    visibleColumns: OperatorTableColumn<T>[];
    interactive: boolean;
    selectedRowKey?: string;
    getRowClassName?: (row: T, index: number) => string | undefined;
    onRowClick?: (row: T, index: number) => void;
    renderGroupHeader?: (groupKey: string, rows: readonly T[]) => ReactNode;
    renderExpandedRow?: (row: T, index: number) => ReactNode;
}) {
    const scrollRef = useRef<HTMLTableSectionElement>(null);

    const virtualizer = useVirtualizer({
        count: renderItems.length,
        getScrollElement: () => scrollRef.current?.closest('.cr-operator-table-host') as HTMLElement | null,
        estimateSize: (index) => {
            const item = renderItems[index];
            if (item.kind === 'group') return GROUP_HEIGHT_ESTIMATE;
            if (item.kind === 'expanded') return EXPANDED_HEIGHT_ESTIMATE;
            return ROW_HEIGHT_ESTIMATE;
        },
        overscan: OVERSCAN,
    });

    const virtualItems = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();

    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
    const paddingBottom = virtualItems.length > 0
        ? totalSize - virtualItems[virtualItems.length - 1].end
        : 0;

    return (
        <tbody ref={scrollRef}>
            {paddingTop > 0 && (
                <tr aria-hidden="true">
                    <td colSpan={visibleColumns.length} style={{ height: paddingTop, padding: 0, border: 'none' }} />
                </tr>
            )}
            {virtualItems.map(virtualRow => {
                const item = renderItems[virtualRow.index];

                if (item.kind === 'group') {
                    return (
                        <tr
                            key={item.key}
                            ref={virtualizer.measureElement}
                            data-index={virtualRow.index}
                            className="cr-operator-table__group-row"
                        >
                            <td className="cr-operator-table__group-cell" colSpan={visibleColumns.length}>
                                {renderGroupHeader?.(item.groupKey, item.groupRows) ?? item.groupKey}
                            </td>
                        </tr>
                    );
                }

                if (item.kind === 'expanded') {
                    return (
                        <tr
                            key={item.key}
                            ref={virtualizer.measureElement}
                            data-index={virtualRow.index}
                            className="cr-operator-table__expanded-row"
                        >
                            <td className="cr-operator-table__expanded-cell" colSpan={visibleColumns.length}>
                                {renderExpandedRow?.(item.row, item.rowIndex)}
                            </td>
                        </tr>
                    );
                }

                const selected = selectedRowKey === item.key;
                return (
                    <tr
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                        className={cx(
                            'cr-operator-table__row',
                            interactive && 'cr-operator-table__row--interactive',
                            selected && 'cr-operator-table__row--selected',
                            item.expanded && 'cr-operator-table__row--expanded',
                            getRowClassName?.(item.row, item.rowIndex),
                        )}
                        style={{ '--row-index': Math.min(item.rowIndex, 12) } as CSSProperties}
                        aria-selected={selected || undefined}
                        aria-expanded={renderExpandedRow ? item.expanded : undefined}
                        tabIndex={interactive ? 0 : undefined}
                        onClick={interactive ? () => onRowClick?.(item.row, item.rowIndex) : undefined}
                        onKeyDown={interactive ? (event) => handleRowKeyDown(event, item.row, item.rowIndex, onRowClick) : undefined}
                    >
                        {visibleColumns.map(column => (
                            <td
                                key={column.id}
                                className={cx(
                                    'cr-operator-table__cell',
                                    alignClass(column.align),
                                    cellClassName(column, item.row, item.rowIndex),
                                )}
                            >
                                {column.render(item.row, item.rowIndex)}
                            </td>
                        ))}
                    </tr>
                );
            })}
            {paddingBottom > 0 && (
                <tr aria-hidden="true">
                    <td colSpan={visibleColumns.length} style={{ height: paddingBottom, padding: 0, border: 'none' }} />
                </tr>
            )}
        </tbody>
    );
}

function PlainBody<T>({
    rows,
    visibleColumns,
    interactive,
    selectedRowKey,
    getRowKey,
    getRowClassName,
    onRowClick,
    groupBy,
    groupMap,
    renderGroupHeader,
    expandedSet,
    renderExpandedRow,
}: {
    rows: readonly T[];
    visibleColumns: OperatorTableColumn<T>[];
    interactive: boolean;
    selectedRowKey?: string;
    getRowKey: (row: T, index: number) => string;
    getRowClassName?: (row: T, index: number) => string | undefined;
    onRowClick?: (row: T, index: number) => void;
    groupBy?: (row: T, index: number) => string | null | undefined;
    groupMap?: Map<string, T[]>;
    renderGroupHeader?: (groupKey: string, rows: readonly T[]) => ReactNode;
    expandedSet?: ReadonlySet<string>;
    renderExpandedRow?: (row: T, index: number) => ReactNode;
}) {
    let previousGroupKey: string | null | undefined;

    return (
        <tbody>
            {rows.map((row, index) => {
                const rowKey = getRowKey(row, index);
                const selected = selectedRowKey === rowKey;
                const expanded = expandedSet?.has(rowKey) ?? false;
                const groupKey = groupBy?.(row, index) ?? null;
                const shouldRenderGroup = groupKey != null && groupKey !== previousGroupKey;
                previousGroupKey = groupKey;
                return (
                    <Fragment key={rowKey}>
                        {shouldRenderGroup && (
                            <tr className="cr-operator-table__group-row">
                                <td className="cr-operator-table__group-cell" colSpan={visibleColumns.length}>
                                    {renderGroupHeader?.(groupKey, groupMap?.get(groupKey) ?? []) ?? groupKey}
                                </td>
                            </tr>
                        )}
                        <tr
                            className={cx(
                                'cr-operator-table__row',
                                interactive && 'cr-operator-table__row--interactive',
                                selected && 'cr-operator-table__row--selected',
                                expanded && 'cr-operator-table__row--expanded',
                                getRowClassName?.(row, index),
                            )}
                            style={{ '--row-index': Math.min(index, 12) } as CSSProperties}
                            aria-selected={selected || undefined}
                            aria-expanded={renderExpandedRow ? expanded : undefined}
                            tabIndex={interactive ? 0 : undefined}
                            onClick={interactive ? () => onRowClick?.(row, index) : undefined}
                            onKeyDown={interactive ? (event) => handleRowKeyDown(event, row, index, onRowClick) : undefined}
                        >
                            {visibleColumns.map(column => (
                                <td
                                    key={column.id}
                                    className={cx(
                                        'cr-operator-table__cell',
                                        alignClass(column.align),
                                        cellClassName(column, row, index),
                                    )}
                                >
                                    {column.render(row, index)}
                                </td>
                            ))}
                        </tr>
                        {expanded && renderExpandedRow && (
                            <tr className="cr-operator-table__expanded-row">
                                <td className="cr-operator-table__expanded-cell" colSpan={visibleColumns.length}>
                                    {renderExpandedRow(row, index)}
                                </td>
                            </tr>
                        )}
                    </Fragment>
                );
            })}
        </tbody>
    );
}

function sortByGroupOrder<T>(
    rows: readonly T[],
    groupBy: (row: T, index: number) => string | null | undefined,
    groupOrder: readonly string[],
): T[] {
    const rank = new Map(groupOrder.map((key, i) => [key, i]));
    const fallback = groupOrder.length;
    return [...rows].sort((a, b) => {
        const ra = rank.get(groupBy(a, 0) ?? '') ?? fallback;
        const rb = rank.get(groupBy(b, 0) ?? '') ?? fallback;
        return ra - rb;
    });
}

function buildGroupRows<T>(
    rows: readonly T[],
    groupBy: (row: T, index: number) => string | null | undefined,
) {
    const groups = new Map<string, T[]>();
    rows.forEach((row, index) => {
        const key = groupBy(row, index);
        if (key == null) return;
        const groupRows = groups.get(key);
        if (groupRows) {
            groupRows.push(row);
        } else {
            groups.set(key, [row]);
        }
    });
    return groups;
}

function toExpandedSet(expandedRowKeys: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | undefined {
    if (!expandedRowKeys) return undefined;
    if (Array.isArray(expandedRowKeys)) return new Set(expandedRowKeys);
    return expandedRowKeys as ReadonlySet<string>;
}

function handleRowKeyDown<T>(
    event: KeyboardEvent<HTMLTableRowElement>,
    row: T,
    index: number,
    onRowClick: OperatorTableProps<T>['onRowClick'],
) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onRowClick?.(row, index);
}

function cellClassName<T>(column: OperatorTableColumn<T>, row: T, index: number) {
    return typeof column.className === 'function'
        ? column.className(row, index)
        : column.className;
}

function alignClass(align: OperatorTableAlign | undefined) {
    if (!align || align === 'left') return undefined;
    return align ? `cr-operator-table--${align}` : undefined;
}

function cx(...values: Array<string | false | null | undefined>) {
    return values.filter(Boolean).join(' ');
}
