import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TieredBlastNode } from '../../../lib/topology';
import { NodeIcon, RelBadge } from '../../Taxonomy';

/** Collapsible section that groups all `Package` impact items below the main panel. */
export function PackageDepsSection({
    items,
    onDetailsClick,
}: {
    items: TieredBlastNode[];
    onDetailsClick: (item: TieredBlastNode) => void;
}) {
    const [isOpen, setIsOpen] = useState(false);

    const groupedItems = useMemo(() => {
        const map = new Map<string, TieredBlastNode & { rels: string[] }>();
        for (const item of items) {
            if (map.has(item.urn)) {
                const existing = map.get(item.urn)!;
                if (!existing.rels.includes(item.rel)) {
                    existing.rels.push(item.rel);
                }
            } else {
                map.set(item.urn, { ...item, rels: [item.rel] });
            }
        }
        return Array.from(map.values());
    }, [items]);

    return (
        <div className={`blast-pkg-section${isOpen ? ' blast-pkg-section--open' : ''}`}>
            <button
                className="blast-pkg-section__header"
                onClick={() => setIsOpen(!isOpen)}
                aria-expanded={isOpen}
            >
                <span className="blast-pkg-section__icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M2 4.5L8 1.5l6 3v7l-6 3-6-3v-7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                        <path d="M2 4.5L8 7.5l6-3M8 7.5v7" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                </span>
                <span className="blast-pkg-section__title">Software Dependencies</span>
                <span className="blast-pkg-section__count">{items.length}</span>
                <span className={`blast-pkg-section__chevron${isOpen ? ' blast-pkg-section__chevron--open' : ''}`} aria-hidden="true">
                    <ChevronRight size={12} />
                </span>
            </button>
            {isOpen && (
                <div className="blast-pkg-section__list">
                    {groupedItems.map((item) => (
                        <button
                            key={item.urn}
                            className="blast-pkg-section__row"
                            onClick={() => onDetailsClick(item)}
                        >
                            <NodeIcon type="Package" size={13} />
                            <span className="blast-pkg-section__row-name">{item.node.name}</span>
                            <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                                {item.rels.map((r, i) => (
                                    <RelBadge key={`${r}-${i}`} rel={r} />
                                ))}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
