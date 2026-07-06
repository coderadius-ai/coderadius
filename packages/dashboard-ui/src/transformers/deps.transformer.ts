/**
 * Dependency / Package Intelligence transformer.
 *
 * The Package Intelligence page renders through PackageRegistryView. This
 * transformer only contributes navigation metadata. Flat CSV helpers stay
 * exported here because the dedicated view uses the same stable export grain.
 */

import type { DepsReport } from '@coderadius/shared-types';
import { getItemQualification, buildMultiServiceRepoSet } from './utils';

// ─── Flat CSV Export Schema ──────────────────────────────────────────────────

/**
 * Flat representation of a single (package, installed_version, consumer) tuple,
 * the atomic fact in the dependency ecosystem. One row carries every dimension
 * a triage spreadsheet needs: package identity, version drift, consumer
 * identity, ownership, activity. Column order here is the export order.
 */
export interface FlatDepsRow {
    package_name: string;
    ecosystem: string;
    is_internal: 'yes' | '';
    installed_version: string;
    is_dev: 'yes' | '';
    is_locked: 'yes' | '';
    drift_level: 'major' | 'minor' | 'patch' | 'none' | '';
    required_version: string;
    latest_published: string;
    version_confidence: string;
    published_by: string;
    consumer_name: string;
    consumer_type: 'Service' | 'Library' | 'Repository' | '';
    consumer_qualified: string;
    consumer_repo: string;
    team: string;
    commits_12mo: number | '';
}

/** Stable header order for the flat CSV; keeps exports and tests in lockstep. */
export const FLAT_DEPS_HEADERS: readonly (keyof FlatDepsRow)[] = [
    'package_name', 'ecosystem', 'is_internal',
    'installed_version', 'is_dev', 'is_locked',
    'drift_level', 'required_version',
    'latest_published', 'version_confidence', 'published_by',
    'consumer_name', 'consumer_type', 'consumer_qualified',
    'consumer_repo', 'team', 'commits_12mo',
] as const;

const DRIFT_RANK: Record<string, number> = {
    major: 0,
    minor: 1,
    patch: 2,
    none: 3,
    '': 4,
};

export function buildFlatDepsRows(report: DepsReport): FlatDepsRow[] {
    const consumerRepos: Array<string | null> = [];
    const consumerSeen = new Set<string>();
    for (const p of report.packages) {
        for (const v of p.versions) {
            for (const c of v.consumers) {
                if (!c.repoName) continue;
                const key = `${c.repoName}::${c.name}`;
                if (consumerSeen.has(key)) continue;
                consumerSeen.add(key);
                consumerRepos.push(c.repoName);
            }
        }
    }
    const multiServiceRepos = buildMultiServiceRepoSet(consumerRepos);
    const isMulti = (repo: string | null | undefined): boolean => !!repo && multiServiceRepos.has(repo);

    const rows: FlatDepsRow[] = [];
    for (const pkg of report.packages) {
        const baseFields = {
            package_name: pkg.packageName,
            ecosystem: pkg.ecosystem,
            is_internal: (pkg.isInternal ? 'yes' : '') as 'yes' | '',
            latest_published: pkg.latestPublished ?? '',
            version_confidence: pkg.versionConfidence ?? '',
            published_by: pkg.publishedBy ?? '',
        };
        for (const v of pkg.versions) {
            const versionFields = {
                installed_version: v.displayVersion ?? '',
                is_dev: (v.isDev ? 'yes' : '') as 'yes' | '',
                is_locked: (v.isLocked ? 'yes' : '') as 'yes' | '',
                drift_level: (v.driftLevel ?? '') as FlatDepsRow['drift_level'],
            };
            if (v.consumers.length === 0) {
                rows.push({
                    ...baseFields,
                    ...versionFields,
                    required_version: '',
                    consumer_name: '',
                    consumer_type: '',
                    consumer_qualified: '',
                    consumer_repo: '',
                    team: '',
                    commits_12mo: '',
                });
                continue;
            }
            for (const c of v.consumers) {
                rows.push({
                    ...baseFields,
                    ...versionFields,
                    required_version: c.requiredVersion ?? '',
                    consumer_name: c.name,
                    consumer_type: c.type,
                    consumer_qualified: getItemQualification(c.name, c.repoName, isMulti(c.repoName)) ?? '',
                    consumer_repo: c.repoName ?? '',
                    team: c.team ?? '',
                    commits_12mo: typeof c.livenessCommits === 'number' ? c.livenessCommits : '',
                });
            }
        }
    }

    rows.sort((a, b) => {
        if (a.package_name !== b.package_name) return a.package_name.localeCompare(b.package_name);
        const da = DRIFT_RANK[a.drift_level] ?? 99;
        const db = DRIFT_RANK[b.drift_level] ?? 99;
        if (da !== db) return da - db;
        if (a.consumer_repo !== b.consumer_repo) {
            if (!a.consumer_repo) return 1;
            if (!b.consumer_repo) return -1;
            return a.consumer_repo.localeCompare(b.consumer_repo);
        }
        return a.consumer_name.localeCompare(b.consumer_name);
    });
    return rows;
}

export function transformDeps() {
    return {
        navItem: {
            id: 'deps',
            label: 'Package Intelligence',
            icon: 'Package',
            pageTitle: 'Package Intelligence',
            pageSubtitle: 'Cross-org package inventory and version governance.',
            headerStats: [],
        },
        headerStats: [],
    };
}
