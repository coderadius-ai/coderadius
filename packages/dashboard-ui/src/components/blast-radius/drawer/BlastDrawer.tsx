import { useEffect, useMemo, useState } from 'react';
// Crosshair removed — using custom concentric-circles target icon instead
import type { TopologyMap, TopologyNode, TopologySchema } from '@coderadius/shared-types';
import { CrButton, MetadataGrid } from '../../design-system';
import type { TieredBlastNode } from '../../../lib/topology';
import { getAllPaths } from '../../../lib/topology';
import {
    NodeIcon,
    getHttpMethodMeta,
    HttpMethodBadge,
    TechBadge,
    ChannelKindBadge,
} from '../../Taxonomy';
import { GroundingSection } from '../../Grounding';
import { isStructuralFamily, QUALITY_VALUES, type Quality } from '../../../types/grounding';
import { DrawerShell } from '../../DrawerShell';
import { useServiceQualifier } from '../hooks/MultiServiceReposContext';
import { MiddleEllipsis } from '../../MiddleEllipsis';
import { buildOverviewItems } from '../NodeOverview';
import { edgeCensus } from '../lib/edge-census';
import { groupPaths, aggregateFunctions, type PathGroup } from '../utils/path-aggregation';
import { FunctionItem } from './FunctionItem';
import { EventSchemaPanel } from './EventSchemaPanel';
import { RelLegend } from './RelLegend';

import { GroupedPathList } from './GroupedPathList';
import { CopyUrnButton } from '../inspector/NodeInspectorModal';

/**
 * Side drawer that opens when the user clicks an impact card. Orchestrates the
 * children: header + shared Overview metadata grid (NodeOverview.tsx),
 * data-quality section, grouped path list with preview graph, schema panels,
 * and the per-function "Code Evidence" tabs.
 */
