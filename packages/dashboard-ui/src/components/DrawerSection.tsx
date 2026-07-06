import React, { useState, useEffect, useRef } from 'react';

// ─── Base Components ──────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <span style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            opacity: 0.9,
        }}>
            {children}
        </span>
    );
}

export function DrawerSection({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            paddingTop: '20px',
            marginTop: '20px',
            // Single strong separator — the ONLY horizontal line in the drawer
            borderTop: '1px solid rgba(255,255,255,0.09)',
            flexShrink: 0,
        }}>
            <SectionLabel>{label}</SectionLabel>
            {children}
        </div>
    );
}

// ─── Interactive Components ────────────────────────────────────────────────────

export interface SearchableDrawerSectionProps {
    label: string;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    placeholder?: string;
    children: React.ReactNode;
}

export function SearchableDrawerSection({
    label,
    searchQuery,
    onSearchChange,
    placeholder = 'Search...',
    children,
}: SearchableDrawerSectionProps) {
    const [isSearching, setIsSearching] = useState(Boolean(searchQuery));
    const inputRef = useRef<HTMLInputElement>(null);

    // Auto-focus when search is toggled open
    useEffect(() => {
        if (isSearching && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isSearching]);

    // Close search if query is cleared and input loses focus (optional UX, but explicit close is better)
    const handleClose = () => {
        setIsSearching(false);
        onSearchChange('');
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            paddingTop: '20px',
            marginTop: '20px',
            borderTop: '1px solid rgba(255,255,255,0.09)',
            flexShrink: 0,
        }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: '24px', 
                justifyContent: 'space-between',
                width: '100%',
            }}>
                <SectionLabel>{label}</SectionLabel>

                <div 
                    className="drawer-search-wrapper"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        background: isSearching ? 'rgba(255, 255, 255, 0.04)' : 'transparent', 
                        border: '1px solid',
                        borderColor: isSearching ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                        borderRadius: '6px',
                        padding: isSearching ? '0 6px' : '0 2px',
                        width: isSearching ? '50%' : '20px',
                        minWidth: isSearching ? '200px' : '20px',
                        height: '24px',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        overflow: 'hidden',
                        cursor: isSearching ? 'text' : 'pointer',
                        justifyContent: isSearching ? 'flex-start' : 'center',
                    }}
                    onClick={() => {
                        if (!isSearching) setIsSearching(true);
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
                        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
                        <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                    <style dangerouslySetInnerHTML={{ __html: `
                        .drawer-search-wrapper:focus-within {
                            border-color: rgba(255, 255, 255, 0.2) !important;
                        }
                    `}} />
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder={placeholder}
                        value={searchQuery}
                        onChange={e => onSearchChange(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Escape') {
                                e.stopPropagation(); 
                                handleClose();
                            }
                        }}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-primary)',
                            fontSize: '11.5px',
                            fontFamily: "'Inter', sans-serif",
                            width: isSearching ? '100%' : '0px',
                            outline: 'none',
                            padding: isSearching ? '0 8px' : '0',
                            opacity: isSearching ? 1 : 0,
                            pointerEvents: isSearching ? 'auto' : 'none',
                            transition: 'opacity 0.2s ease, width 0.2s ease',
                        }}
                    />
                    {isSearching && (
                        <button 
                            onClick={(e) => {
                                e.stopPropagation();
                                handleClose();
                            }}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--text-tertiary)',
                                cursor: 'pointer',
                                padding: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginRight: '-2px',
                                transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                            aria-label="Close search"
                        >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        </button>
                    )}
                </div>
            </div>

            {children}
        </div>
    );
}
