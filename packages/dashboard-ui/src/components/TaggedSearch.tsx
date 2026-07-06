import { useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchScope {
    key: string;
    label: string;
    color: string;
    icon?: React.ReactNode;
}

export interface TaggedSearchState {
    query: string;
    activeScope: SearchScope | null;
    scopeValue: string | null;
}

export interface TaggedSearchProps {
    scopes: SearchScope[];
    placeholder?: string;
    inputId?: string;
    onSearch?: (state: TaggedSearchState) => void;
    onInputKeyDown?: (e: React.KeyboardEvent) => void;
    renderResults?: (state: TaggedSearchState & { close: () => void }) => React.ReactNode;
    renderFooter?: () => React.ReactNode;
    selectedBadge?: React.ReactNode;
    onClear?: () => void;
    showClear?: boolean;
    autoFocus?: boolean;
}

export interface TaggedSearchHandle {
    reset: () => void;
    clearScope: () => void;
    setQuery: (text: string) => void;
    setScopeValue: (text: string) => void;
    focus: () => void;
}

// ─── Predicates (exported for testing) ────────────────────────────────────────

export interface ShowDropdownInput {
    open: boolean;
    queryLength: number;
    activeScope: SearchScope | null;
    scopeValue: string | null;
    scopeSuggestionsCount: number;
}

export function shouldShowDropdown(s: ShowDropdownInput): boolean {
    if (!s.open) return false;
    const hasScopeHints = s.scopeSuggestionsCount > 0 && !s.activeScope && s.queryLength > 0;
    return s.queryLength > 0 || hasScopeHints || (s.activeScope !== null && s.scopeValue === null);
}

// ─── Component ────────────────────────────────────────────────────────────────

export const TaggedSearch = forwardRef<TaggedSearchHandle, TaggedSearchProps>(function TaggedSearch({
    scopes,
    placeholder = 'Search…',
    inputId = 'tagged-search-input',
    onSearch,
    onInputKeyDown,
    renderResults,
    renderFooter,
    selectedBadge,
    onClear,
    showClear = false,
    autoFocus = false,
}, ref) {
    const [query, setQuery] = useState('');
    const [activeScope, setActiveScope] = useState<SearchScope | null>(null);
    const [scopeValue, setScopeValue] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const dropdownId = `${inputId}-dropdown`;

    useImperativeHandle(ref, () => ({
        reset() {
            setQuery('');
            setOpen(false);
        },
        clearScope() {
            setActiveScope(null);
            setScopeValue(null);
        },
        setQuery(text: string) {
            setQuery(text);
            setOpen(false);
        },
        setScopeValue(text: string) {
            setScopeValue(text);
            setQuery('');
            setOpen(false);
            inputRef.current?.focus();
        },
        focus() {
            inputRef.current?.focus();
        },
    }), []);

    const pendingPrefix = useMemo(() => {
        if (activeScope || !query) return null;
        const colonIdx = query.indexOf(':');
        if (colonIdx > 0) {
            const prefix = query.slice(0, colonIdx).toLowerCase();
            const match = scopes.find(s => s.key.toLowerCase() === prefix || s.label.toLowerCase() === prefix);
            return match ? { scope: match, remainder: query.slice(colonIdx + 1).trimStart() } : null;
        }
        return null;
    }, [query, activeScope, scopes]);

    const scopeSuggestions = useMemo(() => {
        if (activeScope || !query || query.includes(':')) return [];
        const q = query.toLowerCase();
        return scopes.filter(s =>
            s.key.toLowerCase().startsWith(q) || s.label.toLowerCase().startsWith(q)
        );
    }, [query, activeScope, scopes]);

    useEffect(() => {
        if (pendingPrefix) {
            setActiveScope(pendingPrefix.scope);
            setQuery(pendingPrefix.remainder);
        }
    }, [pendingPrefix]);

    const state: TaggedSearchState = useMemo(() => ({
        query,
        activeScope,
        scopeValue,
    }), [query, activeScope, scopeValue]);

    useEffect(() => {
        onSearch?.(state);
    }, [state, onSearch]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && query === '') {
            if (scopeValue) {
                setScopeValue(null);
                setOpen(true);
            } else if (activeScope) {
                setActiveScope(null);
            } else if (selectedBadge) {
                onClear?.();
            }
        }
        if (e.key === 'Escape') {
            setOpen(false);
        }
        if (e.key === 'Tab' && scopeSuggestions.length === 1 && !activeScope) {
            e.preventDefault();
            setActiveScope(scopeSuggestions[0]);
            setQuery('');
        }
        onInputKeyDown?.(e);
    }, [query, activeScope, scopeValue, selectedBadge, onClear, scopeSuggestions, onInputKeyDown]);

    const handleClear = useCallback(() => {
        setQuery('');
        setActiveScope(null);
        setScopeValue(null);
        onClear?.();
        inputRef.current?.focus();
    }, [onClear]);

    const handleScopeSelect = useCallback((scope: SearchScope) => {
        setActiveScope(scope);
        setQuery('');
        setOpen(true);
        inputRef.current?.focus();
    }, []);

    const handleClose = useCallback(() => {
        setOpen(false);
    }, []);

    const isCompound = activeScope !== null && scopeValue !== null;
    const hasContent = query.length > 0 || activeScope !== null || showClear;
    const showDropdown = shouldShowDropdown({
        open,
        queryLength: query.length,
        activeScope,
        scopeValue,
        scopeSuggestionsCount: scopeSuggestions.length,
    });
    const hasScopeHints = scopeSuggestions.length > 0 && !activeScope && query.length > 0;

    const computedPlaceholder = useMemo(() => {
        if (activeScope) return '';
        if (selectedBadge && !showDropdown && query === '') return '';
        if (selectedBadge) return '';
        return placeholder;
    }, [selectedBadge, showDropdown, query, activeScope, placeholder]);

    return (
        <div className="tagged-search" ref={containerRef}>
            <div className="tagged-search__input-wrap">
                <span className="tagged-search__icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
                        <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                </span>

                {isCompound ? (
                    <span
                        className="tagged-search__compound-tag"
                        style={{ '--scope-color': activeScope.color } as React.CSSProperties}
                    >
                        {activeScope.icon && <span className="tagged-search__compound-icon">{activeScope.icon}</span>}
                        <span className="tagged-search__compound-scope">{activeScope.key}</span>
                        <span className="tagged-search__compound-sep">:</span>
                        <span className="tagged-search__compound-value">{scopeValue}</span>
                        <button
                            className="tagged-search__compound-remove"
                            onClick={(e) => { e.stopPropagation(); setActiveScope(null); setScopeValue(null); inputRef.current?.focus(); }}
                            aria-label={`Remove ${activeScope.key}:${scopeValue} filter`}
                        >
                            <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                        </button>
                    </span>
                ) : activeScope ? (
                    <span
                        className="tagged-search__compound-tag"
                        style={{ '--scope-color': activeScope.color } as React.CSSProperties}
                    >
                        {activeScope.icon && <span className="tagged-search__compound-icon">{activeScope.icon}</span>}
                        <span className="tagged-search__compound-scope">{activeScope.key}</span>
                        <span className="tagged-search__compound-sep">:</span>
                    </span>
                ) : null}

                {selectedBadge && query === '' && !showDropdown && selectedBadge}

                <input
                    ref={inputRef}
                    id={inputId}
                    className="tagged-search__input"
                    type="text"
                    placeholder={computedPlaceholder}
                    value={query}
                    autoComplete="off"
                    autoFocus={autoFocus}
                    onFocus={() => setOpen(true)}
                    onChange={e => { setQuery(e.target.value); setOpen(true); }}
                    onKeyDown={handleKeyDown}
                    aria-label="Search"
                    aria-autocomplete="list"
                    aria-expanded={showDropdown}
                    aria-controls={showDropdown ? dropdownId : undefined}
                />

                <button
                    className={`tagged-search__clear${hasContent ? '' : ' tagged-search__clear--hidden'}`}
                    onClick={handleClear}
                    aria-label="Clear"
                    tabIndex={hasContent ? 0 : -1}
                >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                </button>
            </div>

            {showDropdown && (
                <div className="tagged-search__dropdown" id={dropdownId} role="listbox">
                    {scopeSuggestions.length > 0 && !activeScope && query.length > 0 && (
                        <div className="tagged-search__scope-hints">
                            <div className="tagged-search__scope-hints-label">Filter by type</div>
                            {scopeSuggestions.map(scope => (
                                <div
                                    key={scope.key}
                                    className="tagged-search__scope-hint"
                                    role="option"
                                    aria-selected={false}
                                    tabIndex={-1}
                                    onMouseDown={() => handleScopeSelect(scope)}
                                    style={{ '--scope-color': scope.color } as React.CSSProperties}
                                >
                                    {scope.icon && <span className="tagged-search__scope-hint-icon">{scope.icon}</span>}
                                    <span className="tagged-search__scope-hint-label">{scope.label}</span>
                                    <span className="tagged-search__scope-hint-key">{scope.key}:</span>
                                    <kbd className="tagged-search__scope-hint-kbd">Tab</kbd>
                                </div>
                            ))}
                        </div>
                    )}

                    {renderResults?.({ ...state, close: handleClose })}
                    {renderFooter?.()}
                </div>
            )}
        </div>
    );
});
