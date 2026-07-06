/**
 * BlastRadiusExplorer — Interactive Blast Radius Explorer (v2)
 *
 * Receives the full topology skeleton (pre-built adjacency map) and renders:
 *   1. A searchbar to select any node from the entire architecture
 *   2. Instantaneous 2-hop upstream/downstream cards on selection
 *   3. Tiered groups (Direct / Transitive) with "Via" breadcrumbs
 *   4. Filter chips by node type for large result sets
 *   5. Side drawer for tactical cause-effect inspection
 *
 * Zero server round-trips. Lookup is O(1) via the dual in/out index.
 * 2-hop traversal is computed client-side by following through passthrough resources.
 *
 * Design: Vercel/Linear aesthetic — dark, minimal, precise. No emojis.
 */

import { useState, useMemo, useRef, useEffect, type CSSProperties } from 'react';
import { Copy } from 'lucide-react';
import type { TopologyMap, TopologyNode } from '@coderadius/shared-types';
import { getTieredBlasts } from '../../lib/topology';
import type { TieredBlastNode } from '../../lib/topology';
import { normaliseRepoUrl } from '../../lib/git-url';
import { getBlastTier, gravityTier } from '../../lib/blastTier';

import { NodeIcon, getNodeTypeColor, TeamsIcon, getHttpMethodMeta, HttpMethodBadge, TechBadge, ChannelKindBadge, DiscoverySourceChip, InfraTechChip } from '../Taxonomy';
import { StatusBar, StatusBarSep, StatusBarDot, StatusBarOk, StatusBarKbd } from '../design-system';

import { SimpleTooltip } from '../Tooltip';
import { MultiServiceReposContext, getServiceQualifier, useServiceQualifier } from './hooks/MultiServiceReposContext';
import { getServiceContext } from './utils/service-context';
import { QualifiedServiceName } from './utils/qualified-name';
import { getColumnLabels } from './utils/column-labels';
import { BlastTierLabel } from './banner/BlastTierLabel';
import { BlastBannerBody } from './banner/BlastBannerBody';
import { SearchBar, type SearchBarHandle } from './search/SearchBar';
import { BlastDrawer } from './drawer/BlastDrawer';
import { NodeInspectorModal } from './inspector/NodeInspectorModal';
import { BlastRadiusGraphView } from './BlastRadiusGraphView';
import { datastoreTooltip } from './lib/datastore-display';
import { BlastRadiusListView } from './BlastRadiusListView';
import { MiddleEllipsis } from '../MiddleEllipsis';

// Re-export the helpers other modules used to import from this file. Phase A.0
// keeps the public surface intact while the body shrinks.
export { getServiceContext, QualifiedServiceName };

