import { CornerDownRight } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';
import { SimpleTooltip } from './Tooltip';

/**
 * Shared "Show relation" affordance. Single source of truth for the icon,
 * label, and hover treatment used to surface a side-panel.
 *
 * Icon: `CornerDownRight` (lucide). The "follow this item" arrow, shared
 * across popover footers, sidebar resource rows and cluster member lists.
 *
 * Two variants:
 *   - `icon`: square button, hover-revealed via `.cr-row-action`/equivalent.
 *     Wraps in SimpleTooltip so the affordance is discoverable.
 *   - `row`: full-width text + icon. Used in popover action footers.
 */

interface BaseProps {
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    /** aria-label override. Defaults to "Show relation". */
    label?: string;
    className?: string;
    style?: CSSProperties;
}

interface IconVariantProps extends BaseProps {
    variant: 'icon';
    /**
     * `sm` (default) for popover member rows / sidebar lists where the row
     * is dense. `md` for data tables where the row is taller and the icon
     * needs more presence so it doesn't get lost next to the cell text.
     */
    size?: 'sm' | 'md';
}

interface RowVariantProps extends BaseProps {
    variant: 'row';
    /** Visible text. Defaults to "Show relation". */
    text?: string;
}

type OpenDetailsButtonProps = IconVariantProps | RowVariantProps;

export function OpenDetailsButton(props: OpenDetailsButtonProps) {
    if (props.variant === 'icon') {
        const label = props.label ?? 'Show relation';
        const isMd = props.size === 'md';
        // `md` is a fixed 22×22 square that matches the .badge component's
        // rendered height (Inter 11.5/normal + 2px padding + 1px border).
        // Forcing width === height keeps it visually adjacent to CODE/META
        // badges in a table row, instead of stretching into a pill.
        const iconSize = isMd ? 13 : 12;
        const dim = isMd ? 22 : undefined;
        const borderRadius = isMd ? 6 : 4;
        const restBg = isMd ? 'rgba(255,255,255,0.04)' : 'transparent';
        const hoverBg = isMd ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)';
        const restBorder = isMd ? '1px solid var(--border-subtle, rgba(255,255,255,0.08))' : 'none';
        return (
            <SimpleTooltip content={label} side="top">
                <button
                    type="button"
                    aria-label={label}
                    onClick={props.onClick}
                    className={props.className}
                    style={{
                        background: restBg,
                        border: restBorder,
                        color: 'var(--cr-ink-2)',
                        cursor: 'pointer',
                        padding: isMd ? 0 : '2px 4px',
                        width: dim,
                        height: dim,
                        borderRadius,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        boxSizing: 'border-box',
                        transition: 'background 120ms, color 120ms, border-color 120ms',
                        ...props.style,
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = hoverBg;
                        e.currentTarget.style.color = 'var(--cr-ink-0)';
                        if (isMd) e.currentTarget.style.border = '1px solid rgba(255,255,255,0.18)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = restBg;
                        e.currentTarget.style.color = 'var(--cr-ink-2)';
                        e.currentTarget.style.border = restBorder;
                    }}
                >
                    <CornerDownRight size={iconSize} strokeWidth={1.6} />
                </button>
            </SimpleTooltip>
        );
    }

    // Row variant: same markup/classes as the popover action rows so it sits
    // flush with sibling actions (Show details / Use as blast target).
    return (
        <button
            type="button"
            aria-label={props.label ?? 'Show relation'}
            onClick={props.onClick}
            className={`cr-popover__action${props.className ? ` ${props.className}` : ''}`}
            style={props.style}
        >
            {props.text ?? 'Show relation'}
            <CornerDownRight size={12} strokeWidth={1.6} className="cr-popover__action-icon" />
        </button>
    );
}
