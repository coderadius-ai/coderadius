/**
 * Cluster colour palette. Cycled through in cluster-id order so colours stay
 * stable as long as the cluster ordering is stable (which the backend
 * guarantees: size desc, then avg similarity desc).
 *
 * Curated from existing design tokens so we don't introduce a "rainbow" — each
 * value is already an accent in the dashboard and used in other surfaces.
 */
export const CLUSTER_PALETTE = [
    'var(--accent)',         // teal
    'var(--color-cyan)',
    'var(--color-magenta)',
    'var(--color-blue)',
    'var(--color-green)',
    'var(--color-yellow)',
] as const;

export function colorForCluster(clusterId: string | null, idx: number): string {
    if (clusterId === null) return 'var(--text-tertiary)';
    return CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length];
}
