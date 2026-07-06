import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight } from 'lucide-react';
import type { TopologyMap, TopologyNode } from '@coderadius/shared-types';
import { CrButton } from '../design-system';
import type { TieredBlast, TieredBlastNode } from '../../lib/topology';
import { getAllPaths } from '../../lib/topology';
import { getRelColor, getHttpMethodMeta, NODE_TYPE_COLORS, NodeTypeFilterBar, RelBadge, appendNodeIconToSvg } from '../Taxonomy';
import { getServiceContext } from './utils/service-context';
import { pickIdentityToken } from './lib/identity-token';
import { clusterGraphNodes, isCluster } from '../../lib/graph-clustering';
import { buildBlastGraphModel, cardDims } from '../../lib/graph-model';
import { NodePopover, type PopoverTarget } from './popover/NodePopover';
import { ResourceRow } from './ResourceRow';
import { SimpleTooltip } from '../Tooltip';
import { QUALITY_META, QUALITY_VALUES, isStructuralFamily, type Quality } from '../../types/grounding';
import { useFuzzyFilter } from '../../lib/useFuzzyFilter';
import { highlightMatches } from '../../lib/fuzzy-match';
import { pushOverlay } from '../../lib/overlay-stack';
import * as d3 from 'd3';

import type { GraphNode, GraphEdge, GraphNodeOrCluster, NodeCluster } from './types';
import { splitForMiddleEllipsis } from '../MiddleEllipsis';

/** Rels exposed in the filter / legend rows. Mirrors the rel families
 *  the explorer cares about; keep aligned with the legend at the bottom
 *  of the canvas so the symbol vocabulary stays 1:1. */
const REL_FILTER_LIST: ReadonlyArray<{ rel: string; label: string }> = [
    { rel: 'READS',                label: 'Reads' },
    { rel: 'CALLS',                label: 'Calls' },
    { rel: 'WRITES',               label: 'Writes' },
    { rel: 'PUBLISHES_TO',         label: 'Publishes' },
    { rel: 'LISTENS_TO',           label: 'Subscribes' },
    { rel: 'IMPLEMENTS_ENDPOINT',  label: 'Implements' },
    { rel: 'MAPS_TO',              label: 'Defines' },
    { rel: 'DEPENDS_ON',           label: 'Depends' },
];

// Edge stroke palette. Mirror REL_COLOR_HEX in Taxonomy.tsx — single source
// of truth for the rel palette lives there; this map exists because edges
// are painted in inline SVG strokes (not CSS classes) and need raw hex.
const REL_COLORS: Record<string, string> = {
    'rel-write':   '#f87171',
    'rel-read':    '#60a5fa',
    'rel-call':    '#c084fc',
    'rel-impl':    '#22d3ee',
    'rel-pub':     '#facc15',
    'rel-sub':     '#34d399',
    'rel-dep':     '#94a3b8',
    'rel-schema':  '#2dd4bf',
    'rel-default': '#3f3f46',
};
function tc(type: string) { return NODE_TYPE_COLORS[type] ?? '#71717a'; }
// Card geometry (Phase A.1) — bigger than the old single-line cards so we can
// fit the 2-row layout: header (icon + name + optional trailing chip) on top,
// meta strip (2 columns of contextual info) below.
/**
 * Confidence → border treatment. The card fill stays constant; only the
 * border encodes confidence so labels remain crisp. Alpha values tuned so
 * the border carries visible weight against the lifted card fill — too
 * subtle reads as "no border", too strong reads as a UI badge.
 */
function confidenceBorder(confidence: number | undefined, typeColor: string): { stroke: string; dasharray: string | null } {
    const c = typeof confidence === 'number' ? confidence : 0.6; // legacy mid band
    if (c >= 0.75) return { stroke: `${typeColor}80`, dasharray: null };  // ~50% alpha
    if (c >= 0.45) return { stroke: `${typeColor}55`, dasharray: null };  // ~33% alpha
    return { stroke: `${typeColor}45`, dasharray: '4 3' };                  // ~27% dashed
}
function smartTruncate(raw: string, max: number): string {
    if (raw.length <= max) return raw;
    const split = splitForMiddleEllipsis(raw);
    if (!split) return raw.slice(0, max - 1) + '…';
    const tailBudget = Math.min(split.tail.length, Math.floor(max * 0.5));
    const headBudget = max - tailBudget - 1;
    if (headBudget < 3) return raw.slice(0, max - 1) + '…';
    return split.head.slice(0, headBudget) + '…' + split.tail.slice(-tailBudget);
}
function nodeName(node: TopologyNode, tier: 0|1|2): string {
    const raw = node.type === 'APIEndpoint' ? (getHttpMethodMeta(node.name, node.apiKind, node.operation).path || node.name) : node.name;
    const max = tier === 0 ? 26 : tier === 1 ? 26 : 22;
    return smartTruncate(raw, max);
}
// Icon glyphs come from the centralized registry in Taxonomy.tsx via
// `appendNodeIconToSvg(parent, type, x, y, size)`. Don't duplicate paths here.

// ─── Sidebar List with Fuzzy Filter ────────────────────────────────────────────

/** Deduplicated sidebar item — one entry per URN, with merged rels and max tier. */
interface SidebarItem {
    urn: string;
    node: TopologyNode;
    rels: string[];
    maxTier: number;
    /** Display name (path for API endpoints, name otherwise) */
    displayName: string;
}

/** Stable key extractor for the fuzzy filter hook. */
const SIDEBAR_FUZZY_KEYS = (item: SidebarItem) => [item.displayName, item.urn];

function SidebarList({ activeBlasts, sidebarQuery, svgRef, memberToClusterIdRef, onExplore, onOpenDrawer, onCenterNode }: {
    activeBlasts: TieredBlastNode[];
    sidebarQuery: string;
    svgRef: React.RefObject<SVGSVGElement>;
    memberToClusterIdRef: React.MutableRefObject<Map<string, string>>;
    onExplore: (urn: string) => void;
    onOpenDrawer?: (urn: string) => void;
    onCenterNode?: (urn: string) => void;
}) {
    // Deduplicate by URN — merge rels and take max tier
    const deduped = useMemo<SidebarItem[]>(() => {
        const map = new Map<string, SidebarItem>();
        for (const item of activeBlasts) {
            const existing = map.get(item.urn);
            if (existing) {
                if (!existing.rels.includes(item.rel)) existing.rels.push(item.rel);
                existing.maxTier = Math.max(existing.maxTier, item.tier);
            } else {
                const dn = item.node.type === 'APIEndpoint'
                    ? (getHttpMethodMeta(item.node.name, item.node.apiKind, item.node.operation).path || item.node.name)
                    : item.node.name;
                map.set(item.urn, { urn: item.urn, node: item.node, rels: [item.rel], maxTier: item.tier, displayName: dn });
            }
        }
        return Array.from(map.values());
    }, [activeBlasts]);

    // Fuzzy filter — when query is empty, returns all items (passthrough)
    const filteredRaw = useFuzzyFilter(deduped, sidebarQuery, { keys: SIDEBAR_FUZZY_KEYS });

    // Sort by node-type rank (data-shaped first, processes last) then name.
    // Mirrors how the user reasons about a blast surface: "what data does
    // this touch" → "what API/messages flow through" → "what processes run".
    const filtered = useMemo(() => {
        const TYPE_RANK: Record<string, number> = {
            DataContainer:  0,
            Datastore:      1,
            APIEndpoint:    2,
            MessageChannel: 3,
            Service:        4,
            Library:        5,
            Package:        6,
            SystemProcess:  99,   // always last
        };
        return [...filteredRaw].sort((a, b) => {
            const ra = TYPE_RANK[a.item.node.type] ?? 50;
            const rb = TYPE_RANK[b.item.node.type] ?? 50;
            if (ra !== rb) return ra - rb;
            return a.item.displayName.localeCompare(b.item.displayName);
        });
    }, [filteredRaw]);

    const filteredTotal = filtered.length;
    const isFiltering = sidebarQuery.trim().length > 0;

    /** Human-readable label for each node type group header. */
    const TYPE_LABEL: Record<string, string> = {
        DataContainer:  'Data',
        Datastore:      'Datastore',
        APIEndpoint:    'API',
        MessageChannel: 'Message Channel',
        Service:        'Service',
        Library:        'Library',
        Package:        'Package',
        SystemProcess:  'System Process',
    };

    return (
        <div className="igv-cs__list">
                {(() => {
                    let lastType: string | null = null;
                    return filtered.map(({ item, primaryRanges }) => {
                        // Bind sidebar row ↔ graph node via the same id scheme used
                        // when rendering the SVG group. Dispatching a
                        // mouseenter/mouseleave on that <g> reuses every D3 hover
                        // effect — path tracing, dim/highlight, tooltip — without
                        // any duplicate state in React.
                        const targetId = memberToClusterIdRef.current.get(item.urn) ?? item.urn;
                        const nodeElId = `node-${targetId.replace(/[^a-zA-Z0-9]/g, '-')}`;
                        const fireOnNode = (type: 'mouseenter' | 'mouseleave') => {
                            const el = svgRef.current?.querySelector(`#${nodeElId}`);
                            if (!el) return;
                            el.dispatchEvent(new MouseEvent(type, { bubbles: false }));
                        };

                        const truncated = smartTruncate(item.displayName, 26);
                        const nameContent = primaryRanges
                            ? highlightMatches(truncated, primaryRanges)
                            : truncated;

                        // Emit a group-header divider when the type changes.
                        const showGroupHeader = !isFiltering && item.node.type !== lastType;
                        lastType = item.node.type;
                        const groupCount = filtered.filter(f => f.item.node.type === item.node.type).length;

                        return (
                            <div key={item.urn} style={{ display: 'contents' }}>
                                {showGroupHeader && (
                                    <div className="igv-cs__group-header">
                                        <span className="igv-cs__group-label">
                                            {TYPE_LABEL[item.node.type] ?? item.node.type}
                                        </span>
                                        <span className="igv-cs__group-count">{groupCount}</span>
                                    </div>
                                )}
                                <ResourceRow
                                    type={item.node.type}
                                    name={nameContent}
                                    rels={item.rels}
                                    trailing={item.maxTier === 2 ? <span className="igv-badge igv-badge--tier">T2</span> : undefined}
                                    // Row click = center+zoom the graph on this node.
                                    // Use-as-blast-target is now an explicit hover icon.
                                    onClick={onCenterNode ? () => onCenterNode(item.urn) : undefined}
                                    onOpenDetails={onOpenDrawer ? () => onOpenDrawer(item.urn) : undefined}
                                    onUseAsTarget={() => onExplore(item.urn)}
                                    onMouseEnter={() => fireOnNode('mouseenter')}
                                    onMouseLeave={() => fireOnNode('mouseleave')}
                                />
                            </div>
                        );
                    });
                })()}
            {isFiltering && filteredTotal === 0 && (
                <div style={{ padding: '16px 14px', color: 'var(--text-tertiary)', fontSize: 11, opacity: 0.6, textAlign: 'center' }}>
                    No matches for "{sidebarQuery}"
                </div>
            )}
        </div>
    );
}

