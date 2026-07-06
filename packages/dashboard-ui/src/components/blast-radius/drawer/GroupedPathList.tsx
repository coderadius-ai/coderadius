import type { TopologyNode } from '@coderadius/shared-types';
import { NodeIcon, getHttpMethodMeta, HttpMethodBadge, TechBadge, RelBadge, sortRels } from '../../Taxonomy';
import type { PathGroup } from '../utils/path-aggregation';
import { PathPreviewGraph } from './PathPreviewGraph';
import { MiddleEllipsis } from '../../MiddleEllipsis';

/** A single grouped row. Whole row is the only click target. */
function GroupedPathRow({
    group,
    selected,
    onClick,
}: {
    group: PathGroup;
    selected: boolean;
    onClick: () => void;
}) {
    const apiMeta = group.via?.node.type === 'APIEndpoint' ? getHttpMethodMeta(group.via.node.name, group.via.node.apiKind, group.via.node.operation) : null;
    const isDirect = !group.via;
    // For row chips we show the *union* of rels in both directions, deduped —
    // gives a glanceable summary. Per-direction breakdown lives in Functions.
    const allRelsRaw: string[] = [];
    for (const r of group.sourceRels) if (!allRelsRaw.includes(r)) allRelsRaw.push(r);
    for (const r of group.targetRels) if (!allRelsRaw.includes(r)) allRelsRaw.push(r);
    const allRels = sortRels(allRelsRaw);

    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                borderRadius: '6px',
                border: `1px solid ${selected ? 'var(--cr-line-1)' : 'transparent'}`,
                background: selected ? 'var(--cr-bg-3)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 120ms ease, border-color 120ms ease',
                minHeight: '34px',
            }}
            onMouseEnter={(e) => {
                if (!selected) e.currentTarget.style.background = 'var(--cr-bg-2)';
            }}
            onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.background = 'transparent';
            }}
        >
            {/* Selection dot — fills when active. */}
            <span
                aria-hidden="true"
                style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: selected ? 'var(--cr-signal)' : 'transparent',
                    border: `1.5px solid ${selected ? 'var(--cr-signal)' : 'var(--cr-line-1)'}`,
                    boxSizing: 'border-box',
                }}
            />

            {/* Via node (or 'direct' label for 1-hop). */}
            {isDirect ? (
                <span style={{
                    fontSize: '11px',
                    fontStyle: 'italic',
                    color: 'var(--cr-ink-2)',
                    flexShrink: 0,
                }}>
                    direct
                </span>
            ) : (
                <span
                    title={group.via!.urn}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        fontSize: '12px',
                        fontWeight: 500,
                        color: 'var(--cr-ink-0)',
                        minWidth: 0,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        flex: '1 1 auto',
                    }}
                >
                    <NodeIcon type={group.via!.node.type} size={11} />
                    {apiMeta && (apiMeta.method || apiMeta.techFlavor) ? (
                        <>
                            {apiMeta.method && !apiMeta.techFlavor && (
                                <HttpMethodBadge
                                    method={apiMeta.method}
                                    color={apiMeta.color}
                                    bgColor={apiMeta.bgColor}
                                    borderColor={apiMeta.borderColor}
                                    size="sm"
                                />
                            )}
                            {apiMeta.techFlavor && <TechBadge flavor={apiMeta.techFlavor} subtype={apiMeta.techSubtype} />}
                            <MiddleEllipsis text={apiMeta.path} />
                        </>
                    ) : (
                        <MiddleEllipsis text={group.via!.node.name} />
                    )}
                </span>
            )}

            {/* Rel letter chips (visual summary, NOT clickable). Tooltips carry the
                full rel name. Compact-letter form keeps row width predictable. */}
            <span style={{ display: 'inline-flex', gap: '3px', flexShrink: 0, marginLeft: isDirect ? 'auto' : '8px' }}>
                {allRels.map((r, i) => (
                    <RelBadge key={`${r}-${i}`} rel={r} variant="letter" />
                ))}
            </span>

            {/* bindingReason chip — only for STORED_IN legs where the binding
                resolution is explicit (sole-candidate, p0-yaml, llm-assignment,
                env-canonical-default). Sits next to the rel chips so the
                operator can tell grounded vs inferred bindings at a glance. */}
            {(group.sourceBindingReason || group.targetBindingReason) && allRels.includes('STORED_IN') && (
                <span
                    title={`STORED_IN binding: ${group.sourceBindingReason ?? group.targetBindingReason}`}
                    style={{
                        flexShrink: 0,
                        marginLeft: '4px',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        border: '1px solid var(--cr-line-0)',
                        color: 'var(--cr-ink-2)',
                        fontSize: 'var(--cr-type-micro)',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'default',
                    }}
                >
                    {group.sourceBindingReason ?? group.targetBindingReason}
                </span>
            )}

            {/* Path count — only when this group collapses more than one underlying path. */}
            {group.paths.length > 1 && (
                <span style={{
                    flexShrink: 0,
                    fontSize: '10px',
                    fontWeight: 600,
                    color: 'var(--cr-ink-2)',
                    minWidth: '14px',
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                }}>
                    {group.paths.length}
                </span>
            )}
        </button>
    );
}

/**
 * Vertical list of grouped paths. One row per unique `via` (or one row for
 * the `__direct__` group), preceded by a single static `[source] → [target]`
 * header. Click a row to select; downstream Schema and Functions panels in
 * the drawer follow the selected group.
 */
export function GroupedPathList({
    groups,
    selectedKey,
    selectedGroup,
    onSelect,
    selectedNode,
    selectedUrn,
    targetNode,
    targetUrn,
    qualifier,
}: {
    groups: PathGroup[];
    selectedKey: string | null;
    /** The currently selected group — drives the live preview graph above. */
    selectedGroup: PathGroup | null;
    onSelect: (key: string) => void;
    selectedNode: TopologyNode;
    selectedUrn: string;
    targetNode: TopologyNode;
    targetUrn: string;
    qualifier: (n: TopologyNode, urn: string) => string | null;
}) {
    if (groups.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
            <PathPreviewGraph
                group={selectedGroup}
                selectedNode={selectedNode}
                selectedUrn={selectedUrn}
                targetNode={targetNode}
                targetUrn={targetUrn}
                qualifier={qualifier}
            />
            {groups.length > 1 && groups.map(g => (
                <GroupedPathRow
                    key={g.key}
                    group={g}
                    selected={g.key === selectedKey}
                    onClick={() => onSelect(g.key)}
                />
            ))}
        </div>
    );
}
