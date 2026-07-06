import { createContext, useContext } from 'react';
import type { TopologyNode } from '@coderadius/shared-types';
import { getItemQualification } from '../../../transformers/utils';
import { getServiceContext } from '../utils/service-context';

/**
 * Set of repo names that contain ≥2 Services (de-facto monorepos). Inside
 * one, every Service should wear the repo prefix uniformly. Calculated once
 * from the topology at the top of the explorer and shared via context.
 */
export const MultiServiceReposContext = createContext<Set<string>>(new Set());

export function useMultiServiceRepos(): Set<string> {
    return useContext(MultiServiceReposContext);
}

/**
 * Single source of truth for the inline `repo / name` qualifier in this
 * explorer. Mirrors `transformers/utils.getItemQualification` and adds the
 * monorepo-aware rule (always qualify when the repo has ≥2 services).
 * Returns the qualifier string, or null if no prefix should be shown.
 */
export function getServiceQualifier(
    node: TopologyNode,
    urn: string,
    multiServiceRepos: Set<string>,
): string | null {
    if (node.type !== 'Service' && node.type !== 'Library') return null;
    const repo = getServiceContext(node, urn);
    return getItemQualification(node.name, repo, repo ? multiServiceRepos.has(repo) : false);
}

/**
 * Hook variant: returns a closure pre-bound to the current
 * multiServiceRepos context, so call sites read like
 * `qualifier(node, urn)` instead of `getServiceQualifier(node, urn, msr)`.
 */
export function useServiceQualifier(): (node: TopologyNode, urn: string) => string | null {
    const msr = useMultiServiceRepos();
    return (node, urn) => getServiceQualifier(node, urn, msr);
}
