/**
 * ModalShell - Reusable centered modal primitive.
 *
 * Sibling of DrawerShell. Use for focused "tell me about this" surfaces
 * (NodeInspector) where the user wants full attention on the content.
 *
 * Centered, fixed max-width, dark backdrop, escape-to-dismiss (via the
 * shared LIFO overlay stack), no glow. Single soft shadow, subtle border.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pushOverlay } from '../lib/overlay-stack';
import { useFocusTrap } from '../lib/use-focus-trap';

export interface ModalShellProps {
    ariaLabel: string;
    onClose: () => void;
    width?: string;
    maxWidth?: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

export function ModalShell({
    ariaLabel,
    onClose,
    width = '720px',
    maxWidth = '92vw',
    children,
    footer,
}: ModalShellProps) {
    useEffect(() => pushOverlay(onClose), [onClose]);

    const panelRef = useRef<HTMLDivElement>(null);
    useFocusTrap(panelRef);

    return createPortal(
        <>
            <div className="cr-modal-backdrop" onClick={onClose} aria-hidden="true" />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                className="cr-modal-shell"
                style={{ width, maxWidth }}
            >
                <button
                    className="cr-modal-shell__close"
                    onClick={onClose}
                    aria-label="Close panel"
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>
                <div className="cr-modal-shell__body">{children}</div>
                {footer && <div className="cr-modal-shell__footer">{footer}</div>}
            </div>
        </>,
        document.body,
    );
}
