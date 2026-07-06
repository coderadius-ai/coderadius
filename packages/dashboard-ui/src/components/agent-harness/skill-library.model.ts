import type { AgentHarnessReport, SkillDuplicateCluster, CatalogProvenance } from '@coderadius/shared-types';
import { buildFileUrl } from '../../lib/git-url';

// ─── Types ──────────────────────────────────────────────────────────────────

// The only real, computed signal: a skill either has cross-service duplicates
// (a consolidation opportunity) or it doesn't. The former canonical/orphan/
// proposed states were adoption-count heuristics dressed up as a governance
// lifecycle that does not exist in the backend.
export type SkillStatus = 'duplicate' | 'unique';

export interface SkillConsumerEntry {
    service: string;
    repo: string;
    team: string;
    uses: number;
    successPct: number;
}

export interface SkillDuplicateEntry {
    name: string;
    team: string;
    similarity: number;
    successPct: number;
    calls: number;
    filePath: string | null;
    sourceUrl: string | null;
    symlinkTarget: string | null;
    installedVia: string | null;
}

export interface SkillLibraryEntry {
    id: string;
    name: string;
    description: string;
    owner: string;
    status: SkillStatus;
    consumers: { adopted: number; total: number; list: SkillConsumerEntry[] };
    duplicates: SkillDuplicateEntry[];
    filePath: string | null;
    repos: { name: string; url: string | null }[];
    capabilities: string[];
    provenance?: CatalogProvenance;
}

export interface SkillSuggestion {
    name: string;
    description: string;
    successPct: number;
    consumers: number;
    uses: number;
    sourceTeam: string;
}

export interface SkillLibraryView {
    skills: SkillLibraryEntry[];
    suggestions: SkillSuggestion[];
    stats: {
        totalSkills: number;
        duplicated: number;
    };
}

export type SkillSortKey = 'adoption' | 'activity' | 'name';

// ─── Grouping & Sorting ────────────────────────────────────────────────────

export const STATUS_ORDER: SkillStatus[] = ['duplicate', 'unique'];

export const STATUS_META: Record<SkillStatus, { label: string; desc: string; badge: string }> = {
    duplicate: {
        label: 'Duplicated across teams',
        desc: 'The same skill exists in multiple services. Pick one, retire the rest.',
        badge: '⧉ duplicate',
    },
    // Neutral default, NOT a classification peer to 'duplicate': no badge, no
    // descriptor. It's just "the rest of the library" once duplicates are flagged.
    unique: {
        label: 'Other skills',
        desc: '',
        badge: '',
    },
};

export function groupByStatus(skills: SkillLibraryEntry[]): Map<SkillStatus, SkillLibraryEntry[]> {
    const grouped = new Map<SkillStatus, SkillLibraryEntry[]>();
    for (const status of STATUS_ORDER) grouped.set(status, []);
    for (const skill of skills) {
        const list = grouped.get(skill.status)!;
        list.push(skill);
    }
    return grouped;
}

export function sortSkills(skills: SkillLibraryEntry[], key: SkillSortKey): SkillLibraryEntry[] {
    const sorted = [...skills];
    switch (key) {
        case 'adoption':
            sorted.sort((a, b) => {
                const aRatio = a.consumers.total > 0 ? a.consumers.adopted / a.consumers.total : 0;
                const bRatio = b.consumers.total > 0 ? b.consumers.adopted / b.consumers.total : 0;
                return bRatio - aRatio;
            });
            break;
        case 'activity':
            sorted.sort((a, b) => b.consumers.adopted - a.consumers.adopted);
            break;
        case 'name':
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
    }
    return sorted;
}

export function filterSkills(
    skills: SkillLibraryEntry[],
    query: string,
    activeStatuses: Set<SkillStatus>,
): SkillLibraryEntry[] {
    let filtered = skills.filter(s => activeStatuses.has(s.status));
    if (query.trim()) {
        const q = query.toLowerCase();
        filtered = filtered.filter(s =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.owner.toLowerCase().includes(q) ||
            s.capabilities.some(c => c.toLowerCase().includes(q))
        );
    }
    return filtered;
}

