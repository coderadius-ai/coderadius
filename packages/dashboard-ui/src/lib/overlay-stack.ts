/**
 * LIFO overlay stack for Escape-closeable surfaces (DrawerShell, ModalShell,
 * future popovers).
 *
 * Why: every shell used to register its own `document.keydown` listener.
 * With two overlays open at once, Escape fired BOTH `onClose` callbacks in
 * parallel (DOM listeners fire in registration order, not LIFO), so the
 * user lost both at once instead of closing the topmost first.
 *
 * How: a single module-level stack of close callbacks. Each overlay calls
 * `pushOverlay(onClose)` on mount and the returned unregister fn on unmount.
 * A single capture-phase `document.keydown` listener (registered lazily on
 * first push) pops the topmost callback on Escape, calling its `onClose`,
 * and stops propagation so any non-stack `document.keydown` handlers
 * (legacy popovers, search modals) don't also fire.
 *
 * Note on fullscreen: this works because the dashboard's "fullscreen" mode
 * is now CSS pseudo-fullscreen (a class on the canvas wrap), NOT the native
 * Fullscreen API. Native fullscreen would intercept Escape at the browser
 * level and never deliver it to the page (see prior root-cause analysis).
 */

type CloseFn = () => void;

const stack: CloseFn[] = [];
let listenerAttached = false;

function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (stack.length === 0) return;
    const close = stack[stack.length - 1];
    close();
    // Prevent other document-level Escape handlers (popovers, etc.) from
    // also firing on the same keypress. Don't preventDefault — Escape's
    // browser default is "exit fullscreen", which we no longer use.
    e.stopImmediatePropagation();
    e.stopPropagation();
}

function ensureListener(): void {
    if (listenerAttached) return;
    if (typeof document === 'undefined') return;
    // Capture phase so we run before any other document-level escape listener.
    document.addEventListener('keydown', handleKeyDown, true);
    listenerAttached = true;
}

/**
 * Push an overlay's close callback onto the LIFO stack. Returns an
 * unregister function — call it from the cleanup of the effect that
 * mounted the overlay.
 *
 * The callback may be invoked at most once per Escape press (capture-
 * phase listener stops propagation). The overlay's own React unmount
 * removes the entry; the close callback should also be safe to call
 * after unmount has begun (React batches state updates).
 */
export function pushOverlay(onClose: CloseFn): () => void {
    ensureListener();
    stack.push(onClose);
    return () => {
        // Find by reference. lastIndexOf so re-renders that briefly leave
        // both old and new callbacks on the stack remove the right one.
        const idx = stack.lastIndexOf(onClose);
        if (idx !== -1) stack.splice(idx, 1);
    };
}

/** Test / debug helper. Not for production use. */
export function _overlayStackDepth(): number {
    return stack.length;
}
