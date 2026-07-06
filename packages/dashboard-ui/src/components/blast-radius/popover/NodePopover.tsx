import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Maximize2, CornerUpRight, Info } from 'lucide-react';
import type { TopologyNode } from '@coderadius/shared-types';
import {
    NodeIcon,
    getNodeTypeColor,
    getHttpMethodMeta,
    HttpMethodBadge,
    EntityBadge,
    getTechBadgeMeta,
    DiscoverySourceChip,
    InfraTechChip,
    RelBadge,
    sortRels,
    ExternalLinkIcon,
} from '../../Taxonomy';
import { ResourceRow } from '../ResourceRow';
import { OpenDetailsButton } from '../../OpenDetailsButton';
import { normaliseRepoUrl } from '../../../lib/git-url';
import { gravityTier } from '../../../lib/blastTier';
import { BlastTierChip } from '../banner/BlastTierChip';
import { SimpleTooltip } from '../../Tooltip';
import { QualityBadge } from '../../QualityBadge';
import { isStructuralFamily, QUALITY_VALUES, type Quality } from '../../../types/grounding';
import { getServiceQualifier, useMultiServiceRepos } from '../hooks/MultiServiceReposContext';
import { isInsideLayer } from '../../../lib/dismissable-layer';
import { useFocusTrap } from '../../../lib/use-focus-trap';
import type { NodeCluster } from '../types';
import { MiddleEllipsis } from '../../MiddleEllipsis';

