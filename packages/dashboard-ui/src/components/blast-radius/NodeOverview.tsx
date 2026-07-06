/**
 * NodeOverview. Shared "Overview" metadata grid for node-identity facts.
 *
 * Single source of truth for the rows that describe a node (team, repo,
 * technology, datastores, type-specific identity, discovery, tags, edge
 * census), consumed by both the NodeInspectorModal and the BlastDrawer so a
 * node describes itself identically on every surface.
 *
 * Technology and Datastore are universal rows, not type-switched: any node
 * type can carry them in the payload and suppressing them per-type silently
 * drops data. The type switch only adds identity rows that exist solely for
 * that type (API kind, channel kind, language, ecosystem).
 */

import { ExternalLink } from 'lucide-react';
import type { TopologyNode } from '@coderadius/shared-types';
import {
    TeamIcon,
    ChannelKindBadge,
    DiscoverySourceChip,
    InfraTechChip,
    humanizeRel,
} from '../Taxonomy';
import { SimpleTooltip } from '../Tooltip';
import type { MetadataGridItem } from '../design-system';
import { MiddleEllipsis } from '../MiddleEllipsis';
import { normaliseRepoUrl } from '../../lib/git-url';
import { isAmbiguousDatastore, datastoreTooltip } from './lib/datastore-display';
import type { EdgeCensusEntry } from './lib/edge-census';

export function buildOverviewItems(node: TopologyNode, census?: EdgeCensusEntry[]): MetadataGridItem[] {
    const items: MetadataGridItem[] = [];

    pushOwnership(node, items);
    pushTypeIdentity(node, items);
    pushInfrastructure(node, items);
    pushMeta(node, items, census);

    return items;
}

function pushOwnership(node: TopologyNode, items: MetadataGridItem[]) {
    if (node.teamOwner) {
        items.push({
            label: 'Team',
            value: (
                <span className="cr-overview__inline">
                    <TeamIcon size={10} />{node.teamOwner}
                </span>
            ),
        });
    }
    if (node.repository) {
        const repoWebUrl = normaliseRepoUrl(node.repository.url);
        items.push({
            label: 'Repository',
            value: repoWebUrl
                ? <a href={repoWebUrl} target="_blank" rel="noopener noreferrer" className="blast-meta-link">{node.repository.name} <ExternalLink size={10} className="cr-overview__ext-link" /></a>
                : <span>{node.repository.name}</span>,
        });
    }
}

interface IdentityRow {
    label: string;
    value: (node: TopologyNode) => React.ReactNode;
}

const pill = (text?: string | null) =>
    text ? <span className="cr-overview__pill">{text}</span> : null;

const PACKAGE_ROWS: IdentityRow[] = [
    { label: 'Ecosystem', value: n => pill(n.ecosystem) },
    { label: 'Language', value: n => pill(n.language) },
];

/** Service and less common node types. */
const DEFAULT_ROWS: IdentityRow[] = [
    { label: 'Language', value: n => pill(n.language) },
    { label: 'Ecosystem', value: n => pill(n.ecosystem) },
];

const TYPE_IDENTITY_ROWS: Record<string, IdentityRow[]> = {
    MessageChannel: [
        { label: 'Kind', value: n => n.channelKind ? <ChannelKindBadge kind={n.channelKind} size="sm" /> : null },
    ],
    APIEndpoint: [
        { label: 'Kind', value: n => pill(n.apiKind) },
        { label: 'Operation', value: n => pill(n.operation) },
    ],
    Package: PACKAGE_ROWS,
    Library: PACKAGE_ROWS,
};

/** Rows that exist solely for one node type. */
function pushTypeIdentity(node: TopologyNode, items: MetadataGridItem[]) {
    for (const row of TYPE_IDENTITY_ROWS[node.type] ?? DEFAULT_ROWS) {
        const value = row.value(node);
        if (value) items.push({ label: row.label, value });
    }
}

/** Universal rows: any node type can carry technology / datastore bindings. */
function pushInfrastructure(node: TopologyNode, items: MetadataGridItem[]) {
    if (node.technology) {
        const label = node.type === 'MessageChannel' ? 'Broker' : 'Technology';
        items.push({
            label,
            value: (
                <SimpleTooltip content={`${label}: ${node.technology}`} side="bottom">
                    <span><InfraTechChip technology={node.technology} nodeType={node.type} size={11} /></span>
                </SimpleTooltip>
            ),
        });
    }
    if (node.datastore?.length) {
        const stores = node.datastore;
        items.push({
            label: stores.length > 1 ? 'Datastores' : 'Datastore',
            // Multi-store bindings (incl. the ambiguous-bind note) need the
            // full row; a half-column truncates the co-candidates away.
            span: stores.length > 1,
            value: (
                <SimpleTooltip content={datastoreTooltip(node)} side="bottom">
                    <span className="cr-overview__inline cr-overview__inline--static">
                        <DatastoreIcon />
                        <span className="cr-truncate">
                            {stores.map((d, i) => (
                                <span key={`${d.name}-${i}`}>
                                    {i > 0 && ', '}
                                    <MiddleEllipsis text={d.name} />
                                    {d.host && <span className="cr-overview__host-suffix">@{d.host}</span>}
                                </span>
                            ))}
                            {isAmbiguousDatastore(node) && <span className="cr-overview__host-suffix"> (ambiguous bind)</span>}
                        </span>
                    </span>
                </SimpleTooltip>
            ),
        });
    }
}

function pushMeta(node: TopologyNode, items: MetadataGridItem[], census?: EdgeCensusEntry[]) {
    if (node.discoverySource) {
        items.push({
            label: 'Discovery',
            value: (
                <SimpleTooltip content={`Discovered via: ${node.discoverySource}`} side="bottom">
                    <span><DiscoverySourceChip source={node.discoverySource} size={11} /></span>
                </SimpleTooltip>
            ),
        });
    }
    if (node.tags && node.tags.length > 0) {
        items.push({
            label: 'Tags',
            value: (
                <span className="cr-overview__inline cr-overview__inline--wrap">
                    {node.tags.map(t => <span key={t} className="cr-overview__pill">{t}</span>)}
                </span>
            ),
            span: true,
        });
    }
    if (census && census.length > 0) {
        items.push({ label: 'All edges', value: <EdgeCensusValue census={census} />, span: true });
    }
}

/**
 * Graph-wide degree summary, e.g. `Reads 3 · Writes 1`. Deliberately
 * monochrome: rel colors here would read as the same vocabulary as the
 * path-scoped rel badges in the drawer's Relationships section, and the two
 * count different things (every edge in the graph vs paths to the blast
 * target).
 */
function EdgeCensusValue({ census }: { census: EdgeCensusEntry[] }) {
    return (
        <SimpleTooltip content="All edges touching this node across the whole graph" side="bottom">
            <span className="cr-overview__inline cr-overview__inline--wrap cr-overview__inline--static cr-overview__census">
                {census.map(({ rel, count }, i) => (
                    <span key={rel} className="cr-overview__census-item">
                        {i > 0 && <span className="cr-overview__census-sep">·</span>}
                        {humanizeRel(rel)}
                        <span className="cr-overview__census-count">{count}</span>
                    </span>
                ))}
            </span>
        </SimpleTooltip>
    );
}

function DatastoreIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="cr-overview__datastore-icon">
            <ellipse cx="6" cy="3" rx="4" ry="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2 3v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V3" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2 6v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}
