import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { TopologyMap, TopologyNode } from '@coderadius/shared-types';
import {
    NodeIcon,
    getNodeTypeColor,
    getHttpMethodMeta,
    HttpMethodBadge,
    TechBadge,
    ChannelKindBadge,
} from '../../Taxonomy';
import { TaggedSearch } from '../../TaggedSearch';
import type { SearchScope, TaggedSearchState, TaggedSearchHandle } from '../../TaggedSearch';
import { useServiceQualifier } from '../hooks/MultiServiceReposContext';
import { QualifiedServiceName } from '../utils/qualified-name';
import { fuzzyMatch, highlightMatches } from '../../../lib/fuzzy-match';
import { MiddleEllipsis } from '../../MiddleEllipsis';
import type { FuzzyMatchResult } from '../../../lib/fuzzy-match';

/** Canonical display order for node-type groups in search results. */
const TYPE_ORDER: Record<string, number> = {
    Service: 0,
    APIEndpoint: 1,
    DataContainer: 2,
    MessageChannel: 3,
};
const typeOrderOf = (t: string) => TYPE_ORDER[t] ?? 99;

export interface SearchBarProps {
    topology: TopologyMap;
    selectedUrn: string | null;
    onSelect: (urn: string | null) => void;
    autoFocus?: boolean;
    placeholder?: string;
    onQueryChange?: (query: string) => void;
}

/** Build scopes from the distinct node types in the topology */
function useTopologyScopes(topology: TopologyMap): SearchScope[] {
    return useMemo(() => {
        const types = new Set(Object.values(topology.nodes).map(n => n.type));
        return Array.from(types).sort().map(type => ({
            key: type.toLowerCase(),
            label: type,
            color: getNodeTypeColor(type),
            icon: <NodeIcon type={type} size={10} />,
        }));
    }, [topology]);
}

export interface SearchBarHandle {
    focus: () => void;
}

