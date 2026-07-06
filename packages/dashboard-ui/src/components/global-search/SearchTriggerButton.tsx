/**
 * SearchTriggerButton
 *
 * Atomic header button that opens the global Cmd+K palette.
 * Reads `toggle` from GlobalSearchContext — zero props required.
 *
 * Always visible in the header regardless of which tab is active.
 * Uses the same `.cr-header-search-btn` styling as before.
 */

import { useGlobalSearch } from './GlobalSearchContext';

export function SearchTriggerButton() {
    const { toggle } = useGlobalSearch();

    return (
        <button
            className="cr-header-search-btn"
            onClick={toggle}
            aria-label="Open global search (⌘K)"
            title="Search (⌘K)"
            id="global-search-trigger"
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
            </svg>
            Jump to anything… <kbd className="cr-header-search-kbd">⌘K</kbd>
        </button>
    );
}
