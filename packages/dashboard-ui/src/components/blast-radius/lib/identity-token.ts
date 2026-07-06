import type { TopologyNode } from '@coderadius/shared-types';

/**
 * Identity token rendered in the graph card's bottom-left meta strip.
 *
 * Principle: the relation toward the pivot is already conveyed by the
 * colour of the incoming edge (BlastRadiusGraphView stamps stroke =
 * REL_COLORS[getRelColor(rel)]). The card strip therefore carries the
 * COMPLEMENTARY signal: the node's identity (what it is, in practice)
 * or its immediate context (where it lives, who owns it).
 *
 * `muted` flags the chrome-grey fallback ("Data Container", "Service",
 * "unresolved") used when no first-class descriptor is available —
 * callers paint these in a dimmer colour so a populated token clearly
 * stands out against an empty-ish one.
 */
export interface IdentityToken {
    text: string;
    muted: boolean;
}

const HUMANISED_TYPE_OVERRIDES: Record<string, string> = {
    UnresolvedDependency: 'Unresolved Dependency',
    SourceFile: 'Source File',
    DataContainer: 'Data Container',
    DataStructure: 'Data Structure',
    DataField: 'Data Field',
    DatabaseEndpoint: 'Database Endpoint',
    MessageChannel: 'Message Channel',
    APIEndpoint: 'API Endpoint',
    APIInterface: 'API Interface',
    DeploymentUnit: 'Deployment Unit',
};

function humaniseType(t: string): string {
    if (HUMANISED_TYPE_OVERRIDES[t]) return HUMANISED_TYPE_OVERRIDES[t];
    if (!t) return 'Node';
    return t.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function joinDot(...parts: Array<string | null | undefined>): string {
    return parts.filter((p): p is string => !!p && p.length > 0).join(' · ');
}

function muted(text: string): IdentityToken {
    return { text, muted: true };
}

function strong(text: string): IdentityToken {
    return { text, muted: false };
}

function fallbackType(node: TopologyNode): IdentityToken {
    return muted(humaniseType(node.type));
}

function pickApiEndpointToken(node: TopologyNode): IdentityToken {
    const kind = (node.apiKind ?? '').toLowerCase();
    if (kind === 'graphql') {
        return strong(joinDot('graphql', node.operation) || 'graphql');
    }
    if (kind === 'grpc') {
        return strong(joinDot('grpc', node.operation ?? 'UNARY'));
    }
    // REST or legacy: parse leading verb from the name. Mirrors the lightweight
    // path of getHttpMethodMeta in Taxonomy.tsx without dragging React in.
    const head = (node.name ?? '').split(/\s+/, 1)[0]?.toUpperCase();
    const REST_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    if (head && REST_VERBS.has(head)) return strong(head);
    return fallbackType(node);
}

/**
 * Single source of truth for what appears in the card meta-strip's left
 * slot. Pure function: takes the node, returns the token.
 *
 * Mapping:
 *   - Service             → teamOwner || language
 *   - Function            → language
 *   - DataContainer       → technology · datastore.name
 *   - Datastore           → technology
 *   - DatabaseEndpoint    → technology · datastore.host
 *   - MessageChannel      → technology · channelKind
 *   - APIEndpoint         → method (REST) | graphql · op | grpc · op
 *   - ExternalAPI         → technology
 *   - System / Domain     → teamOwner
 *   - UnresolvedDependency → "unresolved" (muted)
 *   - <anything else>     → humanised type label (muted)
 *
 * Never returns an empty string — fallback to humanised type label.
 */
export function pickIdentityToken(node: TopologyNode): IdentityToken {
    if (!node || !node.type) return muted('Node');

    switch (node.type) {
        case 'Service': {
            if (node.teamOwner) return strong(node.teamOwner);
            if (node.language) return strong(node.language);
            return fallbackType(node);
        }
        case 'Function':
        case 'Class':
        case 'SourceFile': {
            if (node.language) return strong(node.language);
            return fallbackType(node);
        }
        case 'Package':
        case 'Library': {
            if (node.ecosystem) return strong(node.ecosystem);
            if (node.language) return strong(node.language);
            return fallbackType(node);
        }
        case 'DataContainer': {
            const tech = node.technology ?? null;
            const dbName = node.datastore?.[0]?.name ?? null;
            if (tech || dbName) return strong(joinDot(tech, dbName));
            return fallbackType(node);
        }
        case 'Datastore': {
            if (node.technology) return strong(node.technology);
            return fallbackType(node);
        }
        case 'DatabaseEndpoint': {
            const tech = node.technology ?? null;
            const host = node.datastore?.[0]?.host ?? null;
            if (tech || host) return strong(joinDot(tech, host));
            return fallbackType(node);
        }
        case 'MessageChannel': {
            const tech = node.technology ?? null;
            const kind = node.channelKind ?? null;
            if (tech || kind) return strong(joinDot(tech, kind));
            return fallbackType(node);
        }
        case 'APIEndpoint': {
            return pickApiEndpointToken(node);
        }
        case 'APIInterface': {
            if (node.apiSource === 'env-var') return strong('External API');
            if (node.title) return strong(node.title);
            return fallbackType(node);
        }
        case 'System':
        case 'Domain': {
            if (node.teamOwner) return strong(node.teamOwner);
            return fallbackType(node);
        }
        case 'UnresolvedDependency': {
            return muted('unresolved');
        }
        default: {
            return fallbackType(node);
        }
    }
}