export interface PopoverAnchor {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type PopoverTarget =
    | {
          kind: 'node';
          node: TopologyNode;
          urn: string;
          tier: 0 | 1 | 2;
          rels?: string[];
          via?: {
              node: TopologyNode;
              urn: string;
              pivotToViaRels: string[];
              viaToTargetRels: string[];
              totalBridgeCount: number;
              totalPathCount: number;
          };
          pivot?: { node: TopologyNode; urn: string };
          anchor: PopoverAnchor;
      }
    | {
          kind: 'cluster';
          cluster: NodeCluster;
          anchor: PopoverAnchor;
      };

interface NodePopoverProps {
    target: PopoverTarget | null;
    onClose: () => void;
    onExplore: (urn: string) => void;
    onOpenDrawer?: (urn: string) => void;
    onOpenInspector?: (urn: string) => void;
    onExpandCluster?: (sigKey: string) => void;
    onMemberHover?: (urn: string | null) => void;
    onOpenInRegistry?: (urn: string) => void;
}

const SOLO_WIDTH = 320;
const CLUSTER_WIDTH = 360;

function pluralType(t: string): string {
    const map: Record<string, string> = {
        DataContainer: 'Data Containers',
        APIEndpoint: 'API Endpoints',
        MessageChannel: 'Message Channels',
        Service: 'Services',
        Datastore: 'Datastores',
        Package: 'Packages',
    };
    return map[t] ?? `${t}s`;
}

export function NodePopover({
    target,
    onClose,
    onExplore,
    onOpenDrawer,
    onOpenInspector,
    onExpandCluster,
    onMemberHover,
    onOpenInRegistry,
}: NodePopoverProps) {
    const popRef = useRef<HTMLDivElement>(null);
    const [copied, setCopied] = useState(false);
    const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
    const multiServiceRepos = useMultiServiceRepos();

    useFocusTrap(popRef);

    useLayoutEffect(() => {
        if (!popRef.current) { setMeasuredHeight(null); return; }
        setMeasuredHeight(popRef.current.offsetHeight);
    }, [target]);

    useEffect(() => {
        if (!target) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        const onDown = (e: MouseEvent) => {
            if (isInsideLayer(e.target, popRef.current)) return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onDown, true);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onDown, true);
        };
    }, [target, onClose]);

    if (!target) return null;

    const width = target.kind === 'cluster' ? CLUSTER_WIDTH : SOLO_WIDTH;

    const ANCHOR_GAP = 12;
    const VIEWPORT_PAD = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const a = target.anchor;
    const cardCenterY = a.y + a.height / 2;
    const cardRight = a.x + a.width;
    const spaceRight = vw - cardRight - ANCHOR_GAP - VIEWPORT_PAD;
    const spaceLeft = a.x - ANCHOR_GAP - VIEWPORT_PAD;
    const placeRight = spaceRight >= width || spaceRight >= spaceLeft;
    const popoverLeft = placeRight ? cardRight + ANCHOR_GAP : a.x - width - ANCHOR_GAP;
    const ESTIMATED_HEIGHT = target.kind === 'cluster' ? 480 : 380;
    const effectiveHeight = measuredHeight ?? ESTIMATED_HEIGHT;
    const idealTop = cardCenterY - effectiveHeight / 2;
    const popoverTop = Math.max(VIEWPORT_PAD, Math.min(vh - effectiveHeight - VIEWPORT_PAD, idealTop));
    const popoverMaxHeight = Math.max(160, vh - popoverTop - VIEWPORT_PAD);
    const ARROW_EDGE_PAD = 22;
    const arrowYInPopover = Math.max(
        ARROW_EDGE_PAD,
        Math.min(effectiveHeight - ARROW_EDGE_PAD, cardCenterY - popoverTop),
    );

    const node = target.kind === 'node' ? target.node : target.cluster.members[0]?.node;
    const headerColor = node ? getNodeTypeColor(node.type) : '#71717a';

    const handleCopyUrn = () => {
        const text = target.kind === 'node' ? target.urn : target.cluster.id;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    };

    const tier = target.kind === 'node' ? target.tier : target.cluster.tier;

    return createPortal(
        <div
            ref={popRef}
            role="dialog"
            aria-modal="true"
            aria-label="Node details"
            className="cr-popover"
            data-side={placeRight ? 'right' : 'left'}
            style={{ left: popoverLeft, top: popoverTop, width, maxHeight: popoverMaxHeight }}
        >
            {placeRight ? (
                <svg className="cr-popover__arrow" width="9" height="16" aria-hidden="true" style={{ left: -8, top: arrowYInPopover - 8 }}>
                    <polygon points="9,1 1,8 9,15" />
                </svg>
            ) : (
                <svg className="cr-popover__arrow" width="9" height="16" aria-hidden="true" style={{ right: -8, top: arrowYInPopover - 8 }}>
                    <polygon points="0,1 8,8 0,15" />
                </svg>
            )}

            {/* Header */}
            <div className="cr-popover__header">
                <div className="cr-popover__node-icon" style={{ color: headerColor }}>
                    <NodeIcon type={node?.type ?? 'Service'} size={14} />
                </div>
                {(() => {
                    let titleEl: React.ReactNode;
                    if (target.kind === 'node' && target.node.type === 'APIEndpoint') {
                        const hm = getHttpMethodMeta(target.node.name, target.node.apiKind, target.node.operation);
                        titleEl = <MiddleEllipsis text={hm.path} className="cr-popover__title" noTitle />;
                    } else {
                        titleEl = <MiddleEllipsis text={target.kind === 'node' ? target.node.name : target.cluster.label} className="cr-popover__title" noTitle />;
                    }
                    if (target.kind === 'node') {
                        return (
                            <SimpleTooltip
                                side="bottom"
                                content={<span className="cr-popover__urn-tip">{target.urn}</span>}
                            >
                                <span className="cr-popover__title-wrap">{titleEl}</span>
                            </SimpleTooltip>
                        );
                    }
                    return titleEl;
                })()}

                <button className="cr-popover__header-btn" onClick={handleCopyUrn} aria-label={copied ? 'Copied' : 'Copy URN'}>
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                </button>
                <button className="cr-popover__header-btn" onClick={onClose} aria-label="Close">
                    <svg className="cr-popover__close-icon" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>
            </div>

            <div className="cr-popover__body">
                <div className="cr-popover__divider" />

                {/* Status: tier + quality */}
                <div className="cr-popover__status">
                    <div className="cr-popover__status-row">
                        {target.kind === 'cluster' ? (
                            <div className="cr-popover__cluster-info">
                                <span className="cr-popover__cluster-title">
                                    Cluster · {target.cluster.members.length} members
                                </span>
                                <span className="cr-popover__cluster-sub">
                                    {pluralType(target.cluster.nodeType)} grouped by structural similarity
                                </span>
                            </div>
                        ) : tier !== 0 ? (() => {
                            // The node's OWN gravity tier, from its real score and
                            // evidence. Never fabricate a score from the hop tier:
                            // hop distance (T1 direct / T2 transitive) and gravity
                            // (what breaks if this node dies) are different axes,
                            // and a hardcoded score renders the same loud tier for
                            // every node. Minimal variant: the popover is a glance
                            // surface, the filled badge belongs to the banner.
                            const score = target.node.gravityScore;
                            if (typeof score !== 'number') return null;
                            const nodeTier = gravityTier(score, target.node.gravityEvidence);
                            return (
                                <SimpleTooltip content={nodeTier.description} side="top">
                                    <span className="cr-popover__tip-trigger">
                                        <BlastTierChip rawScore={score} evidence={target.node.gravityEvidence} size="sm" variant="minimal" />
                                    </span>
                                </SimpleTooltip>
                            );
                        })() : (() => {
                            const pivotScore = target.node.gravityScore ?? 0;
                            return (
                                <SimpleTooltip content="The node selected as the centre of the impact graph." side="top">
                                    <span className="cr-popover__tip-trigger" style={{ gap: 6 }}>
                                        <BlastTierChip rawScore={pivotScore} evidence={target.node.gravityEvidence} size="sm" variant="minimal" />
                                        <span className="cr-popover__status-tier-label">{target.node.type}</span>
                                    </span>
                                </SimpleTooltip>
                            );
                        })()}
                    </div>
                    {(() => {
                        if (!node) return null;
                        const q = node.quality;
                        if (!q || !(QUALITY_VALUES as readonly string[]).includes(q)) return null;
                        if (isStructuralFamily(node.type)) return null;
                        return (
                            <span className="cr-popover__quality-row">
                                <QualityBadge quality={q as Quality} source={node.groundingSource ?? undefined} />
                                {node.needsReview && (
                                    <SimpleTooltip side="bottom" content="Flagged for human review. Run `cr review pending` for the full list.">
                                        <span className="cr-popover__review-flag">· needs review</span>
                                    </SimpleTooltip>
                                )}
                            </span>
                        );
                    })()}
                </div>

                <div className="cr-popover__divider" />

                {/* Relationship row (T1 only) */}
                {(() => {
                    if (target.kind !== 'node' || target.tier === 0 || target.tier === 2) return null;
                    const rels = sortRels(target.rels ?? []);
                    if (rels.length === 0) return null;
                    return (
                        <>
                            <div className="cr-popover__rel-row">
                                <span className="cr-popover__meta-key">Relationship</span>
                                <span className="cr-popover__rel-value">
                                    {rels.map(r => <RelBadge key={r} rel={r} variant="full" />)}
                                </span>
                            </div>
                            <div className="cr-popover__divider" />
                        </>
                    );
                })()}

                {/* Metadata grid (solo nodes) */}
                {target.kind === 'node' && (() => {
                    const n = target.node;
                    const repo = n.repository ? (() => {
                        try { return normaliseRepoUrl(n.repository.url); } catch { return null; }
                    })() : null;
                    const rows: Array<{ key: string; val: React.ReactNode; mono?: boolean } | null> = [];
                    if (n.teamOwner) rows.push({ key: 'Team', val: n.teamOwner });
                    if (n.repository) rows.push({ key: 'Repository', val: repo
                        ? <a href={repo} target="_blank" rel="noopener noreferrer" className="drawer-link">{n.repository.name}<ExternalLinkIcon size={10} /></a>
                        : n.repository.name });
                    if (n.repository?.mainBranch) rows.push({ key: 'Branch', val: n.repository.mainBranch, mono: true });
                    if (n.technology) rows.push({ key: 'Technology', val: <InfraTechChip technology={n.technology} nodeType={n.type} size={10} /> });
                    if (n.language)   rows.push({ key: 'Language',   val: <InfraTechChip technology={n.language}   nodeType={n.type} size={10} /> });
                    if (n.ecosystem)  rows.push({ key: 'Ecosystem',  val: n.ecosystem });
                    if (n.datastore?.length) rows.push({
                        key: n.datastore.length > 1 ? 'Datastores' : 'Datastore',
                        val: n.datastore.map(d => d.name + (d.host ? ` @ ${d.host}` : '')).join(', '),
                    });
                    if (n.channelKind) rows.push({ key: 'Channel kind', val: n.channelKind });
                    if (n.type === 'APIEndpoint') {
                        const apiMeta = getHttpMethodMeta(n.name, n.apiKind, n.operation);
                        if (n.apiKind) rows.push({ key: 'API kind', val: n.apiKind.toUpperCase() });
                        if (apiMeta.method) {
                            rows.push({ key: 'Method', val: <HttpMethodBadge method={apiMeta.method} color={apiMeta.color} bgColor={apiMeta.bgColor} borderColor={apiMeta.borderColor} size="sm" /> });
                        }
                        if (apiMeta.techFlavor && apiMeta.techSubtype) {
                            const tb = getTechBadgeMeta(apiMeta.techFlavor, apiMeta.techSubtype);
                            rows.push({ key: 'Operation', val: <EntityBadge label={apiMeta.techSubtype} color={tb.color} bgColor={tb.bg} borderColor={tb.border} size="sm" /> });
                        } else if (n.operation) {
                            rows.push({ key: 'Operation', val: n.operation });
                        }
                    } else if (n.apiKind) {
                        rows.push({ key: 'API kind', val: n.apiKind.toUpperCase() });
                    }
                    if (n.discoverySource) rows.push({ key: 'Discovery', val: <DiscoverySourceChip source={n.discoverySource} size={10} /> });
                    if (n.tags && n.tags.length) rows.push({ key: 'Tags', val: n.tags.join(', ') });
                    if (n.type === 'Service') {
                        const q = getServiceQualifier(n, target.urn, multiServiceRepos);
                        if (q && !n.repository) rows.push({ key: 'Context', val: q });
                    }
                    if (rows.length === 0) return null;
                    const hasT2PathRow = target.tier === 2 && !!target.via;
                    const hasFooterActions = target.tier !== 0 || !!onOpenInRegistry;
                    const showTrailingDivider = hasT2PathRow || hasFooterActions;
                    return (
                        <>
                            <div className="cr-popover__meta">
                                {rows.map((r, i) => (
                                    <div key={i} className="cr-popover__meta-row">
                                        <span className="cr-popover__meta-key">{r!.key}</span>
                                        <span className={`cr-popover__meta-val${r!.mono ? ' cr-popover__meta-val--mono' : ''}`}>{r!.val}</span>
                                    </div>
                                ))}
                            </div>
                            {showTrailingDivider && <div className="cr-popover__divider" />}
                        </>
                    );
                })()}

                {/* T2 transitive path */}
                {target.kind === 'node' && target.tier === 2 && target.via && (() => {
                    const bridges = target.via.totalBridgeCount;
                    const paths = target.via.totalPathCount;
                    const headline = bridges <= 1
                        ? <>Connected through <span className="cr-popover__path-via">{target.via.node.name}</span></>
                        : <>Connected through <span className="cr-popover__path-via">{bridges} resources</span></>;
                    const pathsLabel = paths === 1 ? '1 path' : `${paths} paths`;
                    return (
                        <>
                            <div className="cr-popover__path">
                                <span className="cr-popover__path-icon" aria-hidden><CornerUpRight size={11} /></span>
                                <span className="cr-popover__path-text">{headline}</span>
                                <span className="cr-popover__path-count">·  {pathsLabel}</span>
                            </div>
                            <div className="cr-popover__divider" />
                        </>
                    );
                })()}

                {/* Cluster members */}
                {target.kind === 'cluster' && (
                    <div className="cr-popover__members">
                        <div className="cr-popover__members-label">Members</div>
                        {target.cluster.members.slice(0, 8).map(m => (
                            <ResourceRow
                                key={m.urn}
                                type={m.node.type}
                                name={m.node.name}
                                rels={(m.rels ?? []).slice(0, 3)}
                                onOpenDetails={onOpenDrawer ? () => onOpenDrawer(m.urn) : undefined}
                                onUseAsTarget={() => { onExplore(m.urn); onClose(); }}
                                onMouseEnter={() => onMemberHover?.(m.urn)}
                                onMouseLeave={() => onMemberHover?.(null)}
                            />
                        ))}
                        {target.cluster.members.length > 8 && (
                            <span className="cr-popover__members-more">
                                + {target.cluster.members.length - 8} more
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Action footer */}
            <div className="cr-popover__footer">
                <div className="cr-popover__divider" />
                {target.kind === 'cluster' ? (
                    <button
                        className="cr-popover__action"
                        onClick={() => {
                            const sigKey = target.cluster.id.replace(/^cluster:/, '');
                            onExpandCluster?.(sigKey);
                            onClose();
                        }}
                    >
                        Expand cluster
                        <Maximize2 size={12} className="cr-popover__action-icon" />
                    </button>
                ) : (
                    <>
                        {onOpenInspector && (
                            <button className="cr-popover__action" onClick={() => onOpenInspector(target.urn)}>
                                Show details
                                <Info size={12} strokeWidth={1.6} className="cr-popover__action-icon" />
                            </button>
                        )}
                        {onOpenDrawer && target.tier !== 0 && (
                            <OpenDetailsButton variant="row" onClick={() => onOpenDrawer(target.urn)} />
                        )}
                        {target.tier !== 0 && (
                            <button className="cr-popover__action" onClick={() => { onExplore(target.urn); onClose(); }}>
                                Use as blast target
                                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" className="cr-popover__action-icon">
                                    <circle cx="7" cy="7" r="5.5" /><circle cx="7" cy="7" r="2.5" /><circle cx="7" cy="7" r="0.6" fill="currentColor" />
                                </svg>
                            </button>
                        )}
                        {onOpenInRegistry && (
                            <button className="cr-popover__action" onClick={() => { onOpenInRegistry(target.urn); onClose(); }}>
                                Open in System Registry
                                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" className="cr-popover__action-icon">
                                    <path d="M5 9l4-4M9 5h-3M9 5v3" strokeLinecap="round" /><rect x="2" y="2" width="10" height="10" rx="2" />
                                </svg>
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
