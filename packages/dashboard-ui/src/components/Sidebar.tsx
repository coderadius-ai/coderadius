import type { NavigationConfig } from '@coderadius/types';
import * as LucideIcons from 'lucide-react';
import { SimpleTooltip } from './Tooltip';
import { type CSSProperties, useState } from 'react';
import { DiscoverySourceChip, InfraTechChip, NodeIcon } from './Taxonomy';

interface SidebarProps {
    navigation: NavigationConfig;
    activeNavId: string;
    onNavChange: (id: string) => void;
    isCollapsed?: boolean;
    onToggleCollapse?: () => void;
    cliVersion?: string;
    generatedAt?: string | number;
    reposCount?: number;
}

export function Sidebar({ 
    navigation, 
    activeNavId, 
    onNavChange, 
    isCollapsed = false, 
    onToggleCollapse,
    cliVersion,
    generatedAt,
    reposCount
}: SidebarProps) {
    const [showTaxonomy, setShowTaxonomy] = useState(false);

    const formattedDate = new Date(generatedAt || Date.now())
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ');
    const OpenSidebarIcon = (LucideIcons as any).PanelLeftOpen || (LucideIcons as any).PanelLeft || LucideIcons.Menu;
    const CloseSidebarIcon = (LucideIcons as any).PanelLeftClose || (LucideIcons as any).PanelLeft || LucideIcons.Menu;
    const activeIndex = navigation.items.findIndex(item => item.id === activeNavId);
    const activeRailTop = 64 + activeIndex * 36;

    return (
        <aside
            className={`cr-sidebar ${isCollapsed ? 'cr-sidebar-collapsed' : ''}`}
            style={activeIndex >= 0 ? { '--cr-active-rail-y': `${activeRailTop}px` } as CSSProperties : undefined}
        >
            {activeIndex >= 0 && <span className="cr-sidebar-active-rail" aria-hidden="true" />}
            <div className="cr-sidebar-content">
                <div className="cr-sidebar-header">
                    {!isCollapsed && (
                        <a href="https://coderadius.ai" target="_blank" rel="noopener noreferrer" className="cr-sidebar-brand-main">
                            <span className="cr-sidebar-brand-logo" aria-hidden="true">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <mask id="cr-cut-sb-brand">
                                        <rect width="24" height="24" fill="white"/>
                                        <line x1="12" y1="12" x2="22" y2="4" stroke="black" strokeWidth="2.5" strokeLinecap="round"/>
                                        <circle cx="12" cy="12" r="2" fill="black"/>
                                    </mask>
                                    <circle cx="12" cy="12" r="10" mask="url(#cr-cut-sb-brand)"/>
                                </svg>
                            </span>
                            <span className="cr-sidebar-brand-name">CodeRadius</span>
                        </a>
                    )}
                    {onToggleCollapse && (
                        <SimpleTooltip content={isCollapsed ? 'Open sidebar' : 'Collapse sidebar'} side={isCollapsed ? 'right' : 'top'}>
                            <button
                                className={`cr-sidebar-toggle ${isCollapsed ? 'cr-sidebar-toggle--collapsed' : ''}`}
                                onClick={onToggleCollapse}
                                aria-label={isCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
                            >
                                {isCollapsed ? (
                                    <>
                                        <span className="cr-sidebar-toggle__logo" aria-hidden="true">
                                            <svg viewBox="0 0 24 24" fill="currentColor">
                                                <mask id="cr-cut-sb-toggle">
                                                    <rect width="24" height="24" fill="white"/>
                                                    <line x1="12" y1="12" x2="22" y2="4" stroke="black" strokeWidth="2.5" strokeLinecap="round"/>
                                                    <circle cx="12" cy="12" r="2" fill="black"/>
                                                </mask>
                                                <circle cx="12" cy="12" r="10" mask="url(#cr-cut-sb-toggle)"/>
                                            </svg>
                                        </span>
                                        <span className="cr-sidebar-toggle__open" aria-hidden="true">
                                            <OpenSidebarIcon size={17} strokeWidth={1.8} />
                                        </span>
                                    </>
                                ) : (
                                    <CloseSidebarIcon size={17} strokeWidth={1.8} />
                                )}
                            </button>
                        </SimpleTooltip>
                    )}
                </div>
                <nav className="cr-sidebar-nav">
                    {navigation.items.map(item => {
                        const IconComponent = item.icon ? (LucideIcons as any)[item.icon] || LucideIcons.Circle : LucideIcons.Circle;
                        const isActive = activeNavId === item.id;

                        return (
                            <SimpleTooltip
                                key={item.id}
                                content={isCollapsed ? (item.hint || item.label) : item.hint}
                                side="right"
                            >
                                <button
                                    onClick={() => !item.disabled && onNavChange(item.id)}
                                    className={`cr-sidebar-item ${isActive ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`}
                                    aria-current={isActive ? 'page' : undefined}
                                    aria-disabled={item.disabled || undefined}
                                >
                                    <IconComponent size={18} strokeWidth={isActive ? 2 : 1.5} />
                                    <span className="cr-sidebar-label">{item.label}</span>
                                </button>
                            </SimpleTooltip>
                        );
                    })}
                </nav>
            </div>


            {/* Taxonomy Modal */}
            {showTaxonomy && (
                <div 
                    style={{
                        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        backdropFilter: 'blur(2px)'
                    }}
                    onClick={() => setShowTaxonomy(false)}
                >
                    <div 
                        style={{
                            background: '#0a0a0a', border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 8, padding: '24px 32px', width: '100%', maxWidth: 460,
                            display: 'flex', flexDirection: 'column', gap: 24,
                            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>Taxonomy Reference</h3>
                            <button 
                                onClick={() => setShowTaxonomy(false)}
                                style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
                            >
                                <LucideIcons.X size={16} />
                            </button>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Node Types</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 16px' }}>
                                {['Service', 'APIEndpoint', 'MessageChannel', 'DataContainer', 'UIComponent', 'Package', 'SystemProcess', 'Datastore'].map(type => (
                                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>
                                        <NodeIcon type={type} size={14} />
                                        <span>{type}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Discovery</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 16px' }}>
                                {['backstage', 'autodiscovery', 'code-analysis', 'crossplane', 'package-publisher', 'codeowners'].map(src => (
                                    <DiscoverySourceChip key={src} source={src} size={14} />
                                ))}
                            </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Infrastructure & Technology</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 16px' }}>
                                {['postgres', 'mongodb', 'mysql', 'redis', 'kafka', 'rabbitmq', 's3', 'elasticsearch', 'pubsub', 'kubernetes', 'aws', 'gcp', 'graphql', 'snowflake'].map(tech => (
                                    <InfraTechChip key={tech} technology={tech} size={14} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </aside>
    );
}