function formatStatusTimestamp(value?: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function BlastRadiusExplorer({
    topology,
    viewMode = 'graph',
    onSwitchView,
    meta,
}: {
    topology: TopologyMap,
    viewMode?: 'graph' | 'list',
    onSwitchView?: (m: 'graph' | 'list') => void,
    meta?: { cliVersion?: string; generatedAt?: string },
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const bannerRef = useRef<HTMLDivElement>(null);
    const sidebarPortalRef = useRef<HTMLDivElement>(null);
    const [selectedUrn, setSelectedUrn] = useState<string | null>(null);
    const [drawerItem, setDrawerItem] = useState<TieredBlastNode | null>(null);
    const [inspectedUrn, setInspectedUrn] = useState<string | null>(null);
    const [isFilterSidebarOpen, setIsFilterSidebarOpen] = useState(false);

    // Selection from the global palette arrives via hash navigation:
    // AppInner's registerSelectHandler sets window.location.hash = 'blast:${urn}'
    // which the hashchange listener below picks up automatically.
    // No need to register anything here.

    // Single source of truth for the "this repo is a monorepo" rule used by
    // every Service rendering in this explorer (search dropdown, cards,
    // banner, drawer, relationship graph). Computed once per topology.
    const multiServiceRepos = useMemo(() => {
        const counts = new Map<string, number>();
        for (const node of Object.values(topology.nodes)) {
            if (node.type !== 'Service' && node.type !== 'Library') continue;
            const repo = node.repository?.name;
            if (!repo) continue;
            counts.set(repo, (counts.get(repo) ?? 0) + 1);
        }
        const out = new Set<string>();
        for (const [repo, n] of counts) if (n >= 2) out.add(repo);
        return out;
    }, [topology]);

    // Sync with hash for browser back/forward navigation
    useEffect(() => {
        const handleHashChange = () => {
            const hash = window.location.hash;
            if (hash.startsWith('#blast:')) {
                const urn = hash.replace('#blast:', '');
                if (topology.nodes[urn]) {
                    setSelectedUrn(urn);
                } else {
                    setSelectedUrn(null);
                }
            } else {
                setSelectedUrn(null);
            }
        };

        handleHashChange(); // Init from hash
        window.addEventListener('hashchange', handleHashChange);
        return () => window.removeEventListener('hashchange', handleHashChange);
    }, [topology]);

    const handleSelectUrn = (urn: string | null) => {
        if (urn) {
            window.location.hash = `blast:${urn}`;
        } else {
            // Clear hash without scrolling to top
            window.history.pushState('', document.title, window.location.pathname + window.location.search);
        }
        setSelectedUrn(urn);
        setDrawerItem(null); // Close drawer on navigation
    };

    // 2-hop tiered impact — the core of the product
    const impact = useMemo(
        () => selectedUrn ? getTieredBlasts(topology, selectedUrn) : null,
        [topology, selectedUrn],
    );

    const selectedNode: TopologyNode | null = selectedUrn ? topology.nodes[selectedUrn] ?? null : null;

    // Partition: architectural nodes vs software packages
    const archDownstream = useMemo(
        () => impact ? impact.downstream.filter(n => n.node.type !== 'Package') : [],
        [impact],
    );
    const archUpstream = useMemo(
        () => impact ? impact.upstream.filter(n => n.node.type !== 'Package') : [],
        [impact],
    );
    const packageDeps = useMemo(
        () => impact ? impact.upstream.filter(n => n.node.type === 'Package') : [],
        [impact],
    );

    // Flattened input for the v3 single-stream list view: every architectural
    // node from both directions plus the Package deps that used to live in a
    // separate collapsed section. Each item still carries its original
    // `direction`, so `mergeStream` can split a node that's both upstream and
    // downstream into two rows.
    const listItems = useMemo(
        () => [...archDownstream, ...archUpstream, ...packageDeps],
        [archDownstream, archUpstream, packageDeps],
    );

    // Tier counts — architectural nodes only (packages excluded)
    const tierCounts = useMemo(() => {
        if (!impact) return { t1Down: 0, t2Down: 0, t1Up: 0, t2Up: 0 };
        return {
            t1Down: archDownstream.filter(n => n.tier === 1).length,
            t2Down: archDownstream.filter(n => n.tier === 2).length,
            t1Up: archUpstream.filter(n => n.tier === 1).length,
            t2Up: archUpstream.filter(n => n.tier === 2).length,
        };
    }, [impact, archDownstream, archUpstream]);

    // Blast radius score + evidence — pre-computed server-side by the gravity
    // engine (computeGravityScores). Evidence gates the tier: no observed
    // dependent demotes the chip to "T? Unverified".
    const rawScore = selectedNode?.gravityScore ?? 0;
    const evidence = selectedNode?.gravityEvidence ?? null;
    const selectedTier = rawScore > 0 ? gravityTier(rawScore, evidence) : null;
    // The assistant note appears when the NUMERIC tier is seismic/critical:
    // either as the verified warning, or as the unverified caveat when the
    // demotion is masking a would-be-critical score.
    const numericTierKey = rawScore > 0 ? getBlastTier(rawScore).key : null;
    const showTierNote = numericTierKey === 'seismic' || numericTierKey === 'critical';

    const teams = useMemo(() => {
        if (!impact) return [];
        const set = new Set<string>();
        for (const item of [...archDownstream, ...archUpstream]) {
            if (item.node.teamOwner) set.add(item.node.teamOwner);
        }
        return Array.from(set).sort();
    }, [impact, archDownstream, archUpstream]);

    const suggestions = useMemo(() => {
        return Object.entries(topology.nodes)
            .map(([urn, node]) => ({
                urn, node,
                degree: (topology.out?.[urn]?.length ?? 0) + (topology.in?.[urn]?.length ?? 0),
            }))
            .sort((a, b) => b.degree - a.degree)
            .slice(0, 5);
    }, [topology]);

    // Dynamic column labels based on selected node type
    const labels = selectedNode ? getColumnLabels(selectedNode.type) : null;
    const nodeCount = useMemo(() => Object.keys(topology.nodes).length, [topology]);
    const relationTypeCount = useMemo(() => {
        const rels = new Set<string>();
        for (const edges of Object.values(topology.out)) {
            for (const edge of edges) rels.add(edge.rel);
        }
        return rels.size;
    }, [topology]);
    const statusGeneratedAt = useMemo(() => formatStatusTimestamp(meta?.generatedAt), [meta?.generatedAt]);

    return (
      <MultiServiceReposContext.Provider value={multiServiceRepos}>
        <div className={`blast-explorer${selectedUrn ? ' blast-explorer--active' : ''}${isFilterSidebarOpen ? ' blast-explorer--sidebar' : ''}`} ref={containerRef}>
            {/* Idle state: no target selected */}
            {!selectedUrn && (<>
                <BlastIdleState
                    topology={topology}
                    suggestions={suggestions}
                    nodeCount={nodeCount}
                    onSelect={handleSelectUrn}
                />
                <StatusBar
                    left={<>
                        {meta?.cliVersion && <span>v{meta.cliVersion}</span>}
                        {statusGeneratedAt && <><StatusBarSep /><span>{statusGeneratedAt}</span></>}
                        <StatusBarSep />
                        <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                    </>}
                    right={<>
                        <span>{nodeCount} nodes</span>
                        <StatusBarSep />
                        <span>{relationTypeCount} relation types</span>
                    </>}
                />
            </>)}

            {/* Selection: banner + panels */}
            {selectedUrn && selectedNode && impact && labels && (
                <>
                <div className="blast-explorer__content-row">
                <div className="blast-explorer__main">
                    <div
                        className="blast-target-banner"
                        ref={bannerRef}
                        style={{ '--blast-target-color': getNodeTypeColor(selectedNode.type) } as CSSProperties}
                    >
                        <div className="blast-target-banner__inner">
                            <div className="blast-target-banner__top">
                                <div className="blast-target-banner__identity">
                                    <div className="blast-target-banner__name">
                                        <NodeIcon type={selectedNode.type} size={16} />
                                        {selectedNode.type === 'APIEndpoint' ? (() => {
                                            const hm = getHttpMethodMeta(selectedNode.name, selectedNode.apiKind, selectedNode.operation);
                                            return (hm.method || hm.techFlavor) ? (
                                                <>
                                                    {hm.method && !hm.techFlavor && <HttpMethodBadge
                                                        method={hm.method}
                                                        color={hm.color}
                                                        bgColor={hm.bgColor}
                                                        borderColor={hm.borderColor}
                                                        size="sm"
                                                    />}
                                                    {hm.techFlavor && <TechBadge flavor={hm.techFlavor} subtype={hm.techSubtype} size="sm" />}
                                                    <MiddleEllipsis text={hm.path} />
                                                </>
                                            ) : (
                                                <MiddleEllipsis text={selectedNode.name} />
                                            );
                                        })() : selectedNode.type === 'MessageChannel' && selectedNode.channelKind ? (
                                            <>
                                                <ChannelKindBadge kind={selectedNode.channelKind} size="sm" />
                                                <MiddleEllipsis text={selectedNode.name} />
                                            </>
                                        ) : (
                                            <>
                                                {(() => {
                                                    const q = getServiceQualifier(selectedNode, selectedUrn, multiServiceRepos);
                                                    return q ? (
                                                        <span className="cr-mid-ellipsis">
                                                            <span className="cr-mid-ellipsis__head">
                                                                <span className="cr-qualified__context cr-qualified__context--lg">{q}</span>
                                                                <span className="cr-qualified__sep cr-qualified__sep--lg">/</span>
                                                            </span>
                                                            <span className="cr-mid-ellipsis__tail">{selectedNode.name}</span>
                                                        </span>
                                                    ) : <MiddleEllipsis text={selectedNode.name} />;
                                                })()}
                                            </>
                                        )}
                                    </div>
                                    {rawScore > 0 && (
                                        <BlastTierLabel rawScore={rawScore} evidence={evidence} variant="inline" />
                                    )}
                                    <div className="blast-target-banner__urn-row">
                                        <MiddleEllipsis text={selectedUrn} className="blast-target-banner__urn" />
                                        <button
                                            type="button"
                                            className="blast-target-banner__copy"
                                            onClick={() => navigator.clipboard?.writeText(selectedUrn)}
                                            aria-label="Copy target URN"
                                        >
                                            <Copy size={11} strokeWidth={1.8} />
                                        </button>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="blast-target-banner__copy blast-target-banner__copy--text"
                                    onClick={() => setInspectedUrn(selectedUrn)}
                                    aria-label="Show node details"
                                >
                                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                                        <circle cx="8" cy="8" r="6.5" />
                                        <path d="M8 7v4M8 5.5v0" strokeWidth="2" />
                                    </svg>
                                    <span>inspect</span>
                                </button>
                            </div>

                            <div className="blast-target-banner__operator-row">
                                <div className="blast-target-banner__context">
                                    {(selectedNode.teamOwner || selectedNode.repository || selectedNode.discoverySource || selectedNode.technology || (selectedNode.type === 'Service' && selectedUrn.split(':').length >= 3)) && (
                                        <div className="blast-target-banner__meta">
                                            {selectedNode.teamOwner && (
                                                <span className="blast-meta-item">
                                                    <TeamsIcon size={10} />
                                                    {selectedNode.teamOwner}
                                                </span>
                                            )}
                                            {selectedNode.repository ? (
                                                <span className="blast-meta-item">
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                                        <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <circle cx="3" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <circle cx="7" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <path d="M3 4v2M7 4c0 1.5-1 2-4 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                                                    </svg>
                                                    {(() => {
                                                        const repoWebUrl = normaliseRepoUrl(selectedNode.repository.url);
                                                        return repoWebUrl
                                                            ? <a href={repoWebUrl} target="_blank" rel="noopener noreferrer" className="blast-meta-link">{selectedNode.repository.name}</a>
                                                            : selectedNode.repository.name;
                                                    })()}
                                                </span>
                                            ) : selectedNode.type === 'Service' && selectedUrn.split(':').length >= 3 && (
                                                <span className="blast-meta-item" style={{ opacity: 0.6, fontStyle: 'italic' }}>
                                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                                                        <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <circle cx="3" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <circle cx="7" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                                                        <path d="M3 4v2M7 4c0 1.5-1 2-4 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                                                    </svg>
                                                    {selectedUrn.split(':')[2]}
                                                </span>
                                            )}
                                            {selectedNode.technology && (
                                                <SimpleTooltip content={`Technology: ${selectedNode.technology}`} side="bottom">
                                                    <span><InfraTechChip technology={selectedNode.technology} nodeType={selectedNode.type} size={10} /></span>
                                                </SimpleTooltip>
                                            )}
                                            {selectedNode.datastore?.length ? (
                                                <SimpleTooltip content={datastoreTooltip(selectedNode)} side="bottom">
                                                    <span className="blast-meta-item" style={{ maxWidth: '180px', cursor: 'default' }}>
                                                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ opacity: 0.6 }}>
                                                            <ellipse cx="6" cy="3" rx="4" ry="1.5" stroke="currentColor" strokeWidth="1.2" />
                                                            <path d="M2 3v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V3" stroke="currentColor" strokeWidth="1.2" />
                                                            <path d="M2 6v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V6" stroke="currentColor" strokeWidth="1.2" />
                                                        </svg>
                                                        <MiddleEllipsis text={selectedNode.datastore[0].name} className="cr-truncate" />
                                                        {selectedNode.datastore.length > 1 && <span style={{ opacity: 0.6, marginLeft: 2 }}>+{selectedNode.datastore.length - 1}</span>}
                                                    </span>
                                                </SimpleTooltip>
                                            ) : null}
                                            {selectedNode.discoverySource && (
                                                <SimpleTooltip content={`Discovered via: ${selectedNode.discoverySource}`} side="bottom">
                                                    <span><DiscoverySourceChip source={selectedNode.discoverySource} size={10} /></span>
                                                </SimpleTooltip>
                                            )}
                                        </div>
                                    )}
                                    {showTierNote && selectedTier && (
                                        <SimpleTooltip content={selectedTier.description} side="bottom">
                                            <span className={`blast-target-banner__tier-note blast-target-banner__tier-note--${selectedTier.key}`}>
                                                <span className={`blast-target-banner__tier-glyph blast-target-banner__tier-glyph--${selectedTier.key}`} aria-hidden="true" />
                                                {selectedTier.key === 'unverified'
                                                    ? 'Score unverified, no observed dependents'
                                                    : selectedTier.description}
                                            </span>
                                        </SimpleTooltip>
                                    )}
                                </div>

                                <BlastBannerBody
                                    downstream={tierCounts.t1Down}
                                    transitive={tierCounts.t2Down + tierCounts.t2Up}
                                    upstream={tierCounts.t1Up + tierCounts.t2Up}
                                    teams={teams.length}
                                    rawScore={rawScore}
                                    evidence={evidence}
                                />
                            </div>
                        </div>
                    </div>

                    {viewMode === 'graph' ? (
                    <BlastRadiusGraphView
                        topology={topology}
                        selectedUrn={selectedUrn}
                        impact={impact}
                        onExplore={handleSelectUrn}
                        onSwitchToList={() => onSwitchView?.('list')}
                        sidebarPortalRef={sidebarPortalRef}
                        onFilterOpenChange={setIsFilterSidebarOpen}
                        onOpenDrawer={(urn) => {
                            // Resolve to a TieredBlastNode by URN so the drawer
                            // gets the full path/rel context, not just the URN.
                            const item = [...impact.downstream, ...impact.upstream].find(i => i.urn === urn);
                            if (item) setDrawerItem(item);
                        }}
                        onOpenInspector={(urn) => setInspectedUrn(urn)}
                    />
                ) : (
                    <BlastRadiusListView
                        items={listItems}
                        onDetailsClick={setDrawerItem}
                        onExploreClick={handleSelectUrn}
                    />
                )}

                </div>
                <div className="blast-explorer__sidebar-portal" ref={sidebarPortalRef} />
                </div>
                <StatusBar
                    left={<>
                        {meta?.cliVersion && <span>v{meta.cliVersion}</span>}
                        {statusGeneratedAt && <><StatusBarSep /><span>{statusGeneratedAt}</span></>}
                        <StatusBarSep />
                        <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                    </>}
                    right={viewMode === 'graph' ? (<>
                        <span>{nodeCount} NODES</span>
                        <StatusBarSep />
                        <span>{relationTypeCount} RELATION TYPES</span>
                        <StatusBarSep />
                        <span>drag pan</span>
                        <StatusBarSep />
                        <span>scroll zoom</span>
                        <StatusBarSep />
                        <span><StatusBarKbd>ESC</StatusBarKbd> RESET</span>
                    </>) : (<>
                        <span>{nodeCount} NODES</span>
                        <StatusBarSep />
                        <span>{relationTypeCount} RELATION TYPES</span>
                        <StatusBarSep />
                        <span>↑↓ NAVIGATE</span>
                    </>)}
                />

                    {/* Side Drawer — mounted in BOTH graph and list modes so the
                        graph view's popover "Show relation" action can open it. */}
                    {drawerItem && (
                        <BlastDrawer
                            item={drawerItem}
                            selectedNode={selectedNode}
                            selectedUrn={selectedUrn}
                            topology={topology}
                            schemas={topology.schemas}
                            onClose={() => setDrawerItem(null)}
                            onExplore={handleSelectUrn}
                        />
                    )}

                    {/* Node Inspector Modal: focused node-detail surface. Opens
                        from the banner [i] button. Reusable for any node URN. */}
                    {inspectedUrn && topology.nodes[inspectedUrn] && (
                        <NodeInspectorModal
                            node={topology.nodes[inspectedUrn]}
                            urn={inspectedUrn}
                            topology={topology}
                            schemas={topology.schemas?.[inspectedUrn]}
                            multiServiceRepos={multiServiceRepos}
                            rawScore={inspectedUrn === selectedUrn ? rawScore : undefined}
                            evidence={inspectedUrn === selectedUrn ? evidence : undefined}
                            onClose={() => setInspectedUrn(null)}
                            onSelectUrn={handleSelectUrn}
                        />
                    )}
                </>
            )}
        </div>
      </MultiServiceReposContext.Provider>
    );
}

