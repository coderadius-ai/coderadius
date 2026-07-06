import type { AlertsSection } from '@coderadius/types';
import { useState } from 'react';

export function Alerts({ section }: { section: AlertsSection }) {
    const defaultCategory = 'All';
    const rawCategories = section.alerts.map(a => a.category).filter((c): c is string => typeof c === 'string');
    const categories = [defaultCategory, ...Array.from(new Set(rawCategories))];
    const [activeTab, setActiveTab] = useState(defaultCategory);

    const filteredAlerts = section.alerts.filter(a => activeTab === defaultCategory || a.category === activeTab);

    const renderIcon = (category?: string) => {
        if (category === 'Tech Blindspot') {
            return (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
            );
        }
        if (category === 'Consolidation') {
            return (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1v12zM4 22v-7"/>
                </svg>
            );
        }
        if (category === 'Recommendations') {
            return (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                </svg>
            );
        }
        if (category === 'Semantic Overlap') {
            return (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                </svg>
            );
        }

        return (
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
        );
    };

    return (
        <section className="stagger-4">
            {section.title && <h2>{section.title}</h2>}

            {categories.length > 1 && (
                <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', paddingBottom: '4px', overflowX: 'auto', msOverflowStyle: 'none', scrollbarWidth: 'none' }} className="hide-scrollbar">
                    {categories.map((c: string) => (
                        <button
                            key={c}
                            onClick={() => setActiveTab(c)}
                            style={{
                                padding: '6px 14px',
                                borderRadius: '9999px',
                                fontSize: '13px',
                                fontWeight: 500,
                                whiteSpace: 'nowrap',
                                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                background: activeTab === c ? 'var(--cr-signal)' : 'var(--bg-card)',
                                color: activeTab === c ? 'var(--cr-ink-0)' : 'var(--text-secondary)',
                                border: `1px solid ${activeTab === c ? 'transparent' : 'var(--border-color)'}`,
                                cursor: 'pointer',
                                boxShadow: activeTab === c ? '0 0 12px color-mix(in srgb, var(--cr-signal) 40%, transparent)' : 'none'
                            }}
                        >
                            {c} {c !== 'All' ? `(${section.alerts.filter(a => a.category === c).length})` : `(${section.alerts.length})`}
                        </button>
                    ))}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 600px), 1fr))', gap: '16px' }}>
                {filteredAlerts.map((a, i) => (
                    <div key={i} className={`alert ${a.type} spotlight-card`} style={{ margin: 0, height: '100%' }}>
                        {renderIcon(a.category)}
                        <div className="alert-content">
                            <div className="alert-title">{a.title}</div>
                            <div className="alert-body">{a.message}</div>
                            {a.items && a.items.length > 0 && (
                                <div className="alert-items" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '14px', paddingLeft: 0, listStyle: 'none' }}>
                                    {a.items.map((item, j) => {
                                        if (typeof item === 'string') {
                                            return <span key={j} style={{ padding: '3px 8px', background: 'var(--bg-main)', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '12px', color: 'var(--text-secondary)', fontFamily: '`JetBrains Mono`, monospace' }}>{item}</span>;
                                        }
                                        return (
                                            <a key={j} 
                                               href={item.url || '#'} 
                                               target={item.external ? "_blank" : "_self"} 
                                               rel={item.external ? "noopener noreferrer" : ""}
                                               style={{ padding: '3px 8px', background: 'var(--bg-main)', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '12px', color: item.url ? 'var(--text-primary)' : 'var(--text-secondary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: '`JetBrains Mono`, monospace', transition: 'all 0.2s' }}
                                               onMouseEnter={(e) => {
                                                   if (item.url) e.currentTarget.style.borderColor = 'var(--color-cyan)';
                                               }}
                                               onMouseLeave={(e) => {
                                                   if (item.url) e.currentTarget.style.borderColor = 'var(--border-color)';
                                               }}
                                            >
                                                {item.text}
                                                {item.external && item.url && (
                                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                                                )}
                                            </a>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            
            {filteredAlerts.length === 0 && (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)', background: 'var(--bg-card)', borderRadius: '12px', border: '1px dashed var(--border-color)', marginTop: '20px' }}>
                    No alerts in this category.
                </div>
            )}
        </section>
    );
}