// ─── Builder ────────────────────────────────────────────────────────────────

function buildDuplicateMap(report: AgentHarnessReport): Map<string, SkillDuplicateCluster> {
    const map = new Map<string, SkillDuplicateCluster>();
    if (!report.skillDuplicates) return map;
    for (const cluster of report.skillDuplicates.clusters) {
        for (const member of cluster.members) {
            map.set(member.name.toLowerCase(), cluster);
            if (member.filePath) map.set(member.filePath.toLowerCase(), cluster);
        }
    }
    return map;
}

function classifyStatus(cluster: SkillDuplicateCluster | undefined): SkillStatus {
    return cluster ? 'duplicate' : 'unique';
}

export function buildSkillLibraryView(report: AgentHarnessReport): SkillLibraryView {
    const duplicateMap = buildDuplicateMap(report);

    const repoUrlMap = new Map<string, string>();
    for (const cap of report.catalog) {
        for (const r of cap.repos) {
            if (r.url && !repoUrlMap.has(r.name)) repoUrlMap.set(r.name, r.url);
        }
    }
    for (const row of report.matrix) {
        if (row.repoUrl && !repoUrlMap.has(row.repoName)) repoUrlMap.set(row.repoName, row.repoUrl);
    }

    const skills: SkillLibraryEntry[] = report.catalog
        .filter(cap => cap.type === 'skill')
        .map(cap => {
            const cluster = duplicateMap.get(cap.name.toLowerCase())
                ?? (cap.filePath ? duplicateMap.get(cap.filePath.toLowerCase()) : undefined);
            const status = classifyStatus(cluster);

            const duplicates: SkillDuplicateEntry[] = [];
            if (cluster) {
                for (const member of cluster.members) {
                    if (cap.filePath && member.filePath
                        ? member.filePath.toLowerCase() === cap.filePath.toLowerCase()
                        : member.name.toLowerCase() === cap.name.toLowerCase() && member.service === (cap.repos[0]?.name ?? '')) continue;
                    const dupSourceUrl = member.sourceUrl
                        || buildFileUrl(repoUrlMap.get(member.service), member.filePath);
                    duplicates.push({
                        name: member.name,
                        team: member.service,
                        similarity: member.peerSimilarity ?? cluster.similarity.avg,
                        successPct: 0,
                        calls: 0,
                        filePath: member.filePath || null,
                        sourceUrl: dupSourceUrl || null,
                        symlinkTarget: member.symlinkTarget || null,
                        installedVia: member.installedVia || null,
                    });
                }
            }

            // One row per distinct consuming service, each carrying its OWN team
            // (no index-zip against a separately-deduped teams[] — that mislabels).
            const consumerList: SkillConsumerEntry[] = cap.consumers.map(c => ({
                service: c.service,
                repo: c.repo,
                team: c.team,
                uses: 1,
                successPct: 0,
            }));

            const totalReachable = Math.max(cap.consumers.length, report.matrix.length);

            return {
                id: cap.filePath ? `${cap.repos[0]?.name ?? ''}:${cap.filePath}` : cap.name,
                name: cap.name,
                description: cap.description || '',
                owner: cap.teams[0] ?? 'unassigned',
                status,
                consumers: {
                    adopted: cap.consumers.length,
                    total: totalReachable,
                    list: consumerList,
                },
                duplicates,
                filePath: cap.filePath,
                repos: cap.repos,
                capabilities: cap.capabilities,
                provenance: cap.provenance,
            };
        });

    const suggestions: SkillSuggestion[] = report.skillRecommendations.map(rec => ({
        name: rec.skillName,
        description: `${rec.sourceTeam} (${rec.sourceRepo}) shares ${rec.sharedPackageCount} dependencies with ${rec.targetTeam}`,
        successPct: 0,
        consumers: rec.targetRepos.length,
        uses: 0,
        sourceTeam: rec.sourceTeam,
    }));

    const stats = {
        totalSkills: skills.length,
        duplicated: skills.filter(s => s.status === 'duplicate').length,
    };

    return { skills, suggestions, stats };
}