export function BlastDrawer({
    item,
    selectedNode,
    selectedUrn,
    topology,
    schemas,
    onClose,
    onExplore,
}: {
    item: TieredBlastNode;
    selectedNode: TopologyNode;
    selectedUrn: string;
    topology: TopologyMap;
    schemas?: Record<string, TopologySchema[]>;
    onClose: () => void;
    onExplore: (urn: string) => void;
}) {
    const { node, urn, rel, tier, via } = item;
    const qualifier = useServiceQualifier();

    // Discover ALL paths between blast target and this node
    const allPaths = useMemo(
        () => getAllPaths(topology, selectedUrn, urn),
        [topology, selectedUrn, urn],
    );

    // Group paths by intermediate `via.urn`. When `getAllPaths` returns nothing
    // (rare — e.g. tier-2 fallback from TieredBlastNode) we synthesise a single
    // group from the item's own `rel`/`via` fields so the drawer still renders.
    const groups = useMemo<PathGroup[]>(() => {
        if (allPaths.length > 0) return groupPaths(allPaths);
        // TieredBlastNode fallback path lacks per-step direction info; assume
        // forward (matches the historical rendering before direction tracking).
        if (tier === 2 && via) {
            return groupPaths([{
                rels: [via.rel, rel],
                relsReversed: [false, false],
                via: { urn: via.urn, node: via.node },
                sourceFunctions: via.functions,
            }]);
        }
        return groupPaths([{ rels: [rel], relsReversed: [false] }]);
    }, [allPaths, tier, via, rel]);

    const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
    /** Functions section tab. `null` = no choice yet (auto-pick first available). */
    const [activeFnTab, setActiveFnTab] = useState<'source' | 'target' | null>(null);

    // Reset selection when the drawer subject changes; default to first group.
    useEffect(() => {
        setSelectedGroupKey(groups[0]?.key ?? null);
        setActiveFnTab(null);
    }, [urn, groups]);

    const selectedGroup = groups.find(g => g.key === selectedGroupKey) ?? groups[0] ?? null;

    const overviewItems = buildOverviewItems(node, edgeCensus(topology, urn));
    const legendRels = useMemo(
        () => groups.flatMap(g => [...g.sourceRels, ...g.targetRels]),
        [groups],
    );

    const footerContent = (
        <CrButton
            variant="secondary"
            icon={<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7" cy="7" r="5.5" /><circle cx="7" cy="7" r="2.5" /><circle cx="7" cy="7" r="0.6" fill="currentColor" /></svg>}
            onClick={() => { onExplore(urn); onClose(); }}
        >Use as blast target</CrButton>
    );

    return (
        <DrawerShell
            ariaLabel={`Details for ${node.name}`}
            onClose={onClose}
            footer={footerContent}
        >

                {/* Header */}
                <div className="blast-drawer__header">
                    <NodeIcon type={node.type} size={20} />
                    {node.type === 'APIEndpoint' ? (
                        <h3 className="blast-drawer__name blast-drawer__name--api">
                            {(() => {
                                const hm = getHttpMethodMeta(node.name, node.apiKind, node.operation);
                                return (hm.method || hm.techFlavor) ? (
                                    <>
                                        {hm.method && !hm.techFlavor && <HttpMethodBadge method={hm.method} color={hm.color} bgColor={hm.bgColor} borderColor={hm.borderColor} size="md" />}
                                        {hm.techFlavor && <TechBadge flavor={hm.techFlavor} subtype={hm.techSubtype} size="md" />}
                                        <MiddleEllipsis text={hm.path} />
                                    </>
                                ) : (
                                    <MiddleEllipsis text={node.name} />
                                );
                            })()}
                        </h3>
                    ) : node.channelKind ? (
                        <h3 className="blast-drawer__name blast-drawer__name--api">
                            <ChannelKindBadge kind={node.channelKind} size="md" />
                            <MiddleEllipsis text={node.name} />
                        </h3>
                    ) : (
                        <h3 className="blast-drawer__name">
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
                        </h3>
                    )}
                </div>

                <div className="blast-drawer__urn-row">
                    <MiddleEllipsis text={urn} className="blast-drawer__urn" />
                    <CopyUrnButton urn={urn} />
                </div>

                {node.description && (
                    <p className="cr-node-description">{node.description}</p>
                )}

                {/* Overview: ownership + infrastructure + edge census, shared
                    row-for-row with the NodeInspectorModal (NodeOverview.tsx). */}
                {overviewItems.length > 0 && (
                    <div className="blast-drawer__section">
                        <span className="blast-drawer__section-label">Overview</span>
                        <MetadataGrid items={overviewItems} columns="responsive" className="cr-meta-grid--rail" />
                    </div>
                )}

                {/* Grounding: drawer always renders this for inferred labels.
                    Structural labels (Service, SourceFile, Function, ...) are
                    uniformly ast/exact and suppressed here so the section
                    doesn't add noise on every node. The component owns its
                    own label + always-visible tier headline + structured
                    provenance grid (see components/Grounding.tsx). */}
                {node.quality && QUALITY_VALUES.includes(node.quality as Quality) && !isStructuralFamily(node.type) && (
                    <div className="blast-drawer__section">
                        <GroundingSection node={node} repoUrl={node.repository?.url} />
                    </div>
                )}

                <div className="blast-drawer__section">
                    <div className="blast-drawer__section-header">
                        <span className="blast-drawer__section-label">
                            Relationships
                            {groups.length > 1 && (
                                <span className="blast-drawer__section-count">
                                    {groups.length}
                                </span>
                            )}
                        </span>
                        <RelLegend rels={legendRels} />
                    </div>

                    <GroupedPathList
                        groups={groups}
                        selectedKey={selectedGroupKey}
                        selectedGroup={selectedGroup}
                        onSelect={setSelectedGroupKey}
                        selectedNode={selectedNode}
                        selectedUrn={selectedUrn}
                        targetNode={node}
                        targetUrn={urn}
                        qualifier={qualifier}
                    />
                </div>


                {/* Data Schema. Render schemas attached to any node that participates
                    in the relation being inspected:
                      - the drawer subject (`urn`),
                      - the blast target (`selectedUrn`) — schema-carrying targets like
                        DataContainer/MessageChannel/APIEndpoint live here on direct
                        1-hop relations, where the drawer subject is the consumer,
                      - the selected group's intermediate `via` node (2-hop paths).
                    APIEndpoints can carry both request and response payloads, so we
                    render one panel per schema and dedup by (urn, name, role). */}
                {(() => {
                    const viaUrn = selectedGroup?.via?.urn ?? null;
                    const viaNode = selectedGroup?.via?.node ?? null;

                    const candidates: Array<{ urn: string; node: TopologyNode }> = [];
                    candidates.push({ urn, node });
                    if (selectedUrn !== urn) candidates.push({ urn: selectedUrn, node: selectedNode });
                    if (viaUrn && viaNode && viaUrn !== urn && viaUrn !== selectedUrn) {
                        candidates.push({ urn: viaUrn, node: viaNode });
                    }

                    const seen = new Set<string>();
                    return candidates.flatMap(({ urn: candUrn, node: candNode }) =>
                        (schemas?.[candUrn] ?? []).map((schema, idx) => {
                            const key = `${candUrn}::${schema.name}::${schema.role ?? ''}::${idx}`;
                            if (seen.has(key)) return null;
                            seen.add(key);
                            return (
                                <EventSchemaPanel
                                    key={key}
                                    schema={schema}
                                    repoUrl={candNode.repository?.url}
                                />
                            );
                        }),
                    );
                })()}
                {/* Functions — one tab per side that has functions in the selected
                    group. Each function row shows the rel letter badges it actually
                    participates in (e.g. a function that both READS and WRITES a
                    table gets [R][W] beside its name). */}
                {selectedGroup && (() => {
                    const sourceFunctions = aggregateFunctions(selectedGroup.paths, 'source');
                    const targetFunctions = aggregateFunctions(selectedGroup.paths, 'target');
                    const hasSource = sourceFunctions.length > 0;
                    const hasTarget = targetFunctions.length > 0;
                    if (!hasSource && !hasTarget) return null;

                    const effectiveTab: 'source' | 'target' =
                        activeFnTab === 'source' && hasSource ? 'source'
                        : activeFnTab === 'target' && hasTarget ? 'target'
                        : hasSource ? 'source' : 'target';

                    const tabs: Array<{ key: 'source' | 'target'; node: TopologyNode; count: number }> = [];
                    if (hasSource) tabs.push({ key: 'source', node: selectedNode, count: sourceFunctions.length });
                    if (hasTarget) tabs.push({ key: 'target', node: node,         count: targetFunctions.length });

                    const showTabs = tabs.length > 1;

                    const activeFns = effectiveTab === 'source' ? sourceFunctions : targetFunctions;
                    const activeNode = effectiveTab === 'source' ? selectedNode : node;

                    return (
                        <div className="blast-drawer__section blast-drawer__section--functions">
                            <span className="blast-drawer__section-label">Code Evidence</span>

                            {showTabs && (
                                <div role="tablist" className="blast-drawer__fn-tabs">
                                    {tabs.map(t => (
                                        <button
                                            key={t.key}
                                            type="button"
                                            role="tab"
                                            aria-selected={t.key === effectiveTab}
                                            aria-controls="blast-drawer-fn-panel"
                                            className={`blast-drawer__fn-tab${t.key === effectiveTab ? ' blast-drawer__fn-tab--active' : ''}`}
                                            onClick={() => setActiveFnTab(t.key)}
                                        >
                                            <NodeIcon type={t.node.type} size={11} />
                                            <span className="blast-drawer__fn-tab-name">{t.node.name}</span>
                                            <span className="blast-drawer__fn-tab-count">{t.count}</span>
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div id="blast-drawer-fn-panel" role="tabpanel" className="blast-drawer__func-scroll-area">
                                <div className="blast-drawer__func-group">
                                    {!showTabs && (
                                        <div className="blast-drawer__func-group-header">
                                            <NodeIcon type={activeNode.type} size={10} />
                                            <span className="blast-drawer__func-group-title">{activeNode.name}</span>
                                        </div>
                                    )}
                                    <ul className="blast-drawer__func-list">
                                        {activeFns.map(({ fn, rels }, idx) => (
                                            <FunctionItem
                                                key={`${effectiveTab}-${idx}-${fn.name}`}
                                                f={fn}
                                                node={activeNode}
                                                rels={rels}
                                            />
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    );
                })()}

        </DrawerShell>
    );
}

/* GroundingSection + ProvenanceRow used to live here. They've moved to
 * components/Grounding.tsx so the drawer, the inspector modal, and any
 * future surface that exposes provenance render the section identically.
 * The legacy local versions were deleted intentionally; do NOT re-add
 * surface-specific copies here, extend the shared component instead. */
