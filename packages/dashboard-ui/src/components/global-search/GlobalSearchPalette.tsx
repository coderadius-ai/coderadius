/**
 * GlobalSearchPalette
 *
 * The global Cmd+K command palette modal. Reads all state from
 * GlobalSearchContext — zero props required.
 *
 * When `topology` is available (Blast Explorer mounted):
 *   → renders the full SearchBar with fuzzy node search
 * When `topology` is null (other tabs or BlastShell without topology):
 *   → renders a placeholder state (ready for API search tomorrow)
 *
 * The modal is always mounted at the App root so it's never unmounted
 * when navigating between tabs.
 */

import { useGlobalSearch } from './GlobalSearchContext';
import { SearchBar } from '../blast-radius/search/SearchBar';

export function GlobalSearchPalette() {
    const { isOpen, close, topology, handleSelect } = useGlobalSearch();

    if (!isOpen) return null;

    return (
        <div className="global-search-modal" role="dialog" aria-modal="true" aria-label="Global search">
            {/* Backdrop */}
            <div
                className="global-search-modal__backdrop"
                onClick={close}
                aria-hidden="true"
            />

            {/* Content */}
            <div className="global-search-modal__content">
                {topology ? (
                    <SearchBar
                        topology={topology}
                        selectedUrn={null}
                        onSelect={(urn) => {
                            if (urn) handleSelect(urn);
                        }}
                        placeholder="Jump to anything…"
                        autoFocus={true}
                    />
                ) : (
                    <div className="global-search-modal__empty">
                        <svg
                            width="20"
                            height="20"
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
                        <span>No topology loaded — navigate to the Blast Radius Explorer tab first.</span>
                    </div>
                )}
            </div>
        </div>
    );
}
