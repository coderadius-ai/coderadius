import type { ReactNode } from 'react';

export interface MetadataGridItem {
    label: string;
    value: ReactNode;
    span?: boolean;
}

export interface MetadataGridProps {
    items: MetadataGridItem[];
    columns?: 'fixed' | 'responsive';
    dense?: boolean;
    className?: string;
}

export function MetadataGrid({ items, columns = 'fixed', dense = false, className }: MetadataGridProps) {
    if (items.length === 0) return null;

    const cls = [
        'cr-meta-grid',
        columns === 'responsive' ? 'cr-meta-grid--responsive' : '',
        dense ? 'cr-meta-grid--dense' : '',
        className ?? '',
    ].filter(Boolean).join(' ');

    return (
        <dl className={cls}>
            {items.map(item => (
                <div key={item.label} className={`cr-meta-grid__row${item.span ? ' cr-meta-grid__row--span' : ''}`}>
                    <dt className="cr-meta-grid__key">{item.label}</dt>
                    <dd className="cr-meta-grid__value">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}
