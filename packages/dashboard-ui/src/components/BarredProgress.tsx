import type { CSSProperties } from 'react';
import { SimpleTooltip } from './Tooltip';

export type BarredProgressTone = 'signal' | 'danger' | 'warn' | 'ok' | 'neutral' | 'muted';

export interface BarredProgressSegment {
    value: number;
    label: string;
    tone?: BarredProgressTone;
}

export interface BarredProgressZone {
    until: number;
    tone: BarredProgressTone;
}

export interface BarredProgressProps {
    value?: number;
    max?: number;
    segments?: BarredProgressSegment[];
    zones?: BarredProgressZone[];
    bars?: number;
    size?: 'sm' | 'md';
    tone?: BarredProgressTone;
    showValue?: boolean;
    valueLabel?: string;
    ariaLabel?: string;
    tooltip?: string;
    className?: string;
}

const TONE_VARS: Record<BarredProgressTone, string> = {
    signal: 'var(--cr-signal)',
    danger: 'var(--cr-danger)',
    warn: 'var(--cr-warn)',
    ok: 'var(--cr-ok)',
    neutral: 'var(--cr-ink-1)',
    muted: 'var(--cr-ink-3)',
};

export function BarredProgress({
    value,
    max = 100,
    segments,
    zones,
    bars = 32,
    size = 'md',
    tone = 'signal',
    showValue = false,
    valueLabel,
    ariaLabel,
    tooltip,
    className,
}: BarredProgressProps) {
    const safeBars = Math.max(1, Math.floor(bars));
    const cells = segments && segments.length > 0
        ? buildSegmentCells(segments, safeBars)
        : buildValueCells(value ?? 0, max, safeBars, tone, zones);
    const label = ariaLabel ?? buildAriaLabel({ value, max, segments, valueLabel });
    const classes = [
        'cr-barred-progress',
        `cr-barred-progress--${size}`,
        showValue ? 'cr-barred-progress--with-value' : '',
        className,
    ].filter(Boolean).join(' ');

    const progress = (
        <div className={classes} role="img" aria-label={label}>
            <div className="cr-barred-progress__track" aria-hidden="true">
                {cells.map((cell, index) => (
                    <span
                        key={index}
                        className={`cr-barred-progress__bar${cell.active ? ' cr-barred-progress__bar--active' : ''}`}
                        style={{ '--cr-barred-color': TONE_VARS[cell.tone] } as CSSProperties}
                    />
                ))}
            </div>
            {showValue && (
                <span className="cr-barred-progress__value">
                    {valueLabel ?? Math.round(value ?? 0)}
                </span>
            )}
        </div>
    );

    return tooltip ? <SimpleTooltip content={tooltip}>{progress}</SimpleTooltip> : progress;
}

function buildValueCells(value: number, max: number, bars: number, tone: BarredProgressTone, zones?: BarredProgressZone[]) {
    const ratio = max > 0 ? clamp(value / max) : 0;
    const filled = Math.round(ratio * bars);
    return Array.from({ length: bars }, (_, index) => ({
        active: index < filled,
        tone: getCellTone((index + 0.5) / bars, tone, zones),
    }));
}

function getCellTone(ratio: number, fallback: BarredProgressTone, zones?: BarredProgressZone[]) {
    if (!zones || zones.length === 0) return fallback;
    return zones.find(zone => ratio <= clamp(zone.until))?.tone ?? zones[zones.length - 1].tone;
}

function buildSegmentCells(segments: BarredProgressSegment[], bars: number) {
    const positiveSegments = segments
        .map(segment => ({ ...segment, value: Math.max(0, segment.value) }))
        .filter(segment => segment.value > 0);
    const total = positiveSegments.reduce((sum, segment) => sum + segment.value, 0);
    if (total <= 0) {
        return Array.from({ length: bars }, () => ({ active: false, tone: 'muted' as BarredProgressTone }));
    }

    let cursor = 0;
    const ranges = positiveSegments.map(segment => {
        const start = cursor;
        cursor += segment.value;
        return { start, end: cursor, tone: segment.tone ?? 'signal' as BarredProgressTone };
    });

    return Array.from({ length: bars }, (_, index) => {
        const midpoint = ((index + 0.5) / bars) * total;
        const range = ranges.find(item => midpoint >= item.start && midpoint < item.end) ?? ranges[ranges.length - 1];
        return { active: true, tone: range.tone };
    });
}

function buildAriaLabel({
    value,
    max,
    segments,
    valueLabel,
}: {
    value?: number;
    max: number;
    segments?: BarredProgressSegment[];
    valueLabel?: string;
}) {
    if (segments && segments.length > 0) {
        return segments.map(segment => `${segment.label} ${segment.value}`).join(', ');
    }
    return valueLabel ?? `${value ?? 0} of ${max}`;
}

function clamp(value: number) {
    return Math.max(0, Math.min(1, value));
}
