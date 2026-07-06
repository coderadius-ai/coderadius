import type { TopologyNode } from '@coderadius/shared-types';
import { NodeIcon, getNodeTypeColor, getHttpMethodMeta, HttpMethodBadge, TechBadge, RelBadge } from '../../Taxonomy';
import type { PathGroup, SegmentDirection } from '../utils/path-aggregation';

/** Node pill used inside the live preview graph above the navigator list. */
function PathPreviewPill({
    node,
    urn,
    context,
    emphasized = false,
}: {
    node: TopologyNode;
    urn: string;
    context: string | null;
    /** True for the via (intermediate) node — slightly stronger styling. */
    emphasized?: boolean;
}) {
    const apiMeta = node.type === 'APIEndpoint' ? getHttpMethodMeta(node.name, node.apiKind, node.operation) : null;
    const typeColor = getNodeTypeColor(node.type);
    return (
        <span
            title={urn}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 8px',
                borderRadius: '5px',
                background: emphasized
                    ? `color-mix(in srgb, ${typeColor} 10%, var(--cr-bg-3))`
                    : 'var(--cr-bg-3)',
                border: emphasized
                    ? `1px solid color-mix(in srgb, ${typeColor} 40%, transparent)`
                    : '1px solid var(--cr-line-1)',
                fontSize: '11px',
                fontWeight: 500,
                color: 'var(--cr-ink-0)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 1,
                minWidth: 0,
                maxWidth: '40%',
            }}
        >
            <NodeIcon type={node.type} size={10} />
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
                    <span className="cr-mid-ellipsis">
                        <span className="cr-mid-ellipsis__head">{apiMeta.path}</span>
                    </span>
                </>
            ) : (
                <span className="cr-mid-ellipsis" style={{ overflow: 'hidden' }}>
                    {context ? (
                        <>
                            <span className="cr-mid-ellipsis__head">
                                <span className="cr-qualified__context">{context}</span>
                                <span className="cr-qualified__sep">/</span>
                            </span>
                            <span className="cr-mid-ellipsis__tail">{node.name}</span>
                        </>
                    ) : (
                        <span className="cr-mid-ellipsis__head">{node.name}</span>
                    )}
                </span>
            )}
        </span>
    );
}

/**
 * Connector between two nodes in the preview graph, with direction-aware
 * arrowhead. Layout: a flex row with two `flex:1` line spacers on either side
 * of the rel badge cluster.
 */
function PathPreviewSegment({
    rels,
    direction,
    bindingReason,
}: {
    rels: string[];
    direction: SegmentDirection;
    /** STORED_IN binding resolution for this leg ('p0-yaml', 'sole-candidate',
     *  ...). Rendered as a small mono chip so the operator can tell grounded
     *  vs inferred bindings even when there is a single path group (the
     *  navigator rows, which also carry the chip, only render at 2+ groups). */
    bindingReason?: string | null;
}) {
    const line = (
        <span style={{
            flex: '1 1 auto',
            height: '1px',
            background: 'currentColor',
            opacity: 0.35,
            minWidth: '6px',
        }} />
    );
    const head = (
        <svg
            aria-hidden="true"
            width="7"
            height="7"
            viewBox="0 0 10 10"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.6 }}
        >
            <path
                d="M2 1l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
    const headLeft = (
        <span style={{ flexShrink: 0, transform: 'scaleX(-1)', display: 'inline-flex' }}>{head}</span>
    );
    const showLeft  = direction === 'reversed' || direction === 'mixed';
    const showRight = direction === 'forward'  || direction === 'mixed';

    return (
        <span
            aria-hidden="true"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                flex: '1 1 0',
                minWidth: '56px',
                height: '20px',
                color: 'var(--cr-ink-3)',
            }}
        >
            {showLeft && headLeft}
            {line}
            {rels.length > 0 && (
                <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    flexShrink: 0,
                }}>
                    {rels.map((r, i) => (
                        <RelBadge key={`${r}-${i}`} rel={r} variant="letter" />
                    ))}
                    {bindingReason && rels.includes('STORED_IN') && (
                        <span
                            title={`STORED_IN binding: ${bindingReason}`}
                            style={{
                                padding: '1px 5px',
                                borderRadius: '4px',
                                border: '1px solid var(--cr-line-0)',
                                color: 'var(--cr-ink-2)',
                                fontSize: 'var(--cr-type-micro)',
                                fontFamily: 'var(--font-mono)',
                                cursor: 'default',
                            }}
                        >
                            {bindingReason}
                        </span>
                    )}
                </span>
            )}
            {line}
            {showRight && head}
        </span>
    );
}

/**
 * Live preview of the currently selected path: `[source] ─rels─ [via?] ─rels─ [target]`.
 * Sits above the navigator list and re-renders on selection change.
 */
export function PathPreviewGraph({
    group,
    selectedNode,
    selectedUrn,
    targetNode,
    targetUrn,
    qualifier,
}: {
    group: PathGroup | null;
    selectedNode: TopologyNode;
    selectedUrn: string;
    targetNode: TopologyNode;
    targetUrn: string;
    qualifier: (n: TopologyNode, urn: string) => string | null;
}) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '8px 0 12px 0',
            // Full section width on purpose: the source pill sits flush left
            // and the target pill flush right, sharing edges with the section
            // label and the rel legend above. A capped width leaves a ragged
            // right edge against the legend, which reads as misalignment.
        }}>
            <PathPreviewPill
                node={selectedNode}
                urn={selectedUrn}
                context={qualifier(selectedNode, selectedUrn)}
            />
            <PathPreviewSegment
                rels={group?.sourceRels ?? []}
                direction={group?.sourceDirection ?? 'forward'}
                bindingReason={group?.sourceBindingReason}
            />
            {group?.via && (
                <>
                    <PathPreviewPill
                        node={group.via.node}
                        urn={group.via.urn}
                        context={qualifier(group.via.node, group.via.urn)}
                        emphasized
                    />
                    <PathPreviewSegment
                        rels={group.targetRels}
                        direction={group.targetDirection}
                        bindingReason={group.targetBindingReason}
                    />
                </>
            )}
            <PathPreviewPill
                node={targetNode}
                urn={targetUrn}
                context={qualifier(targetNode, targetUrn)}
            />
        </div>
    );
}
