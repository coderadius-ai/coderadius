import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';

/**
 * Anchor rect of the clicked cell in viewport coordinates. The popover opens
 * BESIDE the cell with a small arrow pointing back to the cell's vertical
 * center, same chrome as NodePopover (blast radius), generalised for
 * arbitrary list-of-strings content (rules, skills, workflows, agents).
 */
export interface ListPopoverAnchor {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ListPopoverItem {
    text: string;
    subtitle?: string;
    url?: string;
}

interface ListPopoverProps {
    open: boolean;
    anchor: ListPopoverAnchor | null;
    title: string;
    items: ListPopoverItem[];
    onClose: () => void;
}

const POPOVER_WIDTH = 320;
const POPOVER_MAX_HEIGHT = 360;

// Layout constants kept in sync with the inline styles below so we can
// compute the popover's height deterministically (no measure-then-reposition
// flicker). If the styles change, update these.
const HEADER_HEIGHT = 46;        // padding(12+10) + header text line(~24)
const DIVIDER_HEIGHT = 1;
const LIST_PADDING_Y = 8;        // top+bottom padding inside the scroll area
const ROW_HEIGHT_BASE = 32;      // 7px*2 padding + ~18px line
const ROW_HEIGHT_WITH_SUB = 46;  // adds subtitle line

export function ListPopover({ open, anchor, title, items, onClose }: ListPopoverProps) {
    const popRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        const onDown = (e: MouseEvent) => {
            const el = popRef.current;
            if (el && e.target instanceof Node && !el.contains(e.target)) onClose();
        };
        const onScroll = (e: Event) => {
            const el = popRef.current;
            if (el && e.target instanceof Node && el.contains(e.target)) return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open, onClose]);

    if (!open || !anchor) return null;

    // Predict the rendered height from the actual content, so vertical
    // centering on the anchor is correct on first paint. Without this the
    // popover floated way above the anchor for short lists (height was a
    // fixed-360 estimate but actual content was ~120px).
    const rowsHeight = items.length === 0
        ? ROW_HEIGHT_BASE  // empty-state "None" row
        : items.reduce((sum, it) => sum + (it.subtitle ? ROW_HEIGHT_WITH_SUB : ROW_HEIGHT_BASE), 0);
    const popoverHeight = Math.min(
        POPOVER_MAX_HEIGHT,
        HEADER_HEIGHT + DIVIDER_HEIGHT + LIST_PADDING_Y + rowsHeight,
    );

    const ANCHOR_GAP = 12;
    const VIEWPORT_PAD = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardCenterY = anchor.y + anchor.height / 2;
    const cardRight = anchor.x + anchor.width;
    const spaceRight = vw - cardRight - ANCHOR_GAP - VIEWPORT_PAD;
    const spaceLeft = anchor.x - ANCHOR_GAP - VIEWPORT_PAD;
    const placeRight = spaceRight >= POPOVER_WIDTH || spaceRight >= spaceLeft;
    const popoverLeft = placeRight ? cardRight + ANCHOR_GAP : anchor.x - POPOVER_WIDTH - ANCHOR_GAP;
    const idealTop = cardCenterY - popoverHeight / 2;
    const popoverTop = Math.max(VIEWPORT_PAD, Math.min(vh - popoverHeight - VIEWPORT_PAD, idealTop));
    const arrowYInPopover = Math.max(16, Math.min(popoverHeight - 16, cardCenterY - popoverTop));

    return createPortal(
        <div
            ref={popRef}
            role="dialog"
            aria-label={title}
            data-side={placeRight ? 'right' : 'left'}
            style={{
                position: 'fixed',
                left: popoverLeft,
                top: popoverTop,
                width: POPOVER_WIDTH,
                maxHeight: POPOVER_MAX_HEIGHT,
                zIndex: 9990,
                background: 'var(--cr-bg-1)',
                border: '1px solid var(--cr-line-1)',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                fontFamily: 'var(--font-sans)',
                color: 'var(--cr-ink-0)',
                animation: 'cr-listpop-in 180ms cubic-bezier(0.16,1,0.3,1) both',
                pointerEvents: 'auto',
                isolation: 'isolate',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            <style>{`
                @keyframes cr-listpop-in {
                    from { opacity: 0; transform: translateX(${placeRight ? '-6px' : '6px'}); }
                    to   { opacity: 1; transform: translateX(0); }
                }
                .cr-listpop-divider { height: 1px; background: var(--cr-line-0); }
                .cr-listpop-row { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font-size: var(--cr-type-caption); color: var(--cr-ink-1); transition: background 120ms; }
                .cr-listpop-row:hover { background: var(--cr-bg-3); color: var(--cr-ink-0); }
                .cr-listpop-row a { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
                .cr-listpop-row__sub { color: var(--cr-ink-2); font-size: var(--cr-type-micro); }
            `}</style>

            {placeRight ? (
                <svg width="11" height="16" aria-hidden="true" shapeRendering="geometricPrecision"
                    style={{ position: 'absolute', left: -9, top: arrowYInPopover - 8, pointerEvents: 'none' }}>
                    <path d="M11 1 L1 8 L11 15" fill="var(--cr-bg-1)" stroke="var(--cr-line-1)" strokeWidth="1" strokeLinejoin="round" />
                </svg>
            ) : (
                <svg width="11" height="16" aria-hidden="true" shapeRendering="geometricPrecision"
                    style={{ position: 'absolute', right: -9, top: arrowYInPopover - 8, pointerEvents: 'none' }}>
                    <path d="M0 1 L10 8 L0 15" fill="var(--cr-bg-1)" stroke="var(--cr-line-1)" strokeWidth="1" strokeLinejoin="round" />
                </svg>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 10px' }}>
                <span style={{ fontSize: 'var(--cr-type-caption)', fontWeight: 600, color: 'var(--cr-ink-0)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {title}
                </span>
                <span style={{ fontSize: 'var(--cr-type-micro)', color: 'var(--cr-ink-2)', fontFamily: 'var(--font-mono)' }}>
                    {items.length}
                </span>
                <button
                    onClick={onClose}
                    aria-label="Close"
                    style={{ background: 'transparent', border: 'none', color: 'var(--cr-ink-2)', cursor: 'pointer', padding: 2, fontSize: 16, lineHeight: 1 }}
                >
                    ×
                </button>
            </div>

            <div className="cr-listpop-divider" />

            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {items.length === 0 ? (
                    <div style={{ padding: '12px 14px', fontSize: 'var(--cr-type-caption)', color: 'var(--cr-ink-2)' }}>None</div>
                ) : (
                    items.map((it, i) => (
                        <div key={i} className="cr-listpop-row">
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {it.url ? (
                                    <a href={it.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.text}</span>
                                        <ExternalLink size={10} style={{ opacity: 0.5, flexShrink: 0 }} />
                                    </a>
                                ) : (
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.text}</span>
                                )}
                                {it.subtitle && (
                                    <span className="cr-listpop-row__sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {it.subtitle}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>,
        document.body,
    );
}
