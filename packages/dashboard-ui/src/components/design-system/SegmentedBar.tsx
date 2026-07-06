import type { CSSProperties } from 'react';

export interface SegmentedBarSegment {
    value: number;
    color: string;
    label?: string;
}

export interface SegmentedBarProps {
    segments: SegmentedBarSegment[];
    height?: number;
    className?: string;
}

export function SegmentedBar({ segments, height = 6, className }: SegmentedBarProps) {
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    if (total === 0) return <div className={`cr-segbar ${className ?? ''}`} />;

    return (
        <div
            className={`cr-segbar ${className ?? ''}`}
            style={{ '--segbar-h': `${height}px` } as CSSProperties}
            role="meter"
            aria-label={segments.map(s => s.label ?? `${s.value}`).join(', ')}
        >
            {segments.map((seg, i) => {
                const pct = (seg.value / total) * 100;
                if (pct === 0) return null;
                return (
                    <div
                        key={i}
                        className="cr-segbar__seg"
                        style={{
                            width: `${pct}%`,
                            background: seg.color,
                        }}
                    />
                );
            })}
        </div>
    );
}
