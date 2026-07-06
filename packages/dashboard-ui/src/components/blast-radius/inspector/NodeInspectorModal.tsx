/**
 * NodeInspectorModal. Target dossier.
 *
 * Opens on demand from the blast target banner (and, in time, from any node
 * affordance). Pure node-detail surface: identity, metadata grid, grounding,
 * schema. Relations live in the topology graph + BlastDrawer; the modal does
 * not duplicate them.
 *
 * Use when the user wants to understand the node itself.
 */

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { TopologyMap, TopologyNode, TopologySchema } from '@coderadius/shared-types';
import { ModalShell } from '../../ModalShell';
import {
    NodeIcon,
    getHttpMethodMeta,
    HttpMethodBadge,
    TechBadge,
    ChannelKindBadge,
} from '../../Taxonomy';
import { GroundingSection } from '../../Grounding';
import { QUALITY_VALUES, type Quality } from '../../../types/grounding';
import { BlastTierChip } from '../banner/BlastTierChip';
import type { GravityEvidence } from '../../../lib/blastTier';
import { EventSchemaPanel } from '../drawer/EventSchemaPanel';
import { getServiceQualifier } from '../hooks/MultiServiceReposContext';
import { MiddleEllipsis } from '../../MiddleEllipsis';
import { MetadataGrid } from '../../design-system';
import { buildOverviewItems } from '../NodeOverview';
import { edgeCensus } from '../lib/edge-census';

export interface NodeInspectorModalProps {
    node: TopologyNode;
    urn: string;
    topology: TopologyMap;
    schemas?: TopologySchema[];
    multiServiceRepos: Set<string>;
    rawScore?: number;
    evidence?: GravityEvidence | null;
    onClose: () => void;
    onSelectUrn?: (urn: string) => void;
}

export function NodeInspectorModal({
    node,
    urn,
    topology,
    schemas,
    multiServiceRepos,
    rawScore,
    evidence,
    onClose,
}: NodeInspectorModalProps) {
    const overviewItems = buildOverviewItems(node, edgeCensus(topology, urn));
    return (
        <ModalShell
            ariaLabel={`Details for ${node.name}`}
            onClose={onClose}
            width="560px"
        >
            <div className="node-inspector">
                <header className="node-inspector__header">
                    <div className="node-inspector__identity">
                        <NodeIcon type={node.type} size={22} />
                        <NodeName node={node} urn={urn} multiServiceRepos={multiServiceRepos} />
                    </div>
                    {rawScore && rawScore > 0 && (
                        <div className="node-inspector__header-right">
                            <BlastTierChip rawScore={rawScore} evidence={evidence} />
                        </div>
                    )}
                </header>

                <div className="node-inspector__urn-row">
                    <MiddleEllipsis text={urn} className="node-inspector__urn" />
                    <CopyUrnButton urn={urn} />
                </div>

                {node.description && (
                    <p className="cr-node-description">{node.description}</p>
                )}

                {overviewItems.length > 0 && (
                    <section className="node-inspector__section">
                        <span className="node-inspector__section-label">Overview</span>
                        <MetadataGrid items={overviewItems} columns="responsive" className="cr-meta-grid--rail" />
                    </section>
                )}

                {node.quality && QUALITY_VALUES.includes(node.quality as Quality) && (
                    <section className="node-inspector__section">
                        <GroundingSection node={node} repoUrl={node.repository?.url} />
                    </section>
                )}

                {(schemas ?? []).map((schema, idx) => (
                    <EventSchemaPanel
                        key={`${schema.name}::${schema.role ?? ''}::${idx}`}
                        schema={schema}
                        repoUrl={node.repository?.url}
                    />
                ))}
            </div>
        </ModalShell>
    );
}

function NodeName({ node, urn, multiServiceRepos }: { node: TopologyNode; urn: string; multiServiceRepos: Set<string> }) {
    if (node.type === 'APIEndpoint') {
        const hm = getHttpMethodMeta(node.name, node.apiKind, node.operation);
        if (hm.method || hm.techFlavor) {
            return (
                <h2 className="node-inspector__name node-inspector__name--api">
                    {hm.method && !hm.techFlavor && <HttpMethodBadge method={hm.method} color={hm.color} bgColor={hm.bgColor} borderColor={hm.borderColor} size="md" />}
                    {hm.techFlavor && <TechBadge flavor={hm.techFlavor} subtype={hm.techSubtype} size="md" />}
                    <MiddleEllipsis text={hm.path} />
                </h2>
            );
        }
        return <h2 className="node-inspector__name"><MiddleEllipsis text={node.name} /></h2>;
    }

    if (node.channelKind) {
        return (
            <h2 className="node-inspector__name node-inspector__name--api">
                <ChannelKindBadge kind={node.channelKind} size="md" />
                <MiddleEllipsis text={node.name} />
            </h2>
        );
    }

    const q = getServiceQualifier(node, urn, multiServiceRepos);
    return (
        <h2 className="node-inspector__name">
            {q ? (
                <span className="cr-mid-ellipsis">
                    <span className="cr-mid-ellipsis__head">
                        <span className="cr-qualified__context">{q}</span>
                        <span className="cr-qualified__sep">/</span>
                    </span>
                    <span className="cr-mid-ellipsis__tail">{node.name}</span>
                </span>
            ) : <MiddleEllipsis text={node.name} />}
        </h2>
    );
}

export function CopyUrnButton({ urn }: { urn: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="node-inspector__urn-copy"
            onClick={(e) => {
                e.preventDefault();
                navigator.clipboard.writeText(urn)
                    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
                    .catch(() => {});
            }}
            aria-label={copied ? 'Copied' : 'Copy URN'}
            title={copied ? 'Copied' : 'Copy URN'}
        >
            {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={1.8} />}
        </button>
    );
}

/* GroundingSection, formatVerified and ProvenanceRow used to live here.
 * They've moved to components/Grounding.tsx so the drawer, the inspector
 * modal, and any future surface that exposes provenance render the
 * section identically. Do NOT re-add surface-specific copies; extend the
 * shared component instead. The Overview grid likewise lives in
 * components/blast-radius/NodeOverview.tsx, shared with the BlastDrawer. */
