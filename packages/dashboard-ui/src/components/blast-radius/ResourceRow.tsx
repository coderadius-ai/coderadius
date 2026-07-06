import type { ReactNode } from 'react';
import { NodeIcon, RelBadge, NODE_TYPE_COLORS } from '../Taxonomy';
import { SimpleTooltip } from '../Tooltip';
import { OpenDetailsButton } from '../OpenDetailsButton';

interface ResourceRowProps {
    /** Node type — drives the leading icon (color + glyph). */
    type: string;
    /** Display name. Pre-rendered so the caller can apply fuzzy highlights. */
    name: ReactNode;
    /** Rel-kind set — rendered as compact letter chips on the right. */
    rels?: string[];
    /** Optional extra badge slotted before the rel chips (e.g. tier marker). */
    trailing?: ReactNode;
    /** Whole-row click (main action; primary nav). */
    onClick?: () => void;
    /** Hover-revealed chevron — drawer / details. */
    onOpenDetails?: () => void;
    /** Hover-revealed target — set as new blast pivot. */
    onUseAsTarget?: () => void;
    /** Hover binding to a sibling graph node (mouseenter/leave forwarded). */
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}

/**
 * Shared row used by the sidebar resource list (in graph view) and by the
 * cluster popover member list. Layout:
 *
 *     [type-icon]  name ............... [hover: chev][hover: target] [trailing] [rels]
 *
 * Hover-revealed action icons are opt-in via callbacks. Trailing slot fits
 * an extra badge (e.g. the sidebar's T2 tier marker). Rel chips render as
 * `<RelBadge variant="letter">` — same chip the user sees in the graph
 * card meta strips, so the symbol reads 1:1 across surfaces.
 */
export function ResourceRow({
    type, name, rels = [], trailing,
    onClick, onOpenDetails, onUseAsTarget,
    onMouseEnter, onMouseLeave,
}: ResourceRowProps) {
    const iconColor = NODE_TYPE_COLORS[type] || NODE_TYPE_COLORS.default;
    return (
        <div
            className="cr-resource-row"
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <span
                className="cr-resource-row__icon"
                style={{ color: iconColor }}
            >
                <NodeIcon type={type} size={13} />
            </span>
            <span className="cr-resource-row__name">{name}</span>
            {(onOpenDetails || onUseAsTarget) && (
                <div className="cr-resource-row__actions">
                    {onOpenDetails && (
                        <OpenDetailsButton
                            variant="icon"
                            onClick={(e) => { e.stopPropagation(); onOpenDetails(); }}
                        />
                    )}
                    {onUseAsTarget && (
                        <SimpleTooltip content="Use as blast target" side="top">
                            <button
                                aria-label="Use as blast target"
                                onClick={(e) => { e.stopPropagation(); onUseAsTarget(); }}
                            >
                                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                                    <circle cx="7" cy="7" r="5.5" />
                                    <circle cx="7" cy="7" r="2.5" />
                                    <circle cx="7" cy="7" r="0.6" fill="currentColor" />
                                </svg>
                            </button>
                        </SimpleTooltip>
                    )}
                </div>
            )}
            {trailing}
            {rels.length > 0 && (
                <span className="cr-resource-row__rels">
                    {rels.map(r => <RelBadge key={r} rel={r} variant="letter" />)}
                </span>
            )}
        </div>
    );
}
