import { useServiceQualifier } from '../hooks/MultiServiceReposContext';
import {
    NodeIcon,
    TeamIcon,
    getHttpMethodMeta,
    HttpMethodBadge,
    TechBadge,
    ChannelKindBadge,
    InfraTechChip,
    RelBadge,
} from '../../Taxonomy';
import { SimpleTooltip } from '../../Tooltip';
import { QualityBadge } from '../../QualityBadge';
import { isStructuralFamily, QUALITY_VALUES, type Quality } from '../../../types/grounding';
import type { StreamRow as StreamRowData } from '../utils/stream';
import { MiddleEllipsis } from '../../MiddleEllipsis';

const MAX_VISIBLE_RELS = 4;

/**
 * Dense ~40px row for the v3.2 single-stream list view.
 *
 * Layout is a 7-column CSS grid so the meta-strip chips line up vertically
 * across rows. Rels live INSIDE the identity slot (right after the name),
 * full-text variant — they're variable-width and Linear-style "labels" read
 * better there than in a fixed slot. The dedicated rels grid column from
 * v3.1 has been removed.
 *
 *   [dir-pill] [identity (kind + method + name + rels)] [team] [tech] [quality] [count] [T2]
 *
 * Click semantics mirror BlastCard.tsx:79 / 55: clicking the name pivots
 * the target (onExploreClick); clicking the rest of the row opens the
 * drawer (onDetailsClick).
 */
export function StreamRow({
    row,
    onDetailsClick,
    onExploreClick,
}: {
    row: StreamRowData;
    onDetailsClick: () => void;
    onExploreClick: () => void;
}) {
    const { node, urn, tier, direction, rels, totalCount, functions } = row;
    const qualifier = useServiceQualifier();
    const isApi = node.type === 'APIEndpoint';
    const httpMeta = isApi ? getHttpMethodMeta(node.name, node.apiKind, node.operation) : null;
    const q = node.type === 'Service' ? qualifier(node, urn) : null;
    const fnCount = functions?.length ?? 0;

    const dirLabel = direction === 'upstream' ? 'IN' : 'OUT';
    const dirA11y  = direction === 'upstream' ? 'Inbound dependency' : 'Outbound impact';

    const visibleRels  = rels.slice(0, MAX_VISIBLE_RELS);
    const overflowRels = rels.length - visibleRels.length;

    const showQuality = node.quality
        && QUALITY_VALUES.includes(node.quality as Quality)
        && !isStructuralFamily(node.type);
    const showFn    = tier !== 2 && fnCount > 0;
    const showCount = !showFn && tier !== 2 && totalCount > 1;

    return (
        <article
            className={`blast-stream-row blast-stream-row--${direction} ${tier === 2 ? 'blast-stream-row--t2' : ''}`}
            role="button"
            tabIndex={0}
            onClick={onDetailsClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDetailsClick(); }}
        >
            {/* 1 — Direction pill */}
            <SimpleTooltip content={dirA11y} side="top">
                <span
                    className={`blast-stream-row__dir blast-stream-row__dir--${direction === 'upstream' ? 'in' : 'out'}`}
                    aria-label={dirA11y}
                >
                    {dirLabel}
                </span>
            </SimpleTooltip>

            {/* 2 — Identity: kind-icon + method/channel chip + name + rels */}
            <span className="blast-stream-row__identity">
                {isApi && (httpMeta?.method || httpMeta?.techFlavor) ? (
                    <>
                        <NodeIcon type={node.type} size={12} />
                        {httpMeta.method && !httpMeta.techFlavor && (
                            <HttpMethodBadge
                                method={httpMeta.method}
                                color={httpMeta.color}
                                bgColor={httpMeta.bgColor}
                                borderColor={httpMeta.borderColor}
                                size="sm"
                            />
                        )}
                        {httpMeta.techFlavor && (
                            <TechBadge flavor={httpMeta.techFlavor} subtype={httpMeta.techSubtype} />
                        )}
                        <SimpleTooltip content={urn} side="top">
                            <span
                                className="blast-stream-row__name blast-stream-row__name--api"
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
                                className="blast-stream-row__name"
                                onClick={(e) => { e.stopPropagation(); onExploreClick(); }}
                                role="button"
                            >
                                {q ? (
                                    <span className="cr-mid-ellipsis">
                                        <span className="cr-mid-ellipsis__head">
                                            <span className="cr-qualified__context">{q}</span>
                                            <span className="cr-qualified__sep">/</span>
                                        </span>
                                        <span className="cr-mid-ellipsis__tail">{node.name}</span>
                                    </span>
                                ) : <MiddleEllipsis text={node.name} />}
                            </span>
                        </SimpleTooltip>
                    </>
                )}
                {/* Rels live inline next to the name (Linear-style "labels"
                    after the title). Full-text variant; variable width with
                    `flex-shrink: 0` so they stay legible while the name
                    truncates first when the row is narrow. */}
                {visibleRels.length > 0 && (
                    <span className="blast-stream-row__rels">
                        {visibleRels.map((r, i) => <RelBadge key={`${r}-${i}`} rel={r} />)}
                        {overflowRels > 0 && (
                            <SimpleTooltip content={`Plus ${overflowRels} more: ${rels.slice(MAX_VISIBLE_RELS).join(', ')}`} side="top">
                                <span className="blast-stream-row__rels-overflow">+{overflowRels}</span>
                            </SimpleTooltip>
                        )}
                    </span>
                )}
            </span>

            {/* 3 — Team */}
            <span className="blast-stream-row__team-slot">
                {node.teamOwner && (
                    <SimpleTooltip content="Owning team" side="bottom">
                        <span className="blast-stream-row__team">
                            <TeamIcon size={9} />
                            <span className="blast-stream-row__team-name">{node.teamOwner}</span>
                        </span>
                    </SimpleTooltip>
                )}
            </span>

            {/* 4 — Tech */}
            <span className="blast-stream-row__tech-slot">
                {node.technology && (
                    <SimpleTooltip content={`Technology: ${node.technology}`} side="bottom">
                        <span><InfraTechChip technology={node.technology} nodeType={node.type} size={9} /></span>
                    </SimpleTooltip>
                )}
            </span>

            {/* 5 — Quality dot */}
            <span className="blast-stream-row__quality-slot">
                {showQuality && (
                    <QualityBadge
                        quality={node.quality as Quality}
                        dotOnly
                        source={node.groundingSource ?? undefined}
                    />
                )}
            </span>

            {/* 6 — Count (λN or ×N, λN takes priority) */}
            <span className="blast-stream-row__count-slot">
                {showFn && (
                    <SimpleTooltip content={`${fnCount} impacted resources / functions`} side="top">
                        <span className="blast-stream-row__fn">
                            <span className="blast-stream-row__fn-icon">λ</span>
                            {fnCount}
                        </span>
                    </SimpleTooltip>
                )}
                {showCount && (
                    <SimpleTooltip content={`${totalCount} relationship paths`} side="top">
                        <span className="blast-stream-row__fn">×{totalCount}</span>
                    </SimpleTooltip>
                )}
            </span>

            {/* 7 — T2 */}
            <span className="blast-stream-row__t2-slot">
                {tier === 2 && (
                    <SimpleTooltip content="Transitive impact via intermediate node" side="top">
                        <span className="blast-tier-badge">T2</span>
                    </SimpleTooltip>
                )}
            </span>
        </article>
    );
}
