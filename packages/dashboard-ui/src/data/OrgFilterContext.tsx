import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';

export interface OrgFilterContextValue {
    /** Selected organization fullPaths. Empty = all organizations (no filter). */
    selectedOrgPaths: string[];
    setSelectedOrgPaths: (paths: string[]) => void;
    toggleOrgPath: (path: string) => void;
    clear: () => void;
}

const OrgFilterContext = createContext<OrgFilterContextValue | null>(null);

/**
 * Global organization-segregation filter.
 *
 * Mounted above the view router so the selection survives tab navigation. The
 * source of truth is React state (in-session). URL deep-linking is intentionally
 * deferred — the existing nav-hash scheme (`#nav:<id>?...`) would need to carry
 * the org param too, which is a separate, larger change.
 */
export function OrgFilterProvider({ children }: { children: ReactNode }) {
    const [selectedOrgPaths, setSelectedOrgPaths] = useState<string[]>([]);

    const toggleOrgPath = useCallback((path: string) => {
        setSelectedOrgPaths(prev => (prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]));
    }, []);
    const clear = useCallback(() => setSelectedOrgPaths([]), []);

    const value = useMemo<OrgFilterContextValue>(
        () => ({ selectedOrgPaths, setSelectedOrgPaths, toggleOrgPath, clear }),
        [selectedOrgPaths, toggleOrgPath, clear],
    );

    return <OrgFilterContext.Provider value={value}>{children}</OrgFilterContext.Provider>;
}

export function useOrgFilter(): OrgFilterContextValue {
    const ctx = useContext(OrgFilterContext);
    if (!ctx) throw new Error('useOrgFilter must be used inside <OrgFilterProvider>');
    return ctx;
}