export function BlastRadiusGraphView({ topology, selectedUrn, impact, onExplore, onSwitchToList, onOpenDrawer, onOpenInspector, sidebarPortalRef, onFilterOpenChange }: {
    topology: TopologyMap; selectedUrn: string; impact: TieredBlast;
    onExplore: (urn: string) => void; onSwitchToList: () => void;
    onOpenDrawer?: (urn: string) => void;
    onOpenInspector?: (urn: string) => void;
    sidebarPortalRef?: React.RefObject<HTMLDivElement | null>;
    onFilterOpenChange?: (open: boolean) => void;
}) {
    const svgRef = useRef<SVGSVGElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
    /** Blast target that last received an auto-fit. Filter-only rebuilds
     *  (sidebar toggles, search query) keep the same target and must NOT
     *  refit: they restore the user's manual pan/zoom instead. */
    const lastFitUrnRef = useRef<string | null>(null);
    /** Click-anchored popover (replaces the legacy hover tooltip). */
    const [popoverTarget, setPopoverTarget] = useState<PopoverTarget | null>(null);
    /** DOM id of the node element the popover is currently pinned to. The
     *  zoom handler reads this to keep the popover's anchor in sync with the
     *  card as the user pans/zooms. Ref (not state) so the zoom callback
     *  doesn't need to be re-registered on every popover open. */
    const popoverPinnedElIdRef = useRef<string | null>(null);
    /** Reset graph hover state (path-trace + dimming). Wired inside the
     *  D3 effect so it can read `nodeG`/`link`; called from the popover's
     *  onClose handler so closing always returns the canvas to neutral. */
    const resetHoverStateRef = useRef<() => void>(() => {});
    /** Pseudo-fullscreen mode: a CSS class on `.igv-canvas-wrap` that takes
     *  it to `position: fixed; inset: 0`. We deliberately do NOT use the
     *  native Fullscreen API (`element.requestFullscreen()`) because that
     *  reserves Escape at the browser level — pressing Escape while a
     *  drawer/modal is open exits fullscreen FIRST (no keydown delivered
     *  to the page), forcing a second Escape to actually close the drawer.
     *  CSS pseudo-fullscreen keeps Escape on the page so the shared
     *  overlay stack (lib/overlay-stack.ts) handles it in proper LIFO. */
    const [isFullscreen, setIsFullscreen] = useState(false);
    /** Filter panel open state. Lives inside the canvas wrapper so it rides
     *  along into fullscreen. Persisted to localStorage so the user preference
     *  survives reloads. Default open. */
    const [isFilterOpen, setIsFilterOpen] = useState<boolean>(() => {
        if (typeof window === 'undefined') return true;
        const v = window.localStorage.getItem('coderadius.blastRadius.filterOpen');
        return v === null ? true : v === 'true';
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem('coderadius.blastRadius.filterOpen', String(isFilterOpen));
        onFilterOpenChange?.(isFilterOpen);
    }, [isFilterOpen, onFilterOpenChange]);

    /** Latest handleFit closure. The fullscreen-transition refit effect
     *  reads this ref so it always invokes the live function (which
     *  closes over the current `isFilterOpen` / layout state). */
    const handleFitRef = useRef<() => void>(() => {});

    // Auto-refit the graph on every fullscreen transition: the canvas size
    // changes drastically (card → viewport or viceversa), so the previous
    // transform leaves the graph off-centre. A short delay lets the layout
    // settle before we measure clientWidth/clientHeight.
    useEffect(() => {
        const t = window.setTimeout(() => handleFitRef.current(), 80);
        return () => window.clearTimeout(t);
    }, [isFullscreen]);

    // Register pseudo-fullscreen on the shared LIFO overlay stack so Esc
    // exits fullscreen too once nothing else is open above it (drawers /
    // modals registered later sit on top of this and pop first).
    useEffect(() => {
        if (!isFullscreen) return;
        return pushOverlay(() => setIsFullscreen(false));
    }, [isFullscreen]);

    // Hoist the canvas wrap out of any ancestor containing-block trap.
    // `.blast-explorer` and `.igv-shell` use `animation: fadeUp ... both`,
    // whose `to` keyframe sets `transform: translateY(0)` and
    // `filter: blur(0)`. With `both` fill-mode those values persist
    // forever, and any element with a non-`none` transform/filter
    // becomes the containing block for its `position: fixed`
    // descendants — trapping our pseudo-fullscreen wrap inside the
    // explorer's box instead of the viewport. Toggling a body class
    // lets the matching CSS rule (graph-view.css) neutralise those
    // ancestors only while fullscreen is active.
    useEffect(() => {
        if (!isFullscreen) return;
        document.body.classList.add('cr-canvas-is-fullscreen');
        return () => document.body.classList.remove('cr-canvas-is-fullscreen');
    }, [isFullscreen]);

    const toggleFullscreen = () => setIsFullscreen(prev => !prev);
    const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set(['Package']));
    /** Rel-color buckets active in the current hover (node or edge). `null` =
     *  not hovering, all legend items appear at full opacity. Drives the
     *  legend dim treatment so the user instantly sees "these are the rels
     *  involved in what I'm hovering". */
    const [activeRelColors, setActiveRelColors] = useState<Set<string> | null>(null);
    const [showT2, setShowT2] = useState(true);
    /** Hidden relationship types (READS, WRITES, CALLS, …). Filters
     *  activeBlasts by their immediate `rel`, orthogonal to hiddenTypes.
     *  Default: empty set (all rels visible). */
    const [hiddenRels, setHiddenRels] = useState<Set<string>>(new Set());
    /** Toolbar toggle — collapse architecturally-equivalent siblings into supernodes. */
    const [groupSimilar, setGroupSimilar] = useState(true);
    /** Cluster signature keys the user has explicitly drilled into. */
    const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
    const expandedSignatures = useMemo(() => expandedClusters, [expandedClusters]);
    /** Sidebar full-text fuzzy search query. */
    const [sidebarQuery, setSidebarQuery] = useState('');
    // Reset sidebar filter when blast target changes — avoids stale filter
    // persisting on a new target that might have too few items to show the input.
    useEffect(() => { setSidebarQuery(''); }, [selectedUrn]);

    // Auto-narrow the type filter on large blast surfaces (>10 items the
    // sidebar reads as a wall). Two-mode policy:
    //   • If T2 paths exist → preselect ONLY the T2 badge: showT2 stays on
    //     and the visible TYPES narrow to those that participate in T2
    //     paths (the T2 nodes themselves + their via intermediates).
    //     Rationale: T2 IS the most-distant impact band — when there's a
    //     lot of noise, the user wants to focus on the deepest reach
    //     first; T1 nodes that aren't on a T2 path are visual padding.
    //   • Else → preselect the dominant TYPE (DataContainer if present,
    //     otherwise the most-populated type). Standard noise-reduction.
    // ≤10 items → default state (only Package hidden, T2 visible).
    useEffect(() => {
        const items = [...impact.downstream, ...impact.upstream];
        const allTypes = Array.from(new Set(items.map(i => i.node.type)));

        // Protected types: structurally important connectors that should
        // NEVER be auto-hidden, regardless of how DataContainer-heavy the
        // surface is. APIEndpoints carry the public contract surface (the
        // user expects to see "what API calls reach this service"), and
        // Services are the architectural participants. Hiding either makes
        // the graph "lie" vs. the side drawer's full relationship list.
        const PROTECTED_TYPES = new Set(['APIEndpoint', 'Service']);

        if (items.length <= 10) {
            setHiddenTypes(new Set(['Package']));
            setShowT2(true);
            return;
        }

        const t2Items = items.filter(i => i.tier === 2);
        if (t2Items.length > 0) {
            const visibleTypes = new Set<string>(PROTECTED_TYPES);
            for (const i of t2Items) {
                visibleTypes.add(i.node.type);
                if (i.via) visibleTypes.add(i.via.node.type);
            }
            setHiddenTypes(new Set(allTypes.filter(t => !visibleTypes.has(t))));
            setShowT2(true);
            return;
        }

        // Type-dominant fallback (no T2 in this surface).
        const counts = new Map<string, number>();
        for (const i of items) counts.set(i.node.type, (counts.get(i.node.type) ?? 0) + 1);
        const dominant = allTypes.includes('DataContainer')
            ? 'DataContainer'
            : allTypes.slice().sort((a, b) => (counts.get(b)! - counts.get(a)!))[0];
        setHiddenTypes(new Set(allTypes.filter(t => t !== dominant && !PROTECTED_TYPES.has(t))));
        setShowT2(true);
    }, [selectedUrn]);  // eslint-disable-line react-hooks/exhaustive-deps

    // Debounce the sidebar query for the graph filter animation (120ms)
    // so we don't trigger transitions on every keystroke.
    const [graphQuery, setGraphQuery] = useState('');
    useEffect(() => {
        const id = setTimeout(() => setGraphQuery(sidebarQuery.trim()), 120);
        return () => clearTimeout(id);
    }, [sidebarQuery]);

    /** Maps each member URN → the supernode id that owns it (for sidebar bind). */
    const memberToClusterIdRef = useRef<Map<string, string>>(new Map());
    /** Map URN → {x,y,cardW,cardH} of the rendered node. Populated each
     *  build pass; consumed by sidebar-row click to center+zoom on that node. */
    const nodePositionsRef = useRef<Map<string, { x: number; y: number; cardW: number; cardH: number }>>(new Map());

    const selectedNode = topology.nodes[selectedUrn];
    const allBlasts = [...impact.downstream, ...impact.upstream].sort((a,b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.node.name.localeCompare(b.node.name);
    });

    const activeBlasts = allBlasts.filter(i => {
        if (i.tier === 2 && !showT2) return false;
        if (hiddenTypes.has(i.node.type)) return false;
        if (i.tier === 2 && i.via && hiddenTypes.has(i.via.node.type)) return false;
        if (hiddenRels.has(i.rel)) return false;
        return true;
    });
    const uniqueTypes = Array.from(new Set(allBlasts.map(i => i.node.type))).sort();
    const uniqueRels = Array.from(new Set(allBlasts.map(i => i.rel)));

    const toggleType = (t: string) => {
        setHiddenTypes(prev => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t);
            else next.add(t);
            return next;
        });
    };

    // Adapter for the shared NodeTypeFilterBar — translates the bar's
    // (activeTypes + onToggle) model into the local hiddenTypes/showT2
    // state pair. The 'T2' enable path also unhides any node types
    // required to actually render the transitive paths, matching the
    // pre-extraction inline behavior.
    const filterTypes = uniqueTypes
        .map(type => ({ type, count: allBlasts.filter(i => i.node.type === type).length }))
        .sort((a, b) => b.count - a.count);
    const t2Count = allBlasts.filter(i => i.tier === 2).length;
    const activeFilterTypes = new Set<string>(uniqueTypes.filter(t => !hiddenTypes.has(t)));
    if (showT2) activeFilterTypes.add('T2');
    const handleFilterToggle = (key: string) => {
        if (key === 'T2') {
            const next = !showT2;
            setShowT2(next);
            if (next) {
                const requiredTypes = new Set<string>();
                allBlasts.forEach(i => {
                    if (i.tier === 2) {
                        requiredTypes.add(i.node.type);
                        if (i.via) requiredTypes.add(i.via.node.type);
                    }
                });
                setHiddenTypes(prev => {
                    if (Array.from(requiredTypes).every(t => !prev.has(t))) return prev;
                    const nextHidden = new Set(prev);
                    requiredTypes.forEach(t => nextHidden.delete(t));
                    return nextHidden;
                });
            }
            return;
        }
        toggleType(key);
    };

    const fitToNodes = (svgEl: SVGSVGElement, zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown>, nodes: GraphNode[], W: number, H: number, animated = true) => {
        const xs = nodes.map(d => d.x);
        const ys = nodes.map(d => d.y);
        if (!xs.length) return;
        const pad = 140;
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
        const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;

        // Natural fit-everything scale (cap at 0.95).
        const naturalScale = Math.min(0.95, Math.min(W / (x1 - x0), H / (y1 - y0)));

        // Adaptive minimum-readable floor: as the graph grows past what
        // can be shown comfortably, stop shrinking and let the user pan.
        // Below ~20 nodes the natural fit is already legible; above that we
        // clamp progressively so card text stays readable.
        const n = nodes.length;
        const readableFloor =
            n <= 20  ? 0.05 :   // small graphs: fit everything
            n <= 60  ? 0.40 :   // medium: at most 2.5x zoom out
            n <= 120 ? 0.50 :   // large: significant overflow, pan to explore
                       0.55;    // very large: focus on pivot, scroll the rest

        const scale = Math.max(readableFloor, naturalScale);

        // Centering policy: when scale equals naturalScale we center the
        // bounding box (everything fits). When the floor kicks in (overflow
        // mode) we center on the pivot card instead so the user starts at
        // the most relevant region — pivot lives at (W/2, H/2) in graph
        // coords by construction (see addNode).
        const overflow = scale > naturalScale;
        const cxGraph = overflow ? W / 2 : (x0 + x1) / 2;
        const cyGraph = overflow ? H / 2 : (y0 + y1) / 2;
        const tx = W / 2 - scale * cxGraph;
        const ty = H / 2 - scale * cyGraph;
        const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
        const sel = d3.select(svgEl);
        if (animated) sel.transition().duration(600).call(zoomBehavior.transform, t);
        else sel.call(zoomBehavior.transform, t);
    };

    useEffect(() => {
        if (!svgRef.current || !wrapperRef.current || !selectedNode) return () => {};
        const W = wrapperRef.current.clientWidth, H = wrapperRef.current.clientHeight;
        const cx = W / 2, cy = H / 2;
        const svg = d3.select(svgRef.current);
        svg.selectAll('*').remove();

        // Build the node/edge model (pure transform — see lib/graph-model.ts).
        // The model's nodes carry placeholder x/y (0); the column-grid layout
        // below assigns real positions after clustering.
        const { nodes: rawNodes, edges, multiViaSigs, t2BridgeCounts } = buildBlastGraphModel({
            topology, selectedUrn, selectedNode, impact,
            hiddenTypes, hiddenRels, showT2, graphQuery,
        });

        // ── Clustering pass: collapse architecturally-equivalent siblings ──
        // The pivot (tier 0) is never clustered. The cluster engine also
        // rewrites edges to terminate on cluster ids and dedupes parallel
        // edges so we don't paint N copies for N collapsed siblings.
        const clusterResult = clusterGraphNodes(rawNodes, edges, {
            enabled: groupSimilar,
            minSize: 4,
            expandedSignatures,
        });
        memberToClusterIdRef.current = clusterResult.memberToClusterId;
        const renderNodes: GraphNodeOrCluster[] = clusterResult.nodes;
        const renderEdges = clusterResult.edges;

        // Static layout calculation — clusters live in the same column grid as
        // solo nodes (they inherit `col` from their first member).
        const colMap = new Map<number, GraphNodeOrCluster[]>();
        [-2, -1, 0, 1, 2].forEach(c => colMap.set(c, []));
        renderNodes.forEach(n => colMap.get(n.col)!.push(n));

        const colWidth = 420;
        // Cards are now 48–72px tall. RowHeight = tallest neighbour card + 8px
        // gap; we tune per column instead of using a single global value so
        // tier-2 columns of 48px cards stack tightly while the pivot column
        // (72px) gets enough room.
        const colCardH = (c: number): number => {
            if (c === 0) return cardDims(0).h;       // 72
            if (c === -1 || c === 1) return cardDims(1).h; // 56
            return cardDims(2).h;                     // 48
        };
        const ROW_GAP = 14;

        [-2, -1, 0, 1, 2].forEach(c => {
            const list = colMap.get(c)!;
            // Sort by type then name (cluster label stands in for name).
            list.sort((a, b) => {
                const aType = isCluster(a) ? a.nodeType : a.node.type;
                const bType = isCluster(b) ? b.nodeType : b.node.type;
                const aName = isCluster(a) ? a.label : a.node.name;
                const bName = isCluster(b) ? b.label : b.node.name;
                return aType.localeCompare(bType) || aName.localeCompare(bName);
            });
            const rowH = colCardH(c) + ROW_GAP;
            list.forEach((n, i) => {
                n.x = cx + c * colWidth;
                n.y = cy + (i - (list.length - 1) / 2) * rowH;
            });
        });

        // Resolve sourceNode/targetNode pointers by id (cluster id OR urn)
        const nodesById = new Map<string, GraphNodeOrCluster>();
        renderNodes.forEach(n => nodesById.set(isCluster(n) ? n.id : n.urn, n));
        // Snapshot node positions so the sidebar can center the viewport on
        // any URN by lookup. Both raw URN and cluster id keys are recorded.
        nodePositionsRef.current.clear();
        for (const n of renderNodes) {
            const id = isCluster(n) ? n.id : n.urn;
            nodePositionsRef.current.set(id, { x: n.x, y: n.y, cardW: n.cardW, cardH: n.cardH });
        }
        renderEdges.forEach(e => {
            e.sourceNode = nodesById.get(e.source) as GraphNode | undefined;
            e.targetNode = nodesById.get(e.target) as GraphNode | undefined;
        });
        const validEdges = renderEdges.filter(e => e.sourceNode && e.targetNode);

        // ── Defs ──
        // Background is now pure CSS on `.igv-canvas-wrap` — flat dark surface
        // + a soft radial vignette. No SVG pattern field; the old uniform dot
        // grid read as a graphic-design template, not a deep-tech canvas.
        const defs = svg.append('defs');

        const gf = defs.append('filter').attr('id','igv-glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
        gf.append('feGaussianBlur').attr('stdDeviation','8').attr('result','blur');
        const fm = gf.append('feMerge'); fm.append('feMergeNode').attr('in','blur'); fm.append('feMergeNode').attr('in','SourceGraphic');

        // T2 glow: subtle orange aura around T2 cards. Matches the T2
        // tier filter chip color so the user reads "transitive tier" from
        // the ambient halo without losing the type-color border + icon.
        // stdDeviation small (3) + low alpha (0.45) so it stays a HINT,
        // not a competing visual element vs the pivot's stronger teal glow.
        const t2gf = defs.append('filter').attr('id','igv-t2-glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
        t2gf.append('feGaussianBlur').attr('in','SourceGraphic').attr('stdDeviation','3').attr('result','t2blur');
        t2gf.append('feFlood').attr('flood-color','#fb923c').attr('flood-opacity','0.45').attr('result','t2color');
        t2gf.append('feComposite').attr('in','t2color').attr('in2','t2blur').attr('operator','in').attr('result','t2glow');
        const t2fm = t2gf.append('feMerge');
        t2fm.append('feMergeNode').attr('in','t2glow');
        t2fm.append('feMergeNode').attr('in','SourceGraphic');

        // Zoom layer
        const zoomLayer = svg.append('g');
        const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.05, 6])
            .on('zoom', e => {
                zoomLayer.attr('transform', e.transform);
                // Keep the popover anchor pinned to its card during pan/zoom.
                // The popover is portaled (fixed positioning) and would
                // otherwise stay frozen at the screen coords from the click.
                const pinnedId = popoverPinnedElIdRef.current;
                if (pinnedId) {
                    const el = svgRef.current?.querySelector('#' + pinnedId);
                    if (el) {
                        const r = (el as SVGGraphicsElement).getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            setPopoverTarget(prev =>
                                prev ? { ...prev, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } } : null,
                            );
                        }
                    }
                }
            });
        svg.call(zoom);
        zoomRef.current = zoom;

        // ── Cluster stacked-deck shadows — painted BEFORE edges so the
        //    cards-behind-the-stack don't occlude the connecting links.
        //    The main card surface is still painted last (in nodeG) so it
        //    sits on top of both shadows and edges. Net stacking order:
        //      [shadows] → [edges] → [main card surface] ──
        const clusterShadowsLayer = zoomLayer.append('g').attr('class', 'igv-cluster-shadows');
        const clusterShadowG = clusterShadowsLayer
            .selectAll<SVGGElement, NodeCluster>('g')
            .data(renderNodes.filter(isCluster) as NodeCluster[])
            .enter().append('g')
            .attr('transform', d => `translate(${d.x},${d.y})`);
        // Back of stack (deepest)
        clusterShadowG.append('rect')
            .attr('x', d => -d.cardW/2 + 10).attr('y', d => -d.cardH/2 + 10)
            .attr('width', d => d.cardW).attr('height', d => d.cardH)
            .attr('rx', d => cardDims(d.tier).rx)
            .attr('fill', '#13131a')
            .attr('stroke', d => `${tc(d.nodeType)}28`)
            .attr('stroke-width', 1)
            .attr('opacity', 0.55);
        // Mid layer (closer to surface)
        clusterShadowG.append('rect')
            .attr('x', d => -d.cardW/2 + 5).attr('y', d => -d.cardH/2 + 5)
            .attr('width', d => d.cardW).attr('height', d => d.cardH)
            .attr('rx', d => cardDims(d.tier).rx)
            .attr('fill', '#181820')
            .attr('stroke', d => `${tc(d.nodeType)}38`)
            .attr('stroke-width', 1)
            .attr('opacity', 0.85);

        // ── Edges (Cubic Bezier) — confidence-driven opacity + dashed for low ──
        const baseEdgeOpacity = (c?: number) => 0.18 + 0.42 * Math.max(0, Math.min(1, c ?? 0.6));
        // Edge path generator (shared between visible link + invisible hit
        // path). The hit path widens the cursor-target zone so users can
        // hover an edge without precision aiming on a 1.5 px stroke.
        const edgePath = (d: GraphEdge) => {
            const s = d.sourceNode!, t = d.targetNode!;
            let sy = s.y;
            let ty = t.y;
            const sharedEdges = validEdges.filter(e =>
                (e.source === d.source && e.target === d.target) ||
                (e.source === d.target && e.target === d.source)
            );
            sharedEdges.sort((a,b) => a.id.localeCompare(b.id));
            const edgeIdx = sharedEdges.indexOf(d);
            const total = sharedEdges.length;
            const offset = (edgeIdx - (total - 1) / 2) * 6;
            sy += offset;
            ty += offset;
            const sx = s.col < t.col ? s.x + s.cardW/2 : s.x - s.cardW/2;
            const tx = s.col < t.col ? t.x - t.cardW/2 : t.x + t.cardW/2;
            return `M${sx},${sy} C${(sx+tx)/2},${sy} ${(sx+tx)/2},${ty} ${tx},${ty}`;
        };

        const linkLayer = zoomLayer.append('g').attr('class', 'igv-edges-layer');

        // Visible link.
        const link = linkLayer.selectAll<SVGPathElement, GraphEdge>('path.igv-edge').data(validEdges).enter().append('path')
            .attr('class', 'igv-edge')
            .attr('id', d => `edge-${d.id.replace(/[^a-zA-Z0-9]/g, '-')}`)
            .attr('fill', 'none')
            .attr('stroke', d => REL_COLORS[getRelColor(d.rel)] || REL_COLORS['rel-default'])
            .attr('stroke-width', 1.5)
            .attr('opacity', d => baseEdgeOpacity(d.confidence))
            .attr('stroke-dasharray', d => (typeof d.confidence === 'number' && d.confidence < 0.45) ? '4 3' : null)
            .attr('pointer-events', 'none')
            .attr('d', edgePath);

        // Invisible fat hit-path that catches mouse events. Painted AFTER
        // the visible link so it sits on top in z-order without occluding
        // (transparent stroke). pointer-events="stroke" means only the
        // stroke band is clickable; the path's fill area is ignored.
        const linkHit = linkLayer.selectAll<SVGPathElement, GraphEdge>('path.igv-edge-hit').data(validEdges).enter().append('path')
            .attr('class', 'igv-edge-hit')
            .attr('fill', 'none')
            .attr('stroke', 'transparent')
            .attr('stroke-width', 12)
            .attr('pointer-events', 'stroke')
            .style('cursor', 'pointer')
            .attr('d', edgePath);

        // ── Ghost edges layer (multi-via discovery) ──
        // Build edges for the "+N" extras collected above. Resolve each
        // passthrough endpoint via the cluster id if it got absorbed by the
        // cluster engine. Carry a `data-t2-urn` attribute so the hover/popover
        // handlers can target the right ones with a single selector. Default
        // opacity 0; CSS transition handles the fade-in/out animation.
        // One ghost edge per 2-hop path. No dedup against validEdges so the
        // user sees the SAME number of edges the drawer reports.
        // ── Multi-via classification on validEdges ──
        // Walk each valid edge (post-cluster). If its (src,tgt,rel) signature
        // (after applying the cluster URN→id mapping) matches one of the
        // multi-via signatures we tracked above AND no primary edge produced
        // the same signature, mark it as "multi-via only" — hidden by default,
        // revealed on T2 hover. Single render path, no separate ghost layer.
        const edgeMultiViaT2 = new Map<GraphEdge, Set<string>>();
        // Build set of post-cluster sigs for the PRIMARY edges (the ones
        // emitted by the impact loop *before* multi-via fan-out, i.e. those
        // whose pre-cluster sig is not in `multiViaSigs`). To do that, walk
        // the original `edges` array and check.
        const primarySigsPostCluster = new Set<string>();
        const multiViaSigsPostCluster = new Map<string, Set<string>>();
        for (const e of edges) {
            const newSrc = clusterResult.memberToClusterId.get(e.source) ?? e.source;
            const newTgt = clusterResult.memberToClusterId.get(e.target) ?? e.target;
            const sigPost = `${newSrc}|${newTgt}|${e.rel}`;
            const sigPre  = `${e.source}|${e.target}|${e.rel}`;
            const t2s = multiViaSigs.get(sigPre);
            if (t2s) {
                const set = multiViaSigsPostCluster.get(sigPost) ?? new Set<string>();
                t2s.forEach(t => set.add(t));
                multiViaSigsPostCluster.set(sigPost, set);
            } else {
                primarySigsPostCluster.add(sigPost);
            }
        }
        for (const ve of validEdges) {
            const sig = `${ve.source}|${ve.target}|${ve.rel}`;
            if (primarySigsPostCluster.has(sig)) continue; // visible primary
            const t2s = multiViaSigsPostCluster.get(sig);
            if (t2s && t2s.size > 0) edgeMultiViaT2.set(ve, t2s);
        }
        // Apply the gating to the regular link layer: hide multi-via-only
        // edges by default. The hit-area path stays clickable so hovering
        // a hidden edge isn't possible (intentional — only the T2 reveals).
        // Multi-via edges: faint hint by default (~5x dimmer than primaries)
        // so the user senses additional coupling without visual chaos. Hover
        // a T2 lifts them to full presence.
        const MV_HINT_OPACITY = 0.08;
        link.style('opacity', l => edgeMultiViaT2.has(l) ? MV_HINT_OPACITY : baseEdgeOpacity(l.confidence));
        linkHit.style('pointer-events', l => edgeMultiViaT2.has(l) ? 'none' : 'stroke');

        // ── Nodes ──
        const nodeG = zoomLayer.append('g').selectAll<SVGGElement, GraphNodeOrCluster>('g').data(renderNodes).enter().append('g')
            .attr('class', 'igv-node-g')
            .attr('id', d => `node-${(isCluster(d) ? d.id : d.urn).replace(/[^a-zA-Z0-9]/g, '-')}`)
            .attr('data-col', d => d.col)
            .attr('data-card-h', d => d.cardH)
            .attr('data-urn', d => isCluster(d) ? d.id : d.urn)
            .attr('data-orig-x', d => d.x)
            .attr('data-orig-y', d => d.y)
            .attr('transform', d => `translate(${d.x},${d.y})`)
            .style('cursor', 'pointer')
            // ── Hover paint helpers (shared by hover + click handlers) ──
            // Extracted so the click handler can repaint focus when the user
            // switches between cards while a popover is open, and so the
            // popover's onClose can reset the canvas via a ref.
            const paintHoverFor = (d: GraphNodeOrCluster) => {
                const myId = isCluster(d) ? d.id : d.urn;
                const connectedNodes = new Set<string>([myId]);
                const connectedEdges = new Set<GraphEdge>();
                const urnToTier = new Map<string, number>();
                renderNodes.forEach(n => urnToTier.set(isCluster(n) ? n.id : n.urn, n.tier));

                const queue = [myId];
                while (queue.length > 0) {
                    const curr = queue.shift()!;
                    const currTier = urnToTier.get(curr) ?? 0;
                    validEdges.forEach(l => {
                        const isSrcCurr = l.source === curr;
                        const isTgtCurr = l.target === curr;
                        if (isSrcCurr || isTgtCurr) {
                            const neighbor = isSrcCurr ? l.target : l.source;
                            const neighborTier = urnToTier.get(neighbor) ?? 0;
                            if (neighborTier < currTier || (curr === myId && neighborTier > currTier)) {
                                connectedEdges.add(l);
                                if (!connectedNodes.has(neighbor)) {
                                    connectedNodes.add(neighbor);
                                    if (neighborTier < currTier) queue.push(neighbor);
                                }
                            }
                        }
                    });
                }

                // Multi-via T2 reveal: when hovering a T2 node, edges that
                // are gated to its URN come to opacity 0.9 with the same
                // hover treatment as the rest of the highlighted set.
                const hoveredT2Urn = !isCluster(d) && d.tier === 2 ? d.urn : null;
                const colors = new Set<string>();
                connectedEdges.forEach(l => colors.add(getRelColor(l.rel)));
                if (hoveredT2Urn) {
                    for (const [edge, t2s] of edgeMultiViaT2) {
                        if (!t2s.has(hoveredT2Urn)) continue;
                        connectedNodes.add(edge.source);
                        connectedNodes.add(edge.target);
                        colors.add(getRelColor(edge.rel));
                        connectedEdges.add(edge);
                    }
                }
                link.style('opacity', l => {
                    if (connectedEdges.has(l)) return 0.9;
                    if (edgeMultiViaT2.has(l)) return 0;          // other-T2 multi-vias hide
                    return 0.05;
                }).attr('stroke-width', l => connectedEdges.has(l) ? 2.5 : 1.5)
                  .classed('igv-edge-active', l => connectedEdges.has(l));
                nodeG.attr('opacity', n => connectedNodes.has(isCluster(n) ? n.id : n.urn) ? 1 : 0.15);
                clusterShadowG.attr('opacity', n => connectedNodes.has(n.id) ? 1 : 0.15);
                setActiveRelColors(colors);
            };
            const resetHoverState = () => {
                nodeG.attr('opacity', 1);
                clusterShadowG.attr('opacity', 1);
                link.style('opacity', l => edgeMultiViaT2.has(l) ? MV_HINT_OPACITY : baseEdgeOpacity(l.confidence))
                    .attr('stroke-width', 1.5)
                    .classed('igv-edge-active', false);
                setActiveRelColors(null);
            };
            // Expose for the popover's onClose (defined outside this effect).
            resetHoverStateRef.current = resetHoverState;

            // Edge hover variant: highlight the edge itself + its two endpoint
            // cards, dim everything else. Mirrors paintHoverFor's visual
            // grammar so node-hover and edge-hover read as one feature.
            const paintHoverForEdge = (edge: GraphEdge) => {
                const endpoints = new Set<string>([edge.source, edge.target]);
                link.style('opacity', l => l === edge ? 1 : (edgeMultiViaT2.has(l) ? 0 : 0.05))  // hide multi-vias when an edge has focus
                    .attr('stroke-width', l => l === edge ? 2.5 : 1.5)
                    .classed('igv-edge-active', l => l === edge);
                nodeG.attr('opacity', n => endpoints.has(isCluster(n) ? n.id : n.urn) ? 1 : 0.15);
                clusterShadowG.attr('opacity', n => endpoints.has(n.id) ? 1 : 0.15);
                setActiveRelColors(new Set([getRelColor(edge.rel)]));
            };

            linkHit
                .on('mouseenter', function(_e, d) {
                    if (popoverPinnedElIdRef.current) return;
                    paintHoverForEdge(d);
                })
                .on('mouseleave', () => {
                    if (popoverPinnedElIdRef.current) return;
                    resetHoverState();
                });

            nodeG
                .on('click', function(e, d) {
                    e.stopPropagation();
                    const elId = (this as SVGGElement).id;
                    const rect = (this as SVGGElement).getBoundingClientRect();
                    const anchor = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
                    // Switching from a previously-pinned card: clear its
                    // painted state before repainting for the new one.
                    resetHoverState();
                    paintHoverFor(d);
                    popoverPinnedElIdRef.current = elId;
                    if (isCluster(d)) {
                        setPopoverTarget({ kind: 'cluster', cluster: d, anchor });
                        return;
                    }
                    const tieredItem = [...impact.downstream, ...impact.upstream].find(i => i.urn === d.urn);
                    let viaPayload: { node: TopologyNode; urn: string; pivotToViaRels: string[]; viaToTargetRels: string[]; totalBridgeCount: number; totalPathCount: number } | undefined;
                    if (tieredItem?.via) {
                        // SOURCE OF TRUTH = `getAllPaths` (same as the side
                        // drawer). Compute pivot↔via rels, via↔target rels,
                        // total bridge count, and total path count from one
                        // function — guarantees the popover summary, the
                        // graph ghost edges, and the drawer all agree.
                        const viaUrn = tieredItem.via.urn;
                        const allPaths = getAllPaths(topology, selectedUrn, d.urn);
                        const pivotToViaRels = new Set<string>();
                        const viaToTargetRels = new Set<string>();
                        const distinctVias = new Set<string>();
                        for (const p of allPaths) {
                            if (!p.via) continue;
                            distinctVias.add(p.via.urn);
                            // Collect rels for the PRIMARY via specifically (the one
                            // shown in the popover header). Other vias surface in
                            // the totalBridgeCount summary.
                            if (p.via.urn === viaUrn) {
                                if (p.rels[0]) pivotToViaRels.add(p.rels[0]);
                                if (p.rels[1]) viaToTargetRels.add(p.rels[1]);
                            }
                        }
                        viaPayload = {
                            node: tieredItem.via.node,
                            urn: viaUrn,
                            pivotToViaRels: Array.from(pivotToViaRels),
                            viaToTargetRels: Array.from(viaToTargetRels),
                            totalBridgeCount: distinctVias.size,
                            totalPathCount: allPaths.length,
                        };
                    }
                    setPopoverTarget({
                        kind: 'node',
                        node: d.node,
                        urn: d.urn,
                        tier: d.tier,
                        rels: d.rels,
                        via: viaPayload,
                        pivot: { node: selectedNode, urn: selectedUrn },
                        anchor,
                    });
                })
                .on('mouseenter', function(_e, d) {
                    // Popover pinned: the click handler already painted focus
                    // for that card; suppress hover-driven repaints so other
                    // cards don't steal it (and so cursoring over the popover
                    // — which overlaps other cards visually — is inert).
                    if (popoverPinnedElIdRef.current) return;
                    paintHoverFor(d);
                })
                .on('mouseleave', () => {
                    if (popoverPinnedElIdRef.current) return;
                    resetHoverState();
                });

        // ── Cluster stacked-deck shadows (drawn FIRST so the main card sits on top) ──
        const clusterG = nodeG.filter(d => isCluster(d));
        // ── Card bg (main) — fill lifted ~8% above the canvas radial
        //    gradient (#0d0d12 → #08090c). Card-on-canvas contrast carries
        //    the surface; border (see confidenceBorder) carries the rest. ──
        nodeG.append('rect')
            .attr('x', d => -d.cardW/2).attr('y', d => -d.cardH/2)
            .attr('width', d => d.cardW).attr('height', d => d.cardH)
            .attr('rx', d => cardDims(d.tier).rx)
            .attr('fill', '#1c1c24')
            .attr('stroke', d => {
                if (!isCluster(d) && d.tier === 0) return '#5eead4'; // pivot
                // T2 cards: orange border to match the orange glow + the
                // T2 tier filter chip in the toolbar.
                const baseColor = (!isCluster(d) && d.tier === 2)
                    ? '#fb923c'
                    : tc(isCluster(d) ? d.nodeType : d.node.type);
                return confidenceBorder(d.confidence, baseColor).stroke;
            })
            .attr('stroke-width', d => (!isCluster(d) && d.tier === 0) ? 1.5 : 1)
            .attr('stroke-dasharray', d => {
                if (!isCluster(d) && d.tier === 0) return null;
                const baseColor = (!isCluster(d) && d.tier === 2)
                    ? '#fb923c'
                    : tc(isCluster(d) ? d.nodeType : d.node.type);
                return confidenceBorder(d.confidence, baseColor).dasharray;
            })
            .attr('filter', d => {
                if (!isCluster(d) && d.tier === 0) return 'url(#igv-glow)';
                if (!isCluster(d) && d.tier === 2) return 'url(#igv-t2-glow)';
                return null;
            });

        // ── Header row: icon + name (+ cluster count pill on the right) ──
        // Icon glyph at the leading edge.
        // Icon glyph — sits in the header row at the leading edge.
        // Reuses the centralized NodeIcon shape registry (single source of
        // truth for both React and D3 rendering — see Taxonomy.tsx).
        nodeG.each(function(d) {
            const type = isCluster(d) ? d.nodeType : d.node.type;
            const size = d.tier === 0 ? 13 : d.tier === 1 ? 12 : 11;
            const x = -d.cardW / 2 + 16;
            // Header y centre. Bottom meta-strip has ~11px padding from the
            // card edge (META_BOTTOM_PAD 10 + ½ of the 18-px strip minus the
            // 16-px badge); offsetting the header centre by 17 (instead of
            // the previous 16) pushes the icon top to ~11px from the top
            // edge, matching the bottom and removing the visible asymmetry
            // for tier 1/2 cards. Pivot (tier 0) keeps 18 — its 13-px icon
            // already lands at ~11.5px and the larger card masks any drift.
            const y = -d.cardH / 2 + (d.tier === 0 ? 18 : 17);
            appendNodeIconToSvg(this as SVGGElement, type, x, y, size, d.tier === 0 ? 1.6 : 1.3);
        });

        // Header name — single inline text. For Service nodes WITH a repo
        // context (monorepo or URN-derived) we render `ctx / name` via
        // tspans, mirroring the QualifiedServiceName component used in the
        // list view and search palette. The repo prefix paints in muted
        // gray so the actual node name still reads as the primary token.
        nodeG.append('text')
            .attr('x', d => -d.cardW/2 + 32)
            .attr('y', d => -d.cardH/2 + (d.tier === 0 ? 18 : 17))
            .attr('dominant-baseline','central')
            .attr('font-family','Inter,-apple-system,sans-serif')
            .attr('font-size', d => d.tier === 0 ? '13px' : d.tier === 1 ? '12px' : '11px')
            .attr('font-weight', d => d.tier === 0 ? '600' : '500')
            .attr('fill', '#fafafa')
            .attr('pointer-events','none')
            .each(function(d) {
                const text = d3.select(this);
                if (isCluster(d)) {
                    const max = d.tier === 0 ? 30 : d.tier === 1 ? 28 : 24;
                    text.text(d.label.length > max ? d.label.slice(0, max - 1) + '…' : d.label);
                    return;
                }
                const isService = d.node.type === 'Service' || d.node.type === 'Library';
                const ctx = isService ? getServiceContext(d.node as TopologyNode, d.urn) : null;
                if (ctx) {
                    const totalMax = d.tier === 0 ? 28 : d.tier === 1 ? 24 : 20;
                    const sepCost = 3;
                    const combined = ctx.length + sepCost + d.node.name.length;
                    let tCtx = ctx;
                    let tName = d.node.name;
                    if (combined > totalMax) {
                        const budget = totalMax - sepCost;
                        const nameBudget = Math.min(tName.length, Math.ceil(budget * 0.55));
                        const ctxBudget = Math.max(4, budget - nameBudget);
                        if (tCtx.length > ctxBudget) tCtx = tCtx.slice(0, ctxBudget - 1) + '…';
                        if (tName.length > nameBudget) tName = tName.slice(0, nameBudget - 1) + '…';
                    }
                    text.append('tspan').attr('fill', '#71717a').attr('font-weight', '500').text(tCtx);
                    text.append('tspan').attr('fill', '#3f3f46').attr('dx', 6).text('/');
                    text.append('tspan').attr('fill', '#fafafa').attr('dx', 6).text(tName);
                    return;
                }
                text.text(nodeName(d.node, d.tier));
            });

        // Cluster trailing count pill ("× 4") — only on supernodes.
        clusterG.append('text')
            .attr('class', 'igv-cluster-count')
            .attr('data-total', d => isCluster(d) ? d.members.length : 0)
            .attr('x', d => d.cardW/2 - 12)
            .attr('y', d => -d.cardH/2 + 17)
            .attr('text-anchor', 'end')
            .attr('dominant-baseline','central')
            .attr('font-family','Inter,-apple-system,sans-serif')
            .attr('font-size', '10.5px')
            .attr('font-weight', '500')
            .attr('fill', d => tc(isCluster(d) ? d.nodeType : d.node.type))
            .attr('pointer-events','none')
            .text(d => isCluster(d) ? `× ${d.members.length}` : '');

        // T2 multi-via "+N" pill — sits in the same top-right slot as the
        // cluster count. Tells the user "this T2 has N more bridges to the
        // pivot than the visible edge". Hover the card to reveal them.
        nodeG.filter(d => !isCluster(d) && d.tier === 2 && (t2BridgeCounts.get((d as GraphNode).urn) ?? 0) > 1)
            .append('text')
            .attr('class', 'igv-multi-via-count')
            .attr('x', d => d.cardW/2 - 12)
            .attr('y', d => -d.cardH/2 + 17)
            .attr('text-anchor', 'end')
            .attr('dominant-baseline', 'central')
            .attr('font-family', 'Inter,-apple-system,sans-serif')
            .attr('font-size', '10.5px')
            .attr('font-weight', '500')
            .attr('fill', '#a1a1aa')
            .attr('pointer-events', 'none')
            // Show extras count: distinct bridge resources minus 1 (the
            // primary visible edge), so "+N" reads as "tap to see N more".
            .text(d => `+${(t2BridgeCounts.get((d as GraphNode).urn) ?? 1) - 1}`);


        // ── Meta strip (bottom row) — Datadog-style at-a-glance signals ──
        // Layout per card:
        //   [rel-badge(s)]                                    [▮▮▮▮▯ 92%]
        // Pivot T0 keeps text-only team (left) + node type (right) since the
        // pivot has no rel-to-self and no per-target confidence.
        const ellipsize = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;
        const escapeHtml = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        // ── Meta strip: SINGLE foreignObject per card, HTML flex inside.
        //    Layout per card (justify-between):
        //      [LEFT: identity token]             [RIGHT: ● quality]
        //    Cluster:  [LEFT: tech · db]          [RIGHT: ● worst-quality]
        //    Pivot T0: [LEFT: team]               [RIGHT: ● quality]
        //    The relation toward the pivot is NOT shown here — it is already
        //    conveyed by the colour of the incoming edge (linkLine `stroke`
        //    below). Duplicating it as a rel-badge letter would be chrome.
        //    See packages/dashboard-ui/src/components/blast-radius/lib/identity-token.ts
        //    for the per-type token rules. ──
        const META_H = 18;             // strip height
        const META_INSET = 14;         // horizontal inset (matches header)
        const META_BOTTOM_PAD = 10;    // pixels above card bottom edge

        // Quality tier dot — single 6 px colored circle. Datadog / Vercel
        // restrained minimalism: no bars, no letters, no chrome. Colour
        // alone encodes the tier (green→red), tooltip surfaces label and
        // source detail. Same visual pattern as the drawer / popover so
        // the reader doesn't context-switch between views.
        //
        // Suppressed on structural labels (Service/Function/Repository/...)
        // because they're uniformly ast/exact and would always paint green
        // — drowning the decision-relevant tiers on inferred entities
        // (MessageChannel, DataContainer, APIEndpoint, ...).
        const renderQualityDotHTML = (quality: string | null | undefined, contextLabel?: string): string => {
            if (!quality || !(QUALITY_VALUES as readonly string[]).includes(quality)) return '';
            const q = quality as Quality;
            const meta = QUALITY_META[q];
            // Tooltip carries the descriptive tagline only. The dot colour
            // already encodes the tier label, so repeating "Verified" /
            // "Strong" / etc on hover would be redundant chrome.
            const tip = contextLabel
                ? `${meta.tagline} (${contextLabel})`
                : meta.tagline;
            return `<span class="cr-quality-dot" title="${escapeHtml(tip)}" style="background:${meta.color}"></span>`;
        };
        const renderQualityChipHTML = (node: TopologyNode): string => {
            if (isStructuralFamily(node.type)) return '';
            return renderQualityDotHTML(node.quality);
        };
        const buildMetaStripHTML = (d: GraphNodeOrCluster): string => {
            // Left chunk: per-type identity token (the "what is it"), the
            // signal complementary to the edge colour (the "how does it
            // relate"). The pivot follows the same rule — a Service pivot
            // shows `teamOwner || language`, an APIEndpoint pivot shows the
            // method, etc — so the meta-strip reads identically across
            // every node in the canvas regardless of tier. Cluster keeps
            // its aggregated tech·datastore so the single↔cluster rendering
            // reads as one voice.
            let leftHtml = '';
            if (isCluster(d) && (d.technology || d.datastoreName)) {
                const parts = [d.technology, d.datastoreName].filter(Boolean) as string[];
                const text = ellipsize(parts.join(' · '), 30);
                leftHtml = `<span class="cr-card-meta__tech">${escapeHtml(text)}</span>`;
            } else if (!isCluster(d)) {
                const tok = pickIdentityToken(d.node);
                const cls = tok.muted ? 'cr-card-meta__type-fallback' : 'cr-card-meta__identity';
                const text = ellipsize(tok.text, 30);
                leftHtml = `<span class="${cls}">${escapeHtml(text)}</span>`;
            }
            // Cluster with neither technology nor datastoreName: deliberately
            // blank — the trailing `× N` pill carries the aggregate cue.
            // ── Right chunk: quality tier dot. Uniform on every inferred
            //    node — single colored circle, no chrome. Clusters fall back
            //    to the worst quality of their members ("at least one
            //    speculative member" must visibly degrade the cluster). ──
            let rightHtml = '';
            if (isCluster(d)) {
                const memberQs = d.members
                    .map(m => m.node.quality)
                    .filter((q): q is string => !!q && (QUALITY_VALUES as readonly string[]).includes(q));
                if (memberQs.length > 0) {
                    const rank: Record<string, number> = { exact: 4, high: 3, medium: 2, low: 1, speculative: 0 };
                    const worst = memberQs.reduce((acc, q) => (rank[q] < rank[acc] ? q : acc), memberQs[0]);
                    rightHtml = renderQualityDotHTML(worst, 'worst in cluster');
                }
            } else {
                rightHtml = renderQualityChipHTML(d.node);
            }
            return `
                <div class="cr-card-meta">
                    <span class="cr-card-meta__left">${leftHtml}</span>
                    ${rightHtml || '<span></span>'}
                </div>
            `;
        };

        nodeG.each(function(d) {
            const html = buildMetaStripHTML(d);
            const fo = d3.select(this).append('foreignObject')
                .attr('x', -d.cardW / 2 + META_INSET)
                .attr('y', d.cardH / 2 - META_H - META_BOTTOM_PAD)
                .attr('width', d.cardW - 2 * META_INSET)
                .attr('height', META_H)
                .attr('overflow', 'visible')
                .attr('pointer-events', 'none');
            (fo.node() as SVGForeignObjectElement).innerHTML = html;
        });

        // Fit ONLY when the blast target changed (instant, no animation,
        // because the effect fires multiple times for a single target change
        // due to the hiddenTypes auto-narrowing cascade; the animated fit is
        // handled separately below via a dedicated selectedUrn effect).
        // Filter-only rebuilds (sidebar toggles, search query, clustering)
        // preserve the user's pan/zoom: d3-zoom stores the live transform on
        // the <svg> element itself (`__zoom`), which survives the
        // `selectAll('*').remove()` above, so we re-apply it to the freshly
        // built zoom layer. Layout coords are stable across these rebuilds
        // (the column grid is anchored at W/2, H/2), so surviving nodes stay
        // exactly where the user left them.
        if (lastFitUrnRef.current !== selectedUrn) {
            lastFitUrnRef.current = selectedUrn;
            fitToNodes(svgRef.current!, zoom, renderNodes as unknown as GraphNode[], W, H, false);
        } else {
            svg.call(zoom.transform, d3.zoomTransform(svgRef.current!));
        }
    }, [topology, selectedUrn, impact, hiddenTypes, hiddenRels, showT2, groupSimilar, expandedSignatures, graphQuery]);

    const handleZoom = (f: number) => {
        if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(260).call(zoomRef.current.scaleBy, f);
    };

    /** Center + zoom the viewport on a single node. Used by sidebar row
     *  click. Resolves cluster members to their cluster id automatically. */
    const centerOnNode = (urn: string) => {
        if (!svgRef.current || !wrapperRef.current || !zoomRef.current) return;
        const id = memberToClusterIdRef.current.get(urn) ?? urn;
        const pos = nodePositionsRef.current.get(id);
        if (!pos) return;
        const W = wrapperRef.current.clientWidth, H = wrapperRef.current.clientHeight;
        // Zoom level: 0.85 reads as "focused on this card with breathing
        // room around it" without losing the surrounding context entirely.
        const scale = 0.85;
        const tx = W / 2 - scale * pos.x;
        const ty = H / 2 - scale * pos.y;
        d3.select(svgRef.current)
            .transition().duration(450).ease(d3.easeCubicInOut)
            .call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    };
    const handleFit = () => {
        // Re-fit to all current node positions
        if (!svgRef.current || !wrapperRef.current || !zoomRef.current) return;
        const W = wrapperRef.current.clientWidth, H = wrapperRef.current.clientHeight;
        // Collect each card's bbox (centre + half-extent) so the fit math
        // operates on actual EDGES, not centres. Cards range 220–260 px
        // wide; computing from centres alone left them clipped against the
        // canvas border on a tight fit.
        const nodeEls = svgRef.current.querySelectorAll('.igv-node-g');
        const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
        nodeEls.forEach(el => {
            const t = (el as SVGGElement).transform.baseVal[0]?.matrix;
            if (!t) return;
            const rect = el.querySelector('rect');
            const w = rect ? Number(rect.getAttribute('width')) || 0 : 0;
            const h = rect ? Number(rect.getAttribute('height')) || 0 : 0;
            boxes.push({
                x0: t.e - w / 2, x1: t.e + w / 2,
                y0: t.f - h / 2, y1: t.f + h / 2,
            });
        });
        if (!boxes.length) { d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity); return; }
        const pad = 24;
        const x0 = Math.min(...boxes.map(b => b.x0)) - pad;
        const y0 = Math.min(...boxes.map(b => b.y0)) - pad;
        const x1 = Math.max(...boxes.map(b => b.x1)) + pad;
        const y1 = Math.max(...boxes.map(b => b.y1)) + pad;

        // When the sidebar is portaled to the explorer level, the canvas
        // width is already reduced by the flex layout. No need to reserve
        // extra space. Only reserve when the sidebar overlays the canvas
        // (no portal, e.g. small screens or collapsed mode).
        const isPortaled = !!sidebarPortalRef?.current?.children.length;
        const PANEL_W = W >= 1440 ? 360 : 320;
        const PANEL_RESERVE = isFilterOpen && !isPortaled ? PANEL_W + 16 + 8 : 0;
        const availW = Math.max(160, W - PANEL_RESERVE);

        const scale = Math.max(0.05, Math.min(0.95, Math.min(availW/(x1-x0), H/(y1-y0))));
        const tx = (availW - scale*(x0+x1))/2;
        const ty = (H - scale*(y0+y1))/2;
        d3.select(svgRef.current).transition().duration(500).call(zoomRef.current.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
    };
    // Keep the live handleFit reachable from the fullscreen-transition
    // refit effect (which fires on isFullscreen change and would otherwise
    // see a stale closure with an outdated `isFilterOpen`).
    handleFitRef.current = handleFit;

    // Auto fit-to-view when the blast target changes (e.g. "Use as blast
    // target" in the node popover). We schedule via a short timeout so the
    // call runs AFTER all cascade state updates (hiddenTypes auto-narrow,
    // sidebarQuery reset, etc.) have triggered their own D3 rebuild passes
    // and the final layout is stable. handleFit accounts for the sidebar
    // panel width, so the graph lands correctly in the visible area.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        const id = window.setTimeout(() => handleFitRef.current(), 120);
        return () => window.clearTimeout(id);
    }, [selectedUrn]);

    // The sidebar fuzzy filter is applied directly in the main build effect
    // (see `matchesQuery` in the impact loops above). Rebuilding the graph
    // on each query change is simpler and more correct than animating
    // node/edge visibility in place — the previous in-place re-stacker left
    // ghost edges connected to hidden nodes whenever a query narrowed the
    // visible set.


    return (
        <div className="igv-shell">
            <div className={`igv-canvas-wrap ${isFullscreen ? 'igv-canvas-wrap--fullscreen' : ''}`} ref={wrapperRef}>
                <svg ref={svgRef} />

                {/* Top-left: topology label (text only, no big SVG icon) */}
                <div className="igv-topology-label" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, pointerEvents: 'none' }}>
                    <div>
                        TOPOLOGY <span className="igv-topology-label__sep">·</span> 2‑HOP
                        <span className="igv-topology-label__stat">&nbsp;({activeBlasts.length + 1} nodes)</span>
                    </div>
                </div>

                {/* ── Unified command surface ──
                    When collapsed: floating pill in canvas top-right.
                    When open + portal ref: portaled to blast-explorer level for full-height sidebar.
                    When open + no portal: absolute inside canvas (fallback). */}
                {(() => {
                    const usePortal = isFilterOpen && sidebarPortalRef?.current;
                    const aside = (
                <aside
                    className={`igv-command-surface${isFilterOpen ? ' igv-command-surface--open' : ''}`}
                >
                    <div className="igv-cs__bar">
                        <SimpleTooltip content={isFilterOpen ? 'Hide filters' : 'Show filters'}>
                            <button
                                type="button"
                                className={`igv-cs__btn${isFilterOpen ? ' igv-cs__btn--active' : ''}`}
                                onClick={() => setIsFilterOpen(v => !v)}
                                aria-label={isFilterOpen ? 'Hide filters' : 'Show filters'}
                                aria-pressed={isFilterOpen}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M4 6h16M7 12h10M10 18h4" />
                                </svg>
                            </button>
                        </SimpleTooltip>
                        <SimpleTooltip content="Collapse architecturally-equivalent siblings into supernodes">
                            <label className={`igv-switch${groupSimilar ? ' igv-switch--on' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={groupSimilar}
                                    onChange={() => {
                                        const next = !groupSimilar;
                                        setGroupSimilar(next);
                                        if (!next) setExpandedClusters(new Set());
                                    }}
                                />
                                <span className="igv-switch__track" aria-hidden="true">
                                    <span className="igv-switch__thumb" />
                                </span>
                                <span className="igv-switch__label">Grouped</span>
                            </label>
                        </SimpleTooltip>
                        <div className="igv-cs__bar-group">
                            <SimpleTooltip content="Zoom in">
                                <button type="button" className="igv-cs__btn" onClick={() => handleZoom(1.38)} aria-label="Zoom in">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                                </button>
                            </SimpleTooltip>
                            <SimpleTooltip content="Zoom out">
                                <button type="button" className="igv-cs__btn" onClick={() => handleZoom(0.72)} aria-label="Zoom out">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 12h14"/></svg>
                                </button>
                            </SimpleTooltip>
                            <SimpleTooltip content="Fit to view">
                                <button type="button" className="igv-cs__btn" onClick={handleFit} aria-label="Fit to view">
                                    {/* Target / crosshair — "centre the content in the
                                        viewport". Distinct from the corner-bracket
                                        glyph used for fullscreen below. */}
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                                    </svg>
                                </button>
                            </SimpleTooltip>
                        </div>
                        <SimpleTooltip content={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}>
                            <button
                                type="button"
                                className="igv-cs__btn"
                                onClick={toggleFullscreen}
                                aria-label={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
                            >
                                {/* Diagonal-arrow glyphs for fullscreen: the "expand"
                                    motion reads as fullscreen at a glance and stays
                                    visually distinct from the "fit to view" target
                                    icon above. Mirrors lucide's Maximize2/Minimize2
                                    drawn inline so we don't pull a new dep. */}
                                {isFullscreen ? (
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="4 14 10 14 10 20" />
                                        <polyline points="20 10 14 10 14 4" />
                                        <line x1="14" y1="10" x2="21" y2="3" />
                                        <line x1="3" y1="21" x2="10" y2="14" />
                                    </svg>
                                ) : (
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="15 3 21 3 21 9" />
                                        <polyline points="9 21 3 21 3 15" />
                                        <line x1="21" y1="3" x2="14" y2="10" />
                                        <line x1="3" y1="21" x2="10" y2="14" />
                                    </svg>
                                )}
                            </button>
                        </SimpleTooltip>
                    </div>

                    {(() => {
                        const showTypeSection = uniqueTypes.length > 1 || allBlasts.some(i => i.tier === 2);
                        const visibleRels = REL_FILTER_LIST.filter(r => uniqueRels.includes(r.rel));
                        const showRelSection = visibleRels.length > 1;
                        if (!showTypeSection && !showRelSection) return null;
                        return (
                            <div className="igv-cs__filters">
                                {showTypeSection && (
                                    <div className="igv-cs__filter-section">
                                        <div className="igv-cs__filter-head">
                                            <span className="igv-cs__filter-label">Type</span>
                                            <div className="igv-cs__filter-actions">
                                                {(hiddenTypes.size > 0 || !showT2) && (
                                                    <button
                                                        type="button"
                                                        className="igv-cs__ghost-link"
                                                        onClick={() => {
                                                            setHiddenTypes(new Set());
                                                            setShowT2(true);
                                                        }}
                                                        title="Select all types"
                                                    >
                                                        all
                                                    </button>
                                                )}
                                                {(hiddenTypes.size < uniqueTypes.length || showT2) && (
                                                    <button
                                                        type="button"
                                                        className="igv-cs__ghost-link"
                                                        onClick={() => {
                                                            setHiddenTypes(new Set(uniqueTypes));
                                                            setShowT2(false);
                                                        }}
                                                        title="Deselect all types"
                                                    >
                                                        clear
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <NodeTypeFilterBar
                                            types={filterTypes}
                                            t2Count={t2Count}
                                            activeTypes={activeFilterTypes}
                                            onToggle={handleFilterToggle}
                                        />
                                    </div>
                                )}
                                {showRelSection && (
                                    <div className="igv-cs__filter-section">
                                        <div className="igv-cs__filter-head">
                                            <span className="igv-cs__filter-label">Relation</span>
                                            <div className="igv-cs__filter-actions">
                                                {hiddenRels.size > 0 && (
                                                    <button
                                                        type="button"
                                                        className="igv-cs__ghost-link"
                                                        onClick={() => setHiddenRels(new Set())}
                                                        title="Select all relations"
                                                    >
                                                        all
                                                    </button>
                                                )}
                                                {hiddenRels.size < uniqueRels.length && (
                                                    <button
                                                        type="button"
                                                        className="igv-cs__ghost-link"
                                                        onClick={() => setHiddenRels(new Set(uniqueRels))}
                                                        title="Deselect all relations"
                                                    >
                                                        clear
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="igv-cs__rel-chips">
                                            {visibleRels.map(({ rel, label }) => {
                                                const isOff = hiddenRels.has(rel);
                                                return (
                                                    <button
                                                        key={rel}
                                                        type="button"
                                                        className={`igv-cs__rel-chip${isOff ? ' igv-cs__rel-chip--off' : ''}`}
                                                        onClick={() => setHiddenRels(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(rel)) next.delete(rel);
                                                            else next.add(rel);
                                                            return next;
                                                        })}
                                                        title={label}
                                                        aria-label={label}
                                                        aria-pressed={!isOff}
                                                    >
                                                        <RelBadge rel={rel} variant="full" />
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    <div className="igv-cs__search-row">
                        <div className="igv-cs__search-field">
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4"/>
                                <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                            </svg>
                            <input
                                type="text"
                                className="igv-cs__search-input"
                                placeholder="Filter resources by name…"
                                value={sidebarQuery}
                                onChange={e => setSidebarQuery(e.target.value)}
                            />
                            {sidebarQuery && (
                                <button className="igv-cs__search-clear" onClick={() => setSidebarQuery('')} aria-label="Clear search">
                                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                </button>
                            )}
                        </div>
                    </div>

                    <SidebarList
                        activeBlasts={activeBlasts}
                        sidebarQuery={sidebarQuery}
                        svgRef={svgRef}
                        memberToClusterIdRef={memberToClusterIdRef}
                        onExplore={onExplore}
                        onOpenDrawer={onOpenDrawer}
                        onCenterNode={centerOnNode}
                    />

                    <div className="igv-cs__footer">
                        <CrButton onClick={onSwitchToList} style={{ width: '100%' }}>
                            View all {activeBlasts.length} in List View
                            <ArrowRight size={11} />
                        </CrButton>
                    </div>
                </aside>
                    );
                    return usePortal ? createPortal(aside, sidebarPortalRef.current!) : aside;
                })()}
                {/* Legend — keyed off the same RelBadge chips used in the sidebar
                    list so the symbol the user hovers in the graph is literally
                    explained at the bottom of the canvas. */}
                <div className="igv-legend">
                    {([
                        ['READS', 'Reads'],
                        ['CALLS', 'Calls'],
                        ['WRITES', 'Writes'],
                        ['PUBLISHES_TO', 'Publishes'],
                        ['LISTENS_TO', 'Subscribes'],
                        ['IMPLEMENTS_ENDPOINT', 'Implements'],
                        ['MAPS_TO', 'Defines'],
                        ['DEPENDS_ON', 'Depends'],
                    ] as const).map(([rel, label]) => {
                        const dim = activeRelColors !== null && !activeRelColors.has(getRelColor(rel));
                        return (
                            <span key={rel} className={`igv-legend-item${dim ? ' igv-legend-item--dim' : ''}`}>
                                <RelBadge rel={rel} variant="letter" />
                                <span className="igv-legend-label">{label}</span>
                            </span>
                        );
                    })}
                </div>

                {/* Click-anchored detail popover (replaces legacy hover tooltip). */}
                <NodePopover
                    target={popoverTarget}
                    onClose={() => {
                        popoverPinnedElIdRef.current = null;
                        resetHoverStateRef.current();
                        setPopoverTarget(null);
                    }}
                    onExplore={onExplore}
                    onOpenDrawer={onOpenDrawer}
                    onOpenInspector={onOpenInspector}
                    onExpandCluster={(sigKey) => {
                        setExpandedClusters(prev => {
                            const next = new Set(prev);
                            if (next.has(sigKey)) next.delete(sigKey);
                            else next.add(sigKey);
                            return next;
                        });
                    }}
                    onMemberHover={(urn) => {
                        // Reuse the sidebar bind: hover a cluster member row → highlight the supernode.
                        if (urn === null) {
                            const els = svgRef.current?.querySelectorAll(".igv-node-g") || [];
                            els.forEach(el => el.dispatchEvent(new MouseEvent("mouseleave")));
                            return;
                        }
                        const targetId = memberToClusterIdRef.current.get(urn) ?? urn;
                        const elId = `node-${targetId.replace(/[^a-zA-Z0-9]/g, "-")}`;
                        const el = svgRef.current?.querySelector(`#${elId}`);
                        el?.dispatchEvent(new MouseEvent("mouseenter"));
                    }}
                />
            </div>
        </div>
    );
}
