import { useMemo, useCallback, useRef, type ReactNode } from 'react';
import { TaggedSearch, type SearchScope, type TaggedSearchState, type TaggedSearchHandle } from '../TaggedSearch';
import type { OperatorTableColumn } from '../OperatorTable';
import type { Table, ColumnFiltersState } from '@tanstack/react-table';

export interface OperatorFilterScope {
    columnId: string;
    label: string;
    color: string;
    icon?: ReactNode;
}

export interface OperatorFilterProps<T> {
    columns: readonly OperatorTableColumn<T>[];
    data: readonly T[];
    table: Table<T>;
    setGlobalFilter: (value: string) => void;
    setColumnFilters?: (value: ColumnFiltersState) => void;
    scopes?: OperatorFilterScope[];
    placeholder?: string;
    className?: string;
    style?: React.CSSProperties;
}

export function OperatorFilter<T>({
    columns,
    data,
    table,
    setGlobalFilter,
    scopes: scopesProp,
    setColumnFilters: setColumnFiltersProp,
    placeholder = 'filter team, stack, tier…',
    className,
    style,
}: OperatorFilterProps<T>) {
    const searchRef = useRef<TaggedSearchHandle>(null);

    const scopes = useMemo<SearchScope[]>(() => {
        if (scopesProp) {
            return scopesProp.map(s => ({
                key: s.columnId,
                label: s.label,
                color: s.color,
                icon: s.icon,
            }));
        }
        return columns
            .filter(col => col.filterValue)
            .map(col => ({
                key: col.id,
                label: typeof col.header === 'string' ? col.header : col.id,
                color: '#5B7CFF',
            }));
    }, [columns, scopesProp]);

    const uniqueValues = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const col of columns) {
            if (!col.filterValue) continue;
            const values = new Set<string>();
            for (const row of data) {
                const text = col.filterValue(row);
                if (text) {
                    for (const part of text.split(/\s+/)) {
                        if (part) values.add(part);
                    }
                }
            }
            map.set(col.id, values);
        }
        return map;
    }, [columns, data]);

    const applyColumnFilters = setColumnFiltersProp ?? ((v: ColumnFiltersState) => table.setColumnFilters(v));
    const handleSearch = useCallback((state: TaggedSearchState) => {
        if (state.activeScope) {
            const columnValue = state.scopeValue || state.query;
            applyColumnFilters([{
                id: state.activeScope.key,
                value: columnValue.toLowerCase(),
            }]);
            setGlobalFilter(state.query);
        } else {
            applyColumnFilters([]);
            setGlobalFilter(state.query);
        }
    }, [applyColumnFilters, setGlobalFilter]);

    const renderResults = useCallback((state: TaggedSearchState & { close: () => void }) => {
        if (!state.activeScope) return null;
        const values = uniqueValues.get(state.activeScope.key);
        if (!values || values.size === 0) return null;

        const q = state.query.toLowerCase();
        const filtered = Array.from(values)
            .filter(v => !q || v.toLowerCase().includes(q))
            .sort();

        if (filtered.length === 0) return null;

        return (
            <div className="cr-opfilter__values">
                {filtered.map(value => (
                    <button
                        key={value}
                        className="cr-opfilter__chip"
                        role="option"
                        aria-selected={false}
                        onMouseDown={(e) => { e.preventDefault(); }}
                        onClick={() => { searchRef.current?.setScopeValue(value); }}
                    >
                        {value}
                    </button>
                ))}
            </div>
        );
    }, [uniqueValues]);

    return (
        <div className={`cr-opfilter${className ? ` ${className}` : ''}`} style={style}>
            <TaggedSearch
                ref={searchRef}
                scopes={scopes}
                placeholder={placeholder}
                onSearch={handleSearch}
                renderResults={renderResults}
            />
        </div>
    );
}
