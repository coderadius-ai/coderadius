import { useMemo, useState } from 'react';
import { Inbox, SearchX } from 'lucide-react';
import type { TieredBlastNode } from '../../../lib/topology';
import { NodeTypeFilterBar } from '../../Taxonomy';
import { SimpleTooltip } from '../../Tooltip';
import { EmptyState } from '../../design-system';
import { sortItems } from '../utils/sort';
import { BlastCard } from './BlastCard';

/**
 * Left/right panel of the Blast Radius Explorer list view.
 *
 * Clean flat list: T1 cards first, T2 cards second. Filter chips appear at the
 * top — the chips themselves come from the shared `NodeTypeFilterBar` so the
 * list view and the graph view sidebar stay visually consistent.
 */
export function TieredBlastPanel({
    title, description, items, direction, emptyMessage, onDetailsClick, onExploreClick,
}: {
    title: string;
    description: string;
    items: TieredBlastNode[];
    direction: 'downstream' | 'upstream';
    emptyMessage: string;
    onDetailsClick: (item: TieredBlastNode) => void;
    onExploreClick: (urn: string) => void;
}) {
    const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());

    const groupedItems = useMemo(() => {
        const map = new Map<string, TieredBlastNode & { rels: string[]; totalCount: number }>();
        for (const item of items) {
            if (map.has(item.urn)) {
                const existing = map.get(item.urn)!;
                existing.totalCount++;
                if (!existing.rels.includes(item.rel)) {
                    existing.rels.push(item.rel);
                }
                // Also absorb extra rels injected by T2 enrichment
                for (const r of item.rels ?? []) {
                    if (!existing.rels.includes(r)) existing.rels.push(r);
                }
                if (item.functions) {
                    const existingFns = existing.functions || [];
                    const newFns = item.functions.filter(f => !existingFns.some(ef => ef.name === f.name));
                    existing.functions = [...existingFns, ...newFns];
                }
            } else {
                const rels = item.rels ?? [item.rel];
                map.set(item.urn, { ...item, rels, totalCount: 1 });
            }
        }
        return Array.from(map.values());
    }, [items]);

    const filtered = useMemo(() => {
        if (activeTypes.size === 0) return groupedItems;
        return groupedItems.filter(i => {
            if (activeTypes.has('T2') && i.tier === 2) return true;
            return activeTypes.has(i.node.type);
        });
    }, [groupedItems, activeTypes]);

    const sorted = useMemo(() => {
        // T1 first, then T2 — within each tier, sort by type
        return sortItems(filtered);
    }, [filtered]);

    const handleToggleType = (type: string) => {
        setActiveTypes(prev => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
        });
    };

    const filterTypes = useMemo(() => {
        const map = new Map<string, number>();
        for (const item of groupedItems) {
            map.set(item.node.type, (map.get(item.node.type) ?? 0) + 1);
        }
        return Array.from(map.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count }));
    }, [groupedItems]);

    const t2Count = useMemo(() => groupedItems.filter(i => i.tier === 2).length, [groupedItems]);

    return (
        <section className={`blast-panel blast-panel--${direction}`}>
            <header className="blast-panel__header">
                <div className="blast-panel__heading">
                    <span className={`blast-panel__dot blast-panel__dot--${direction}`} />
                    <SimpleTooltip content={description} side="bottom">
                        <div className="blast-panel__title-wrapper">
                            <h2 className="blast-panel__title">{title}</h2>
                            <span className="blast-panel__count">{groupedItems.length}</span>
                        </div>
                    </SimpleTooltip>
                </div>
            </header>

            {/* Filter chips */}
            <NodeTypeFilterBar
                types={filterTypes}
                t2Count={t2Count}
                activeTypes={activeTypes}
                onToggle={handleToggleType}
            />

            {groupedItems.length === 0 ? (
                <EmptyState size="inline" icon={<Inbox size={20} />} title={emptyMessage} />
            ) : filtered.length === 0 ? (
                <EmptyState
                    size="inline"
                    icon={<SearchX size={20} />}
                    title="No results match the current filter"
                    detail="Adjust or clear the type filter above."
                />
            ) : (
                <div className="blast-card-grid">
                    {sorted.map(item => (
                        <BlastCard
                            key={`${item.urn}-t${item.tier}`}
                            item={item}
                            onDetailsClick={() => onDetailsClick(item)}
                            onExploreClick={() => onExploreClick(item.urn)}
                            onViaExploreClick={onExploreClick}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}
