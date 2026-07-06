import type { TopologyNode } from '@coderadius/shared-types';

/** Extract repo context from a TopologyNode for display. */
export function getServiceContext(node: TopologyNode, urn: string): string | null {
    if (node.type !== 'Service' && node.type !== 'Library') return null;
    if (node.repository?.name) return node.repository.name;
    // Fallback: extract from URN pattern cr:service:org/repo:name or cr:library:org/repo:name
    const parts = urn.split(':');
    if (parts.length >= 3) {
        const orgRepo = parts[2];
        const repo = orgRepo.split('/').pop();
        if (repo && repo !== node.name && repo !== 'unknown') return repo;
    }
    return null;
}
