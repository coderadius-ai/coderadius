import type { TieredBlastNode } from '../../../lib/topology';
import { normaliseRepoUrl } from '../../../lib/git-url';
import {
    getRelColor,
    NodeIcon,
    TeamIcon,
    getHttpMethodMeta,
    HttpMethodBadge,
    TechBadge,
    ChannelKindBadge,
    DiscoverySourceChip,
    InfraTechChip,
    RelBadge,
} from '../../Taxonomy';
import { SimpleTooltip } from '../../Tooltip';
import { QualityBadge } from '../../QualityBadge';
import { isStructuralFamily, QUALITY_VALUES, type Quality } from '../../../types/grounding';
import { getServiceContext } from '../utils/service-context';
import { useServiceQualifier } from '../hooks/MultiServiceReposContext';
import { MiddleEllipsis } from '../../MiddleEllipsis';
import { datastoreTooltip } from '../lib/datastore-display';

export function BlastCard({ item, onDetailsClick, onExploreClick, onViaExploreClick }: {
    item: TieredBlastNode & { rels?: string[]; totalCount?: number };
    onDetailsClick: () => void;
    onExploreClick: () => void;
    onViaExploreClick?: (urn: string) => void;
}) {
    const { node, urn, rel, tier, via } = item;
    const rels = item.rels ?? [rel];
    const totalCount = item.totalCount ?? 1;
    const qualifier = useServiceQualifier();
    const isApiEndpoint = node.type === 'APIEndpoint';
    const httpMeta = isApiEndpoint ? getHttpMethodMeta(node.name, node.apiKind, node.operation) : null;

    // Accent color for left-border: T1 = solid rel color, T2 = muted amber
    const relColorMap: Record<string, string> = {
        'rel-write': '#f87171',
        'rel-read': '#60a5fa',
        'rel-call': '#e879f9',
        'rel-dep': '#facc15',
        'rel-schema': '#2dd4bf',
        'rel-default': '#52525b',
    };
    const accentColor = tier === 1
        ? (relColorMap[getRelColor(rels[0])] ?? '#52525b')
        : 'rgba(250,204,21,0.4)';

    const repoWebUrl = node.repository ? (() => {
        try { return normaliseRepoUrl(node.repository.url); } catch { return null; }
    })() : null;

    return (
        <article
            className={`blast-service-card blast-service-card--v2 spotlight-card ${tier === 2 ? 'blast-card--tier2' : 'blast-card--tier1'}`}
            style={{ '--card-accent': accentColor } as React.CSSProperties}
            onClick={onDetailsClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDetailsClick(); }}
        >

            <div className="blast-card__body">
                {/* Row 1: Node identity */}
                <div className="blast-card__identity">
                    <div className="blast-card__name-group">
                        {isApiEndpoint && (httpMeta?.method || httpMeta?.techFlavor) ? (
                            <>
                                <NodeIcon type={node.type} size={12} />
                                {httpMeta.method && !httpMeta.techFlavor && <HttpMethodBadge
                                    method={httpMeta.method}
                                    color={httpMeta.color}
                                    bgColor={httpMeta.bgColor}
                                    borderColor={httpMeta.borderColor}
                                    size="sm"
                                />}
                                {httpMeta.techFlavor && <TechBadge flavor={httpMeta.techFlavor} subtype={httpMeta.techSubtype} />}
                                <SimpleTooltip content={urn} side="top">
                                    <span
                                        className="blast-service-card__name blast-card__api-path blast-card__name--link"
                                        onClick={(e) => { e.stopPropagation(); onExploreClick(); }}
                                        role="button"
                                    >
                                        <MiddleEllipsis text={httpMeta.path} />
                                    </span>
                                </SimpleTooltip>
                            </>
                        ) : (
                            <>
                                <NodeIcon type={node.type} size={12} />
                                {node.channelKind && <ChannelKindBadge kind={node.channelKind} size="sm" />}
                                <SimpleTooltip content={urn} side="top">
                                    <span
                                        className="blast-service-card__name blast-card__name--link"
                                        onClick={(e) => { e.stopPropagation(); onExploreClick(); }}
                                        role="button"
                                    >
                                        {(() => {
                                            const q = qualifier(node, urn);
                                            return q ? (
                                                <span className="cr-mid-ellipsis">
                                                    <span className="cr-mid-ellipsis__head">
                                                        <span className="cr-qualified__context">{q}</span>
                                                        <span className="cr-qualified__sep">/</span>
                                                    </span>
                                                    <span className="cr-mid-ellipsis__tail">{node.name}</span>
                                                </span>
                                            ) : <MiddleEllipsis text={node.name} />;
                                        })()}
                                    </span>
                                </SimpleTooltip>
                            </>
                        )}
                    </div>

                    {/* Rel badge + rel count + tier badge — top-right */}
                    <div className="blast-card__badges">
                        {tier !== 2 && item.functions && item.functions.length > 0 && (
                            <SimpleTooltip content={`${item.functions.length} impacted resources / functions`} side="top">
                                <span className="blast-card__fn-chip">
                                    <span className="blast-card__fn-chip-icon">λ</span>
                                    {item.functions.length}
                                </span>
                            </SimpleTooltip>
                        )}
                        {tier !== 2 && totalCount > 1 && (
                            <SimpleTooltip content={`${totalCount} relationship paths`} side="top">
                                <span className="blast-card__fn-chip">
                                    {totalCount}
                                </span>
                            </SimpleTooltip>
                        )}
                        {tier !== 2 && rels.map((r, i) => (
                            <RelBadge key={`${r}-${i}`} rel={r} />
                        ))}
                        {tier === 2 && (
                            <SimpleTooltip content="Transitive impact via intermediate node" side="top">
                                <span className="blast-tier-badge">T2</span>
                            </SimpleTooltip>
                        )}
                    </div>
                </div>

                {/* Row 2: Meta — team + repo + provenance/tech + quality */}
                {(node.teamOwner || node.repository || node.discoverySource || node.technology || node.datastore?.length || (node.quality && !isStructuralFamily(node.type)) || (node.type === 'Service' && !node.repository && getServiceContext(node, urn))) && (
                    <div className="blast-card__meta-row">
                        {node.teamOwner && (
                            <SimpleTooltip content="Owning team" side="bottom">
                                <span className="blast-card__team-chip">
                                    <TeamIcon size={9} />
                                    {node.teamOwner}
                                </span>
                            </SimpleTooltip>
                        )}
                        {node.repository ? (
                            <span className="blast-meta-item blast-meta-item--repo">
                                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                    <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <circle cx="3" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <circle cx="7" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <path d="M3 4v2M7 4c0 1.5-1 2-4 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                                </svg>
                                {repoWebUrl
                                    ? <a href={repoWebUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="blast-meta-link">{node.repository.name}</a>
                                    : node.repository.name}
                            </span>
                        ) : node.type === 'Service' && getServiceContext(node, urn) && (
                            <span className="blast-meta-item blast-meta-item--repo" style={{ opacity: 0.6, fontStyle: 'italic' }}>
                                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                    <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <circle cx="3" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <circle cx="7" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                    <path d="M3 4v2M7 4c0 1.5-1 2-4 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                                </svg>
                                {getServiceContext(node, urn)}
                            </span>
                        )}
                        {node.technology && (
                            <SimpleTooltip content={`Technology: ${node.technology}`} side="bottom">
                                <span><InfraTechChip technology={node.technology} nodeType={node.type} size={9} /></span>
                            </SimpleTooltip>
                        )}
                        {node.datastore?.length ? (
                            <SimpleTooltip content={datastoreTooltip(node)} side="bottom">
                                <span className="blast-meta-item" style={{ maxWidth: '120px', cursor: 'default' }} onClick={e => e.stopPropagation()}>
                                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ opacity: 0.6 }}>
                                        <ellipse cx="6" cy="3" rx="4" ry="1.5" stroke="currentColor" strokeWidth="1.2" />
                                        <path d="M2 3v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V3" stroke="currentColor" strokeWidth="1.2" />
                                        <path d="M2 6v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V6" stroke="currentColor" strokeWidth="1.2" />
                                    </svg>
                                    <MiddleEllipsis text={node.datastore[0].name} />
                                    {node.datastore.length > 1 && <span style={{ opacity: 0.6, marginLeft: 2 }}>+{node.datastore.length - 1}</span>}
                                </span>
                            </SimpleTooltip>
                        ) : null}
                        {node.discoverySource && (
                            <SimpleTooltip content={`Discovered via: ${node.discoverySource}`} side="bottom">
                                <span><DiscoverySourceChip source={node.discoverySource} size={9} /></span>
                            </SimpleTooltip>
                        )}
                        {/* Grounding quality tier. Only for inferred families: structural
                            labels (SourceFile/Function/Service/etc.) are uniformly ast/exact
                            and would drown the signal. Dot-only here to keep the chip strip
                            compact; full label is exposed in the drawer / popover. */}
                        {node.quality && QUALITY_VALUES.includes(node.quality as Quality) && !isStructuralFamily(node.type) && (
                            <QualityBadge
                                quality={node.quality as Quality}
                                dotOnly
                                source={node.groundingSource ?? undefined}
                            />
                        )}
                    </div>
                )}

                {/* Row 3: Via trace — ↳ symbol + name + type, plain typography, T2 only */}
                {tier === 2 && via && (
                    <div className="blast-card__via-trace">
                        <span className="blast-card__via-trace-joint" aria-hidden="true">↳</span>
                        <NodeIcon type={via.node.type} size={9} />
                        <span
                            className="blast-card__via-trace-name"
                            onClick={(e) => { e.stopPropagation(); onViaExploreClick?.(via.urn); }}
                            title={`Explore ${via.node.name}`}
                            role="button"
                        >
                            <MiddleEllipsis text={via.node.name} />
                        </span>
                        {totalCount > 0 && (
                            <span className="blast-card__via-count">
                                ({totalCount})
                            </span>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
}