function BlastIdleState({
    topology,
    suggestions,
    nodeCount,
    onSelect,
}: {
    topology: TopologyMap;
    suggestions: Array<{ urn: string; node: TopologyNode; degree: number }>;
    nodeCount: number;
    onSelect: (urn: string) => void;
}) {
    const searchBarRef = useRef<SearchBarHandle>(null);
    const qualifier = useServiceQualifier();

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                e.stopPropagation();
                searchBarRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, []);

    const highStakes = useMemo(() => {
        return Object.entries(topology.nodes)
            .filter(([, n]) => n.type !== 'Package' && (n.gravityScore ?? 0) >= 15)
            .sort((a, b) => (b[1].gravityScore ?? 0) - (a[1].gravityScore ?? 0))
            .slice(0, 4)
            .map(([urn, node]) => ({
                urn,
                node,
                tier: gravityTier(node.gravityScore ?? 0, node.gravityEvidence),
                score: ((node.gravityScore ?? 0) / (Math.max(...Object.values(topology.nodes).map(n => n.gravityScore ?? 0)) || 1)).toFixed(2),
            }));
    }, [topology]);

    const typeCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const node of Object.values(topology.nodes)) {
            if (node.type === 'Package') continue;
            counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
        }
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]);
    }, [topology]);

    return (
        <div className="blast-idle-state">

            <div className="blast-idle-state__search">
                <span className="blast-idle-state__label">Pick a target to start</span>
                <div className="blast-search-row">
                    <SearchBar ref={searchBarRef} topology={topology} selectedUrn={null} onSelect={onSelect} />
                </div>
            </div>

            {highStakes.length > 0 && (
                <div className="blast-idle-state__section">
                    <span className="blast-idle-state__heading">High stakes nodes</span>
                    <div className="blast-idle-state__list">
                        {highStakes.map((s, i) => (
                            <button key={s.urn} className="blast-idle-state__target" style={{ '--row-index': i } as CSSProperties} onClick={() => onSelect(s.urn)}>
                                <NodeIcon type={s.node.type} size={12} />
                                <span className="blast-idle-state__target-name">
                                    {(() => {
                                        const q = qualifier(s.node, s.urn);
                                        return q ? (
                                            <>
                                                <span className="cr-qualified__context">{q}</span>
                                                <span className="cr-qualified__sep">/</span>
                                                {s.node.name}
                                            </>
                                        ) : s.node.name;
                                    })()}
                                </span>
                                <span className="blast-idle-state__target-score">
                                    {s.tier.grade} · {s.score}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="blast-idle-state__section">
                <span className="blast-idle-state__heading">What counts as a target</span>
                <div className="blast-idle-state__types">
                    {typeCounts.map(([type, count]) => (
                        <span key={type} className="blast-idle-state__type">
                            <NodeIcon type={type} size={10} />
                            <span>{type}</span>
                            <span className="blast-idle-state__type-count">{count}</span>
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}
