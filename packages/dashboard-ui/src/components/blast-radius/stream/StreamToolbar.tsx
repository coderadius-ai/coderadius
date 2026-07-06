import { Search } from 'lucide-react';
import { NodeTypeFilterBar } from '../../Taxonomy';
import { ToggleGroup } from '../../design-system';
import type { Direction, SortKey } from '../utils/stream';
import { T2_KEY } from '../utils/stream';

interface KindCount { type: string; count: number }

/**
 * Sticky toolbar above the v3 single-stream list. Owns no state — it surfaces
 * the local state held by `BlastRadiusListView`. Layout:
 *
 *   [search input ────────────────] [All|In|Out] [sort]
 *   [NodeTypeFilterBar — kinds + T2]
 *
 * Both rows scope-aware: counts on the kind chips reflect the active
 * query+direction; counts on the direction pills reflect the active
 * query+kinds. See `countByKindInScope` / `countByDirectionInScope`.
 */
export function StreamToolbar({
    query,
    onQueryChange,
    direction,
    onDirectionChange,
    dirCounts,
    kindCounts,
    t2Count,
    activeKinds,
    onToggleKind,
    sort,
    onSortChange,
    totalCount,
    filteredCount,
}: {
    query: string;
    onQueryChange: (q: string) => void;
    direction: Direction;
    onDirectionChange: (d: Direction) => void;
    dirCounts: { all: number; in: number; out: number };
    kindCounts: KindCount[];
    t2Count: number;
    activeKinds: Set<string>;
    onToggleKind: (key: string) => void;
    sort: SortKey;
    onSortChange: (s: SortKey) => void;
    totalCount: number;
    filteredCount: number;
}) {
    const isFiltered = filteredCount !== totalCount;
    const countTitle = isFiltered
        ? `Showing ${filteredCount} of ${totalCount} rows`
        : `${totalCount} row${totalCount === 1 ? '' : 's'}`;
    const dirOptions: Array<{ key: Direction; label: string; count: number }> = [
        { key: 'all', label: 'All', count: dirCounts.all },
        { key: 'in',  label: 'In',  count: dirCounts.in  },
        { key: 'out', label: 'Out', count: dirCounts.out },
    ];

    return (
        <div className="blast-stream-toolbar" role="toolbar" aria-label="List filters">
            <div className="blast-stream-toolbar__top">
                <label className="blast-stream-toolbar__search">
                    <Search size={12} />
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => onQueryChange(e.target.value)}
                        placeholder="Filter by name, path, team, repo or URN"
                        aria-label="Filter rows"
                    />
                </label>

                <ToggleGroup
                    options={dirOptions.map(opt => ({ value: opt.key, label: opt.label, count: opt.count }))}
                    value={direction}
                    onChange={onDirectionChange}
                    size="sm"
                />

                <label className="blast-stream-toolbar__sort">
                    <span className="blast-stream-toolbar__sort-label">Sort</span>
                    <select
                        value={sort}
                        onChange={(e) => onSortChange(e.target.value as SortKey)}
                        aria-label="Sort order"
                    >
                        <option value="default">Default</option>
                        <option value="name">Name (A→Z)</option>
                        <option value="direction">Direction</option>
                        <option value="rel">Relation</option>
                    </select>
                </label>
            </div>

            <div className="blast-stream-toolbar__row2">
                {(kindCounts.length > 1 || t2Count > 0) && (
                    <NodeTypeFilterBar
                        types={kindCounts}
                        t2Count={t2Count}
                        activeTypes={activeKinds}
                        onToggle={onToggleKind}
                    />
                )}
                {isFiltered && (
                    <span
                        className="blast-stream-toolbar__count blast-stream-toolbar__count--filtered"
                        title={countTitle}
                        aria-label={countTitle}
                    >
                        <span className="blast-stream-toolbar__count-num">{filteredCount}</span>
                        <span className="blast-stream-toolbar__count-sep">of</span>
                        <span className="blast-stream-toolbar__count-num">{totalCount}</span>
                    </span>
                )}
            </div>
        </div>
    );
}

export { T2_KEY };
