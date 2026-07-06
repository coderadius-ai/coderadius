import { useEffect, useMemo, useState } from 'react';
import { Inbox, SearchX } from 'lucide-react';
import type { TieredBlastNode } from '../../lib/topology';
import { StreamRow } from './stream/StreamRow';
import { StreamToolbar } from './stream/StreamToolbar';
import { EmptyState, CrButton } from '../design-system';
import {
    mergeStream,
    filterStream,
    sortStream,
    countByKindInScope,
    countByDirectionInScope,
    type Direction,
    type SortKey,
} from './utils/stream';

/**
 * v3 single-stream list view for the Blast Radius Explorer.
 *
 * Replaces the legacy two-column TieredBlastPanel layout with one dense
 * stream of rows. Direction (inbound / outbound) is a per-row glyph plus a
 * toolbar pill, not a column. Optimised for listing / scanning, search and
 * filtering, not for at-a-glance impact split (that's what the graph view
 * is for).
 *
 * Filter state lives locally and resets on pivot (`items` reference change).
 */
export function BlastRadiusListView({
    items,
    onDetailsClick,
    onExploreClick,
}: {
    items: TieredBlastNode[];
    onDetailsClick: (item: TieredBlastNode) => void;
    onExploreClick: (urn: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [direction, setDirection] = useState<Direction>('all');
    const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
    const [sort, setSort] = useState<SortKey>('default');

    useEffect(() => {
        setQuery('');
        setDirection('all');
        setActiveKinds(new Set());
        setSort('default');
    }, [items]);

    const rows = useMemo(() => mergeStream(items), [items]);

    const dirCounts = useMemo(
        () => countByDirectionInScope(rows, query, activeKinds),
        [rows, query, activeKinds],
    );

    const { byKind, t2: t2Count } = useMemo(
        () => countByKindInScope(rows, query, direction),
        [rows, query, direction],
    );

    const kindCounts = useMemo(
        () => Array.from(byKind.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count })),
        [byKind],
    );

    const visible = useMemo(
        () => sortStream(filterStream(rows, { query, direction, activeKinds }), sort),
        [rows, query, direction, activeKinds, sort],
    );

    const toggleKind = (key: string) => {
        setActiveKinds(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const clearFilters = () => {
        setQuery('');
        setDirection('all');
        setActiveKinds(new Set());
    };

    return (
        <div className="blast-stream-view cr-cap-data">
            <StreamToolbar
                query={query}
                onQueryChange={setQuery}
                direction={direction}
                onDirectionChange={setDirection}
                dirCounts={dirCounts}
                kindCounts={kindCounts}
                t2Count={t2Count}
                activeKinds={activeKinds}
                onToggleKind={toggleKind}
                sort={sort}
                onSortChange={setSort}
                totalCount={rows.length}
                filteredCount={visible.length}
            />

            {visible.length === 0 ? (
                rows.length === 0 ? (
                    <EmptyState size="inline" icon={<Inbox size={20} />} title="No items in this blast radius" />
                ) : (
                    <EmptyState
                        size="inline"
                        icon={<SearchX size={20} />}
                        title="No items match the current filters"
                        action={<CrButton onClick={clearFilters}>Clear filters</CrButton>}
                    />
                )
            ) : (
                <div className="blast-stream-list" role="list">
                    {visible.map(row => (
                        <StreamRow
                            key={`${row.urn}::${row.direction}::${row.tier}`}
                            row={row}
                            onDetailsClick={() => onDetailsClick(row)}
                            onExploreClick={() => onExploreClick(row.urn)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
