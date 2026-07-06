/**
 * DrawerShell — Reusable side-panel primitive.
 *
 * Encapsulates portal rendering, backdrop, slide-in animation,
 * close button, Escape key handler (via shared LIFO overlay stack),
 * and an optional sticky footer.
 *
 * All three domain-specific drawers (Impact, Registry, Governance)
 * delegate their chrome to this component, keeping only their
 * content rendering logic.
 *
 * Design: Vercel/Linear aesthetic — dark, minimal, precise.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { pushOverlay } from '../lib/overlay-stack';
import { useFocusTrap } from '../lib/use-focus-trap';

const EXIT_MS = 200;

export interface DrawerShellProps {
    /** Accessible label for the dialog */
    ariaLabel: string;
    /** Close callback — fired on backdrop click, close button, and Escape key */
    onClose: () => void;
    /** CSS width value (default: '50%') */
    width?: string;
    /** CSS max-width value (default: '1000px') */
    maxWidth?: string;
    /** Main scrollable content */
    children: React.ReactNode;
    /** Optional sticky footer slot (e.g. "Use as blast target" button) */
    footer?: React.ReactNode;
}

export function DrawerShell({
    ariaLabel,
    onClose,
    width = '50%',
    maxWidth = '1000px',
    children,
    footer,
}: DrawerShellProps) {
    const [closing, setClosing] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    const handleClose = useCallback(() => {
        if (closing) return;
        setClosing(true);
        timerRef.current = setTimeout(onClose, EXIT_MS);
    }, [onClose, closing]);

    useEffect(() => () => { clearTimeout(timerRef.current); }, []);
    useEffect(() => pushOverlay(handleClose), [handleClose]);

    const panelRef = useRef<HTMLElement>(null);
    useFocusTrap(panelRef);

    return createPortal(
        <>
            <div
                className={`cr-drawer-backdrop${closing ? ' cr-drawer-backdrop--closing' : ''}`}
                onClick={handleClose}
            />

            <aside
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                className={`cr-drawer-shell${closing ? ' cr-drawer-shell--closing' : ''}`}
                style={{ width, maxWidth }}
            >
                <button className="cr-drawer-shell__close" onClick={handleClose} aria-label="Close panel">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>

                <div className="cr-drawer-shell__body">
                    {children}
                    {footer && (
                        <div className="cr-drawer-shell__footer">
                            {footer}
                        </div>
                    )}
                </div>
            </aside>
        </>,
        document.body,
    );
}
