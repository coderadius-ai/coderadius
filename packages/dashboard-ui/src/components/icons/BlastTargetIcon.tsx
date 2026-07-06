import type { CSSProperties } from 'react';

/**
 * Concentric circles icon used as the visual identity for "blast target" /
 * "blast radius" actions. Matches the chip rendered on graph cards in the
 * Blast Radius Explorer so the icon reads 1:1 across surfaces.
 *
 * Stroke uses `currentColor` so the parent button can drive the colour via
 * its own hover/focus rules.
 */
export function BlastTargetIcon({
    size = 12,
    strokeWidth = 1.4,
    style,
}: {
    size?: number;
    strokeWidth?: number;
    style?: CSSProperties;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            aria-hidden="true"
            style={style}
        >
            <circle cx="7" cy="7" r="5.5" />
            <circle cx="7" cy="7" r="2.5" />
            <circle cx="7" cy="7" r="0.6" fill="currentColor" />
        </svg>
    );
}
