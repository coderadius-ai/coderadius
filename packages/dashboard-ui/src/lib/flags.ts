/**
 * Feature Flags — runtime feature detection for CodeRadius Dashboard.
 *
 * Flags are resolved in priority order:
 *   1. `window.__CR_FLAGS__` — injected by the CLI at render time
 *   2. `localStorage.cr_graph_view=1` — developer override
 *   3. Auto-enable on localhost (developer default)
 */

declare global {
    interface Window {
        __CR_FLAGS__?: {
            graphView?: boolean;
            [key: string]: unknown;
        };
    }
}

function isLocalhost(): boolean {
    if (typeof window === 'undefined') return false;
    const { hostname } = window.location;
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.local') ||
        // Vite dev server / file:// protocol
        window.location.protocol === 'file:'
    );
}

/**
 * Whether the Graph View feature is enabled.
 * - CLI can inject `window.__CR_FLAGS__ = { graphView: true }` to enable in production reports.
 * - Dev override: `localStorage.setItem('cr_graph_view', '1')` to force-enable.
 * - Auto-enables on localhost for developer convenience.
 */
export function isGraphViewEnabled(): boolean {
    if (typeof window === 'undefined') return false;

    // Explicit CLI injection (highest priority)
    if (window.__CR_FLAGS__?.graphView === true) return true;
    if (window.__CR_FLAGS__?.graphView === false) return false;

    // Dev localStorage override
    try {
        if (localStorage.getItem('cr_graph_view') === '1') return true;
        if (localStorage.getItem('cr_graph_view') === '0') return false;
    } catch {
        // localStorage may be unavailable in some environments
    }

    // Auto-enable on localhost
    return isLocalhost();
}
