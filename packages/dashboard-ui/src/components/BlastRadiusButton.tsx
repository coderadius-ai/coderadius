import type { CSSProperties, MouseEvent } from 'react';
import { SimpleTooltip } from './Tooltip';
import { BlastTargetIcon } from './icons/BlastTargetIcon';

/**
 * Shared "Open in Blast Radius" affordance. Counterpart of
 * `OpenDetailsButton` for the side-panel: this one navigates the user to
 * the Blast Radius Explorer page focused on a specific URN.
 *
 * Two variants:
 *   - `icon`: square icon button. `sm` for popover member rows / sidebar
 *     lists. `md` for data tables (matches `.badge` height).
 *   - `row`: full-width text + icon. Used in popover action footers.
 *
 * The component is action-agnostic: pass either `urn` (component handles
 * hash navigation) or `onClick` (caller fully owns the action). Mutually
 * exclusive at the type level so we don't end up with both wired.
 */

type Action =
    | { urn: string; onClick?: never }
    | { urn?: never; onClick: (e: MouseEvent<HTMLButtonElement>) => void };

interface BaseProps {
    label?: string;
    className?: string;
    style?: CSSProperties;
}

interface IconVariantProps extends BaseProps {
    variant: 'icon';
    size?: 'sm' | 'md';
}

interface RowVariantProps extends BaseProps {
    variant: 'row';
    text?: string;
}

type BlastRadiusButtonProps = (IconVariantProps | RowVariantProps) & Action;

function navigateToBlastRadius(urn: string) {
    window.location.hash = `blast:${urn}`;
}

export function BlastRadiusButton(props: BlastRadiusButtonProps) {
    const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if ('onClick' in props && props.onClick) {
            props.onClick(e);
        } else if ('urn' in props && props.urn) {
            navigateToBlastRadius(props.urn);
        }
    };

    if (props.variant === 'icon') {
        const label = props.label ?? 'Open in Blast Radius';
        const isMd = props.size === 'md';
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
                    onClick={handleClick}
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
                    <BlastTargetIcon size={iconSize} />
                </button>
            </SimpleTooltip>
        );
    }

    return (
        <button
            type="button"
            aria-label={props.label ?? 'Open in Blast Radius'}
            onClick={handleClick}
            className={props.className}
            style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '8px 14px',
                gap: 10,
                background: 'transparent',
                border: 'none',
                color: 'var(--cr-ink-1)',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 120ms, color 120ms',
                ...props.style,
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--cr-bg-3)';
                e.currentTarget.style.color = 'var(--cr-ink-0)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--cr-ink-1)';
            }}
        >
            <span style={{ flex: 1 }}>{props.text ?? 'Open in Blast Radius'}</span>
            <BlastTargetIcon size={12} style={{ opacity: 0.7, flexShrink: 0 }} />
        </button>
    );
}
