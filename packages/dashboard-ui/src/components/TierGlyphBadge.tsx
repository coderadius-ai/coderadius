import type { CSSProperties } from 'react';

export type TierGlyphTone = 'danger' | 'warn' | 'signal' | 'ok' | 'neutral' | 'muted';
export type TierGlyphShape = 'triangle' | 'square' | 'dot' | 'dash';

export interface TierGlyphBadgeProps {
    grade: string;
    label: string;
    description?: string;
    tone?: TierGlyphTone;
    shape?: TierGlyphShape;
    size?: 'sm' | 'md';
    variant?: 'badge' | 'minimal';
    className?: string;
}

const TONE_VARS: Record<TierGlyphTone, { bg: string; fg: string }> = {
    danger: { bg: 'var(--cr-danger)', fg: 'var(--cr-ink-0)' },
    warn: { bg: 'var(--cr-warn)', fg: 'var(--cr-bg-0)' },
    signal: { bg: 'var(--cr-signal)', fg: 'var(--cr-ink-0)' },
    ok: { bg: 'var(--cr-ok)', fg: 'var(--cr-bg-0)' },
    neutral: { bg: 'var(--cr-ink-1)', fg: 'var(--cr-bg-0)' },
    muted: { bg: 'var(--cr-ink-3)', fg: 'var(--cr-bg-0)' },
};

export function TierGlyphBadge({
    grade,
    label,
    description,
    tone = 'neutral',
    shape = 'dot',
    size = 'md',
    variant = 'badge',
    className,
}: TierGlyphBadgeProps) {
    const toneVars = TONE_VARS[tone];
    const style = {
        '--cr-tier-glyph-color': toneVars.bg,
        '--cr-tier-glyph-fg': toneVars.fg,
    } as CSSProperties;
    const classes = [
        'cr-tier-glyph-badge',
        `cr-tier-glyph-badge--${variant}`,
        `cr-tier-glyph-badge--${size}`,
        className,
    ].filter(Boolean).join(' ');

    return (
        <span
            className={classes}
            style={style}
            aria-label={description ? `${grade} ${label}: ${description}` : `${grade} ${label}`}
        >
            <span className={`cr-tier-glyph cr-tier-glyph--${shape}`} aria-hidden="true" />
            <span className="cr-tier-glyph-badge__grade">{grade}</span>
            <span className="cr-tier-glyph-badge__sep" aria-hidden="true">·</span>
            <span className="cr-tier-glyph-badge__label">{label}</span>
        </span>
    );
}
