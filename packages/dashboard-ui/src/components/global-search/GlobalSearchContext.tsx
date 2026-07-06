/**
 * GlobalSearchContext
 *
 * Single source of truth for the global Cmd+K palette:
 *   - open/close state (Cmd+K / Escape listener lives here, registered once)
 *   - topology: set by AppInner from the payload, available on all tabs
 *   - onSelect: registered by AppInner to navigate to the blast tab on pick
 *
 * Zero prop drilling. Mount `<GlobalSearchProvider>` once at the App root.
 * Consumers call `useGlobalSearch()` to read/write state.
 */

import { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect, type ReactNode } from 'react';
import type { TopologyMap } from '@coderadius/shared-types';

// ─── Types ────────────────────────────────────────────────────────────────────

type SelectHandler = (urn: string) => void;

export interface GlobalSearchContextValue {
    isOpen: boolean;
    close: () => void;
    toggle: () => void;
    topology: TopologyMap | null;
    setTopology: (t: TopologyMap | null) => void;
    /** Register a handler called when the user picks a URN. Returns a cleanup fn. */
    registerSelectHandler: (fn: SelectHandler) => () => void;
    /** Called by GlobalSearchPalette when the user selects a result. */
    handleSelect: (urn: string) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const GlobalSearchContext = createContext<GlobalSearchContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [topology, setTopology] = useState<TopologyMap | null>(null);
    const selectHandlerRef = useRef<SelectHandler | null>(null);

    const close  = useCallback(() => setIsOpen(false), []);
    const toggle = useCallback(() => setIsOpen(prev => !prev), []);

    // ── Single global Cmd+K / Escape listener ─────────────────────────────────
    // Inlined here (not a separate file) — used in exactly one place.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                toggle();
            } else if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                close();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [isOpen, toggle, close]);

    const registerSelectHandler = useCallback((fn: SelectHandler) => {
        selectHandlerRef.current = fn;
        return () => { selectHandlerRef.current = null; };
    }, []);

    const handleSelect = useCallback((urn: string) => {
        setIsOpen(false);
        selectHandlerRef.current?.(urn);
    }, []);

    const value = useMemo<GlobalSearchContextValue>(() => ({
        isOpen,
        close,
        toggle,
        topology,
        setTopology,
        registerSelectHandler,
        handleSelect,
    }), [isOpen, close, toggle, topology, setTopology, registerSelectHandler, handleSelect]);

    return (
        <GlobalSearchContext.Provider value={value}>
            {children}
        </GlobalSearchContext.Provider>
    );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGlobalSearch(): GlobalSearchContextValue {
    const ctx = useContext(GlobalSearchContext);
    if (!ctx) throw new Error('useGlobalSearch must be used inside <GlobalSearchProvider>');
    return ctx;
}