export const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar({ topology, selectedUrn, onSelect, autoFocus, placeholder, onQueryChange }, ref) {
    const qualifier = useServiceQualifier();
    const scopes = useTopologyScopes(topology);
    const [searchState, setSearchState] = useState<TaggedSearchState>({ query: '', activeScope: null, scopeValue: null });

    useEffect(() => {
        onQueryChange?.(searchState.query);
    }, [searchState.query, onQueryChange]);
    const searchRef = useRef<TaggedSearchHandle>(null);
    const [highlightIdx, setHighlightIdx] = useState(-1);

    useImperativeHandle(ref, () => ({
        focus() { searchRef.current?.focus(); },
    }), []);

    // When the blast target changes (e.g. via "Explore" on a different node type),
    // clear any active scope filter — it belongs to the previous search session.
    useEffect(() => {
        searchRef.current?.clearScope();
    }, [selectedUrn]);

    // Filtered + grouped results — uses fuzzy matching for smart partial text search
    const results = useMemo(() => {
        const { query, activeScope } = searchState;
        if (!query.trim() && !activeScope) return [];
        const q = query.trim();
        const typeFilter = activeScope?.label ?? null;
        const out: Array<{ urn: string; node: TopologyNode; nameMatch: FuzzyMatchResult | null; urnMatch: FuzzyMatchResult | null }> = [];
        for (const [urn, node] of Object.entries(topology.nodes)) {
            if (typeFilter && node.type !== typeFilter) continue;
            if (q) {
                const nameMatch = fuzzyMatch(q, node.name);
                const urnMatch = !nameMatch ? fuzzyMatch(q, urn) : null;
                if (!nameMatch && !urnMatch) continue;
                out.push({ urn, node, nameMatch, urnMatch });
            } else {
                out.push({ urn, node, nameMatch: null, urnMatch: null });
            }
            if (out.length >= 50) break;
        }
        // Sort by best match score (highest first)
        if (q) {
            out.sort((a, b) => {
                const scoreA = Math.max(a.nameMatch?.score ?? 0, a.urnMatch?.score ?? 0);
                const scoreB = Math.max(b.nameMatch?.score ?? 0, b.urnMatch?.score ?? 0);
                return scoreB - scoreA;
            });
        }
        return out;
    }, [topology, searchState]);

    // Flat list for keyboard navigation (same order as rendered)
    const flatResults = useMemo(() => {
        const groups: Record<string, typeof results> = {};
        for (const r of results) {
            const t = r.node.type;
            if (!groups[t]) groups[t] = [];
            groups[t].push(r);
        }
        const sorted = Object.entries(groups).sort((a, b) => typeOrderOf(a[0]) - typeOrderOf(b[0]));
        return sorted.flatMap(([, items]) => items);
    }, [results]);

    const groupedResults = useMemo(() => {
        const groups: Record<string, typeof results> = {};
        for (const r of results) {
            const t = r.node.type;
            if (!groups[t]) groups[t] = [];
            groups[t].push(r);
        }
        return Object.entries(groups).sort((a, b) => typeOrderOf(a[0]) - typeOrderOf(b[0]));
    }, [results]);

    // Reset highlight when results change
    useEffect(() => { setHighlightIdx(-1); }, [flatResults]);

    const stats = useMemo(() => {
        const nodeCount = Object.keys(topology.nodes).length;
        const edgeCount = Object.values(topology.out).reduce((sum, edges) => sum + edges.length, 0);
        const types = new Set(Object.values(topology.nodes).map(n => n.type));
        return { nodeCount, edgeCount, typeCount: types.size };
    }, [topology]);

    /**
     * Precomputed map: APIEndpoint URN → name of the Service that IMPLEMENTS_ENDPOINT it.
     * Scanned once per topology change from the outgoing edge index.
     */
    const apiExposerMap = useMemo(() => {
        const map = new Map<string, string>();
        for (const [sourceUrn, edges] of Object.entries(topology.out)) {
            for (const edge of edges) {
                if (edge.rel === 'IMPLEMENTS_ENDPOINT') {
                    const sourceNode = topology.nodes[sourceUrn];
                    if (sourceNode) map.set(edge.target, sourceNode.name);
                }
            }
        }
        return map;
    }, [topology]);

    const selectedNode = selectedUrn ? topology.nodes[selectedUrn] : null;

    function handleSelect(urn: string) {
        onSelect(urn);
        searchRef.current?.reset();
    }

    const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (flatResults.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIdx(prev => (prev + 1) % flatResults.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIdx(prev => (prev <= 0 ? flatResults.length - 1 : prev - 1));
        } else if (e.key === 'Enter' && highlightIdx >= 0 && highlightIdx < flatResults.length) {
            e.preventDefault();
            handleSelect(flatResults[highlightIdx].urn);
        }
    }, [flatResults, highlightIdx]);

    return (
        <TaggedSearch
            ref={searchRef}
            scopes={scopes}
            placeholder={placeholder ?? "Search any service, table, queue…"}
            inputId="blast-search-input"
            autoFocus={autoFocus}
            onSearch={setSearchState}
            onInputKeyDown={handleInputKeyDown}
            showClear={!!selectedUrn}
            onClear={() => onSelect(null)}
            selectedBadge={selectedNode ? (
                <span className="blast-search__selected-badge">
                    {selectedNode.type === 'APIEndpoint' ? (() => {
                        const hm = getHttpMethodMeta(selectedNode.name, selectedNode.apiKind, selectedNode.operation);
                        return (hm.method || hm.techFlavor) ? (
                            <>
                                <NodeIcon type={selectedNode.type} size={11} />
                                {hm.method && !hm.techFlavor && <HttpMethodBadge method={hm.method} color={hm.color} bgColor={hm.bgColor} borderColor={hm.borderColor} size="sm" />}
                                {hm.techFlavor && <TechBadge flavor={hm.techFlavor} subtype={hm.techSubtype} size="sm" />}
                                <MiddleEllipsis text={hm.path} />
                            </>
                        ) : <><NodeIcon type={selectedNode.type} size={11} /><MiddleEllipsis text={selectedNode.name} /></>;
                    })() : selectedNode.type === 'MessageChannel' && selectedNode.channelKind ? (
                        <>
                            <NodeIcon type={selectedNode.type} size={11} />
                            <ChannelKindBadge kind={selectedNode.channelKind} size="sm" />
                            <MiddleEllipsis text={selectedNode.name} />
                        </>
                    ) : (
                        <QualifiedServiceName node={selectedNode} urn={selectedUrn!} size={11} />
                    )}
                </span>
            ) : undefined}
            renderResults={({ close }) => {
                const hasQuery = searchState.query.length > 0 || searchState.activeScope !== null;
                if (!hasQuery) return null;
                if (results.length === 0) {
                    return <div className="blast-search__no-results">No nodes match "{searchState.query}"</div>;
                }
                // Build a running index across groups for keyboard highlight
                let runningIdx = 0;
                return (
                    <div className="blast-search__results">
                        {groupedResults.map(([type, items]) => {
                            const groupStartIdx = runningIdx;
                            const groupJsx = (
                                <div key={type} className="blast-search__group">
                                    <div className="blast-search__group-header">
                                        <NodeIcon type={type} size={10} />
                                        <span>{type}</span>
                                        <span className="blast-search__group-count">{items.length}</span>
                                    </div>
                                    {items.map(({ urn, node, nameMatch }, i) => {
                                        const idx = groupStartIdx + i;
                                        const isHighlighted = idx === highlightIdx;
                                        const nameRanges = nameMatch?.ranges;
                                        return (
                                            <div
                                                key={urn}
                                                className={`blast-search__option ${urn === selectedUrn ? 'blast-search__option--active' : ''} ${isHighlighted ? 'blast-search__option--highlight' : ''}`}
                                                role="option"
                                                aria-selected={urn === selectedUrn}
                                                onMouseDown={() => { handleSelect(urn); close(); }}
                                                onMouseEnter={() => setHighlightIdx(idx)}
                                                ref={el => { if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' }); }}
                                            >
                                                {node.type === 'APIEndpoint' ? (() => {
                                                    const hm = getHttpMethodMeta(node.name, node.apiKind, node.operation);
                                                    return (hm.method || hm.techFlavor) ? (
                                                        <span className="blast-search__option-name blast-search__option-name--api">
                                                            <NodeIcon type={node.type} size={10} />
                                                            {hm.method && !hm.techFlavor && <HttpMethodBadge method={hm.method} color={hm.color} bgColor={hm.bgColor} borderColor={hm.borderColor} size="sm" />}
                                                            {hm.techFlavor && <TechBadge flavor={hm.techFlavor} subtype={hm.techSubtype} size="sm" />}
                                                            <span>{nameRanges ? highlightMatches(hm.path, nameRanges) : hm.path}</span>
                                                        </span>
                                                    ) : <span className="blast-search__option-name"><NodeIcon type={node.type} size={10} />{nameRanges ? highlightMatches(node.name, nameRanges) : node.name}</span>;
                                                })() : node.type === 'MessageChannel' && node.channelKind ? (
                                                    <span className="blast-search__option-name blast-search__option-name--api">
                                                        <ChannelKindBadge kind={node.channelKind} size="sm" />
                                                        <span>{nameRanges ? highlightMatches(node.name, nameRanges) : node.name}</span>
                                                    </span>
                                                ) : (
                                                    <span className="blast-search__option-name">
                                                        {(() => {
                                                            const q = qualifier(node, urn);
                                                            return q ? (
                                                                <>
                                                                    <span className="cr-qualified__context">{q}</span>
                                                                    <span className="cr-qualified__sep">/</span>
                                                                    {nameRanges ? highlightMatches(node.name, nameRanges) : node.name}
                                                                </>
                                                            ) : (nameRanges ? highlightMatches(node.name, nameRanges) : node.name);
                                                        })()}
                                                    </span>
                                                )}
                                                {node.type === 'APIEndpoint' && apiExposerMap.get(urn) ? (
                                                    <span className="blast-search__option-exposer">
                                                        {apiExposerMap.get(urn)}
                                                    </span>
                                                ) : node.type === 'DataContainer' && node.datastore?.[0]?.name ? (
                                                    <span className="blast-search__option-team" style={{ opacity: 0.55 }}>
                                                        {node.datastore[0].name}{node.datastore.length > 1 ? ` +${node.datastore.length - 1}` : ''}
                                                    </span>
                                                ) : node.teamOwner ? (
                                                    <span className="blast-search__option-team">{node.teamOwner}</span>
                                                ) : (!node.repository && node.type === 'Service' && urn.split(':').length >= 3) ? (
                                                    <span className="blast-search__option-team" style={{ opacity: 0.6, fontStyle: 'italic' }}>
                                                        {urn.split(':')[2]}
                                                    </span>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                            runningIdx += items.length;
                            return groupJsx;
                        })}
                    </div>
                );
            }}
            renderFooter={() => (
                <div className="blast-search__footer">
                    <span>{stats.nodeCount} nodes</span>
                    <span className="blast-search__footer-dot">·</span>
                    <span>{stats.edgeCount} edges</span>
                    <span className="blast-search__footer-dot">·</span>
                    <span>{stats.typeCount} types</span>
                </div>
            )}
        />
    );
});
