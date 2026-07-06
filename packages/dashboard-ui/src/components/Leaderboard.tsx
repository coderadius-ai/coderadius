import type { LeaderboardSection } from '@coderadius/types';
import { NodeIcon, TeamIcon, RepositoryIcon, InfraTechChip, DiscoverySourceChip } from './Taxonomy';
import { getBlastTier } from '../lib/blastTier';


export function Leaderboard({ section }: { section: LeaderboardSection }) {
    // Find the max score in this list to compute relative bar widths
    const maxScore = section.items && section.items.length > 0
        ? Math.max(...section.items.map(i => i.score))
        : 100;

    return (
        <section className="stagger-3">
            <h2>{section.title}</h2>
            <div>
                {section.items && section.items.length > 0 ? (
                    section.items.map((item, idx) => {
                        const tier = getBlastTier(item.score);
                        const barWidth = item.score;
                        return (
                            <div key={idx} className="gravity-card spotlight-card" style={{ gap: 0 }}>
                                <div className="gravity-card__header">
                                    <div className="gravity-card__title-group">
                                        <div className="gravity-card__rank">#{String(idx + 1).padStart(2, '0')}</div>
                                        <div className="gravity-card__title">
                                            {item.nodeType && <NodeIcon type={item.nodeType} size={14} />}
                                            <span className="gravity-card__name">{item.title}</span>
                                        </div>
                                    </div>
                                    
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)' }}>
                                                <span style={{ fontSize: '9px', fontWeight: 500, letterSpacing: '0.08em', color: 'var(--text-quaternary)' }}>SPOF SCORE</span>
                                                <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 500 }}>{item.score}</span>
                                            </div>
                                            <div style={{ width: '48px', height: '4px', background: 'rgba(0, 0, 0, 0.4)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.5)', borderRadius: '2px', overflow: 'hidden' }}>
                                                <div style={{ width: `${item.score}%`, height: '100%', background: `var(--tier-${tier.key})`, borderRadius: '2px' }} />
                                            </div>
                                        </div>
                                        <div
                                            className={`gravity-tier-badge gravity-tier-badge--${tier.key}`}
                                            title={tier.description}
                                            aria-label={`${tier.grade} ${tier.label}: ${tier.description}`}
                                        >
                                            <span className="gravity-tier-badge__grade">{tier.grade}</span>
                                            <span className="gravity-tier-badge__sep" aria-hidden="true">·</span>
                                            <span className="gravity-tier-badge__label">{tier.label}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="gravity-card__meta" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '0 0 10px 0', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                                    {item.teams && item.teams.length > 0 && (
                                        <span className="gravity-card__meta-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <TeamIcon size={12} />
                                            {item.teams.join(', ')}
                                        </span>
                                    )}
                                    {item.repository && (
                                        <span className="gravity-card__meta-item" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <RepositoryIcon size={12} />
                                            {item.repository.url ? (
                                                <a href={item.repository.url} target="_blank" rel="noopener noreferrer" className="gravity-link" style={{ color: 'inherit', textDecoration: 'none' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'inherit'}>
                                                    {item.repository.name}
                                                </a>
                                            ) : (
                                                item.repository.name
                                            )}
                                        </span>
                                    )}
                                    {item.technology && (
                                        <InfraTechChip technology={item.technology} nodeType={item.nodeType} size={12} />
                                    )}
                                    {item.discoverySource && (
                                        <DiscoverySourceChip source={item.discoverySource} size={12} />
                                    )}
                                </div>
                                
                                <div className="gravity-card__dependencies" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', columnGap: '32px', rowGap: '16px', margin: '0 -20px', padding: '12px 20px 0 20px', background: 'var(--bg-tertiary)', borderTop: '1px solid var(--border-subtle)' }}>
                                    {(item.writeServices && item.writeServices.length > 0) && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '280px' }}>
                                            <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Writers ({item.writeServices.length})</span>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                                                {item.writeServices.map((srv: any, i: number) => (
                                                    <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                                        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-quaternary)' }}>
                                                            <NodeIcon type="Service" size={12} />
                                                        </span>
                                                        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                                            {srv.context && (
                                                                <>
                                                                    <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{srv.context}</span>
                                                                    <span style={{ color: 'var(--text-quaternary)', margin: '0 2px' }}>/</span>
                                                                </>
                                                            )}
                                                            <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                                                                {srv.name}
                                                                {srv.count !== undefined && srv.count > 0 && (
                                                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                                                        <span style={{ margin: '0 6px', color: 'var(--text-quaternary)' }}>·</span>
                                                                        {srv.count} <span style={{ color: 'var(--text-quaternary)' }}>λ</span>
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {(item.readServices && item.readServices.length > 0) && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '280px' }}>
                                            <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Readers ({item.readServices.length})</span>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                                                {item.readServices.map((srv: any, i: number) => (
                                                    <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                                        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-quaternary)' }}>
                                                            <NodeIcon type="Service" size={12} />
                                                        </span>
                                                        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                                            {srv.context && (
                                                                <>
                                                                    <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{srv.context}</span>
                                                                    <span style={{ color: 'var(--text-quaternary)', margin: '0 2px' }}>/</span>
                                                                </>
                                                            )}
                                                            <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                                                                {srv.name}
                                                                {srv.count !== undefined && srv.count > 0 && (
                                                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                                                        <span style={{ margin: '0 6px', color: 'var(--text-quaternary)' }}>·</span>
                                                                        {srv.count} <span style={{ color: 'var(--text-quaternary)' }}>λ</span>
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {(item.dependentServices && item.dependentServices.length > 0) && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '280px' }}>
                                            <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Dependents ({item.dependentServices.length})</span>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                                                {item.dependentServices.map((srv: any, i: number) => (
                                                    <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                                                        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-quaternary)' }}>
                                                            <NodeIcon type="Service" size={12} />
                                                        </span>
                                                        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                                            {srv.context && (
                                                                <>
                                                                    <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{srv.context}</span>
                                                                    <span style={{ color: 'var(--text-quaternary)', margin: '0 2px' }}>/</span>
                                                                </>
                                                            )}
                                                            <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                                                                {srv.name}
                                                                {srv.count !== undefined && srv.count > 0 && (
                                                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                                                        <span style={{ margin: '0 6px', color: 'var(--text-quaternary)' }}>·</span>
                                                                        {srv.count} <span style={{ color: 'var(--text-quaternary)' }}>λ</span>
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <p style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>No items found.</p>
                )}
            </div>
        </section>
    );
}
