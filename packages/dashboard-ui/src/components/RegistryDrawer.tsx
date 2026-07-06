/**
 * RegistryDrawer — Side panel for System Registry rows.
 *
 * Opens when a repository or service row is clicked.
 * Shows the structural metadata (CI pipeline, Docker, ToolConfig, Tasks, etc.)
 * that is NOT visible in the table columns.
 *
 * Design: Vercel/Linear aesthetic — same language as BlastExplorer drawer.
 * Width: 50% viewport, max 1000px (responsive).
 */

import { useState } from 'react';
import { TeamIcon, ToolConfigIcon, CiPipelineIcon, ExternalLinkIcon, BadgeWithLabel, RepositoryIcon, NodeIcon } from './Taxonomy';
import { LIVENESS_LABEL, LIVENESS_COLOR } from '../transformers/utils';
import { tierFromCommits } from '@coderadius/shared-types';
import { buildFileUrl } from '../lib/git-url';
import { DrawerShell } from './DrawerShell';
import { DrawerSection, SectionLabel, SearchableDrawerSection } from './DrawerSection';
import { CiPipelineDiagram, CiTriggerPills } from './CiPipelineDiagram';
import { SimpleTooltip } from './Tooltip';
import { useFuzzyFilter, type FuzzyFilterResult } from '../lib/useFuzzyFilter';
import { highlightMatches } from '../lib/fuzzy-match';

export interface RegistryRepoDrawerData {
    kind: 'repo';
    _rowId?: string;
    name: string;
    url: string | null;
    branch: string | null;
    defaultBranch: string | null;
    coreBranches: string[];
    hostingPlatform: string | null;
    ingestionLevel: 'contracts' | 'semantic' | 'structure';
    livenessCommits: number | null;
    teams: string[];
    languages: string[];
    fileCount: number;
    functionCount: number;
    repoHash: string | null;
    ciPipelines?: Array<{ tool: string; filePath: string; hasTestStage: boolean; hasDeployStage: boolean; jobCount: number; stages?: string; triggers?: string }>;
    dockerImages?: Array<{ imageTag: string | null; imageName?: string | null; filePath: string; context?: 'base_image' | 'infrastructure' | 'ci_runner'; scope?: string }>;
    toolConfigs?: Array<{ toolType: string; filePath: string }>;
    tasks?: Array<{ name: string; runner: string | null }>;
}

export interface RegistryServiceDrawerData {
    kind: 'service';
    _rowId?: string;
    name: string;
    team: string | null;
    languages: string[];
    repositoryName: string | null;
    repositoryUrl: string | null;
    indexedFunctionCount: number;
    exposedEndpointCount: number;
    dependencyCount: number;
}

export type RegistryDrawerData = RegistryRepoDrawerData | RegistryServiceDrawerData;

// ─── Sub-components ───────────────────────────────────────────────────────────





function MonoValue({ children }: { children: React.ReactNode }) {
    return (
        <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11.5px',
            color: 'var(--text-secondary)',
        }}>
            {children}
        </span>
    );
}

function StatRow({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
    return (
        // No border — gap in the parent container creates rhythm
        <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
        }}>
            <span style={{ fontSize: 'var(--cr-type-caption)', color: 'var(--text-tertiary)' }}>{label}</span>
            <span style={{
                fontSize: '13px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: color ?? 'var(--text-primary)',
                letterSpacing: 0,
            }}>
                {value}
            </span>
        </div>
    );
}



// ─── Ingestion level pill ─────────────────────────────────────────────────────

const LEVEL_META: Record<string, { color: string; label: string; desc: string }> = {
    contracts: { color: 'var(--cr-ok)', label: 'CONTRACTS', desc: 'Full extraction: intent, dependencies, and data contract schemas' },
    semantic: { color: 'var(--color-cyan)', label: 'SEMANTIC', desc: 'Code analysis: AST parsing, LLM extraction, and cross-service resolution' },
    structure: { color: 'var(--cr-ink-2)', label: 'STRUCTURE', desc: 'Structural scan only: topology and repository metadata' },
};





// ─── Liveness indicator ───────────────────────────────────────────────────────
// Colors imported from ../transformers/utils (LIVENESS_COLOR)

function LivenessDot({ level }: { level: string }) {
    const color = LIVENESS_COLOR[level] ?? '#52525b';
    return (
        <span style={{
            display: 'inline-block',
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: color,
            boxShadow: level === 'elite' || level === 'high' ? `0 0 6px ${color}` : 'none',
            flexShrink: 0,
        }} />
    );
}

// ─── CI pipeline icon ─────────────────────────────────────────────────────────



// ─── CI tool display name ─────────────────────────────────────────────────────

function ciLabel(tool: string): string {
    const map: Record<string, string> = {
        'gitlab-ci': 'GitLab CI',
        'github-actions': 'GitHub Actions',
        'circleci': 'CircleCI',
        'jenkins': 'Jenkins',
    };
    return map[tool] ?? tool;
}

function toolLabel(toolType: string): string {
    const map: Record<string, string> = {
        'renovate': 'Renovate',
        'dependabot': 'Dependabot',
        'codeowners': 'CODEOWNERS',
        'tsconfig': 'TypeScript Config',
        'eslint': 'ESLint',
        'prettier': 'Prettier',
        'jest': 'Jest',
        'vitest': 'Vitest',
        'coderadius': 'CodeRadius',
        'npm': 'npm',
        'yarn': 'Yarn',
        'pnpm': 'pnpm',
        'bun': 'Bun',
        'composer': 'Composer',
        'pipenv': 'Pipenv',
        'poetry': 'Poetry',
        'uv': 'uv',
        'pdm': 'PDM',
        'go': 'Go Modules',
    };
    return map[toolType] ?? toolType;
}

type ToolConfigEntry = NonNullable<RegistryRepoDrawerData['toolConfigs']>[number];

interface ToolConfigScopeGroup {
    dir: string;
    files: Array<{ name: string; fullPath: string }>;
}

interface ToolConfigGroup {
    toolType: string;
    label: string;
    configs: ToolConfigEntry[];
    scopes: ToolConfigScopeGroup[];
}

function splitConfigPath(filePath: string): { dir: string; file: string } {
    const normalized = filePath.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    if (slash === -1) return { dir: 'root', file: normalized };
    return {
        dir: normalized.slice(0, slash) || 'root',
        file: normalized.slice(slash + 1) || normalized,
    };
}

function groupToolConfigs(configs: ToolConfigEntry[]): ToolConfigGroup[] {
    const byTool = new Map<string, ToolConfigEntry[]>();

    configs.forEach(config => {
        const entries = byTool.get(config.toolType) ?? [];
        entries.push(config);
        byTool.set(config.toolType, entries);
    });

    return Array.from(byTool.entries()).map(([toolType, entries]) => {
        const byScope = new Map<string, ToolConfigScopeGroup>();

        entries.forEach(config => {
            const { dir, file } = splitConfigPath(config.filePath);
            const scope = byScope.get(dir) ?? { dir, files: [] };
            scope.files.push({ name: file, fullPath: config.filePath });
            byScope.set(dir, scope);
        });

        return {
            toolType,
            label: toolLabel(toolType),
            configs: entries,
            scopes: Array.from(byScope.values()),
        };
    });
}

function FilePathText({ filePath }: { filePath: string }) {
    const { dir, file } = splitConfigPath(filePath);

    return (
        <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '10.5px',
            color: 'var(--text-tertiary)',
            opacity: 0.74,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
        }}>
            {dir !== 'root' && <span style={{ opacity: 0.62 }}>{dir}/</span>}
            <span style={{ color: 'var(--text-secondary)', opacity: 0.9 }}>{file}</span>
        </span>
    );
}

function ToolConfigInlineRow({ config }: { config: ToolConfigEntry }) {
    return (
        <div style={{ display: 'contents' }}>
            <span style={{
                width: '18px',
                height: '18px',
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}>
                <ToolConfigIcon size={12} />
            </span>
            <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', fontWeight: 500, lineHeight: 1.4 }}>
                {toolLabel(config.toolType)}
            </span>
            <FilePathText filePath={config.filePath} />
            <span />
        </div>
    );
}

function ToolConfigCluster({ group }: { group: ToolConfigGroup }) {
    return (
        <div style={{ display: 'contents' }}>
            <span style={{
                width: '18px',
                height: '18px',
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}>
                <ToolConfigIcon size={12} />
            </span>
            <span style={{
                fontSize: 'var(--cr-type-caption)',
                color: 'var(--text-secondary)',
                fontWeight: 500,
                letterSpacing: 0,
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
            }}>
                {group.label}
            </span>
            <span />
            <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '10.5px',
                color: 'var(--text-tertiary)',
                opacity: 0.62,
                whiteSpace: 'nowrap',
            }}>
                {group.configs.length} files
            </span>

            {group.scopes.map(scope => (
                <div key={scope.dir} style={{ display: 'contents' }}>
                    <span />
                    <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '10.5px',
                        color: 'var(--text-tertiary)',
                        opacity: 0.62,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {scope.dir}
                    </span>
                    <span style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '4px 12px',
                        minWidth: 0,
                    }}>
                        {scope.files.map(file => (
                            <span key={file.fullPath} style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: '10.5px',
                                color: 'var(--text-secondary)',
                                opacity: 0.82,
                                lineHeight: 1.6,
                                whiteSpace: 'nowrap',
                            }}>
                                {file.name}
                            </span>
                        ))}
                    </span>
                    <span />
                </div>
            ))}
        </div>
    );
}

function ToolConfigList({ configs }: { configs: ToolConfigEntry[] }) {
    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: '18px minmax(200px, 240px) minmax(0, 1fr) auto',
            columnGap: '8px',
            rowGap: '12px',
            alignItems: 'center',
        }}>
            {groupToolConfigs(configs).map(group => (
                group.configs.length === 1
                    ? <ToolConfigInlineRow key={group.toolType} config={group.configs[0]} />
                    : <ToolConfigCluster key={group.toolType} group={group} />
            ))}
        </div>
    );
}

// ─── Platform display ─────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; color: string }> = {
    github: { label: 'GitHub', color: '#8b949e' },
    gitlab: { label: 'GitLab', color: '#fc6d26' },
    bitbucket: { label: 'Bitbucket', color: '#2684ff' },
    'azure-devops': { label: 'Azure DevOps', color: '#0078d7' },
    'aws-codecommit': { label: 'AWS CodeCommit', color: '#ff9900' },
    'google-cloud': { label: 'Google Cloud', color: '#4285f4' },
};



// ─── CI Pipeline — Unified Trigger + Stage Rendering ──────────────────────────

type CiPipelineData = {
    tool: string;
    filePath: string;
    hasTestStage: boolean;
    hasDeployStage: boolean;
    jobCount: number;
    stages?: string;
    triggers?: string;
};

/** Extract filename from filePath for compact display */
function ciFileName(filePath: string): string {
    return filePath.split('/').pop()?.replace(/\.(yml|yaml)$/, '') ?? filePath;
}

/** Single CI pipeline row — header plus the metro-rail trigger/stage diagram */
function CiPipelineItem({
    ci
}: {
    ci: CiPipelineData;
}) {
    const stages = ci.stages ? ci.stages.split(',').map(s => s.trim()).filter(Boolean) : [];
    const triggers = ci.triggers ? ci.triggers.split(',').map(s => s.trim()).filter(Boolean) : [];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* ── Header row ────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                        <CiPipelineIcon />
                    </span>
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: 0 }}>
                        {ciLabel(ci.tool)}
                    </span>
                    <span style={{
                        fontSize: 'var(--cr-type-micro)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-tertiary)',
                        opacity: 0.45,
                    }}>
                        · {ci.jobCount} jobs
                    </span>
                </div>
                <span style={{
                    fontSize: '11px',
                    fontFamily: "'JetBrains Mono', monospace",
                    color: 'var(--text-tertiary)',
                    opacity: 0.45,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}>
                    {ci.filePath}
                </span>
            </div>

            {/* ── Triggers + stage rail, one diagram ───────────── */}
            <CiPipelineDiagram triggers={triggers} stages={stages} />
        </div>
    );
}

// ─── CI Pipeline Grouping ─────────────────────────────────────────────────────

/** Classify a CI workflow by filePath naming convention */
function classifyCiPipeline(filePath: string): string {
    const name = filePath.split('/').pop()?.replace(/\.(yml|yaml)$/, '') ?? '';
    if (name.includes('e2e'))                           return 'E2E Tests';
    if (name.match(/^ci__/))                            return 'CI Suites';
    if (name.match(/^ci_/))                             return 'Component CI';
    if (/bunnyshell|preview|ephemeral/.test(name))      return 'Preview Environments';
    if (/deploy|release|publish/.test(name))             return 'Deployment';
    return 'Automation';
}

interface CiGroup {
    label: string;
    pipelines: CiPipelineData[];
    totalJobs: number;
}

function groupCiPipelines(pipelines: CiPipelineData[]): CiGroup[] {
    const groups: Record<string, CiPipelineData[]> = {};
    for (const ci of pipelines) {
        const category = classifyCiPipeline(ci.filePath);
        (groups[category] ??= []).push(ci);
    }
    // Sort groups: larger groups first for visual priority
    return Object.entries(groups)
        .map(([label, pips]) => ({
            label,
            pipelines: pips,
            totalJobs: pips.reduce((sum, ci) => sum + ci.jobCount, 0),
        }))
        .sort((a, b) => b.pipelines.length - a.pipelines.length);
}

/** Chevron icon for collapsible groups */
function ChevronIcon({ expanded }: { expanded: boolean }) {
    return (
        <svg
            width="10" height="10"
            viewBox="0 0 10 10"
            fill="none"
            style={{
                transition: 'transform 0.15s ease',
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                flexShrink: 0,
            }}
        >
            <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Collapsible group of CI pipelines */
function CiPipelineGroup({ group, defaultExpanded }: { group: CiGroup; defaultExpanded: boolean }) {
    const [expanded, setExpanded] = useState(defaultExpanded);

    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* ── Group header — clickable ──────────────────── */}
            <button
                onClick={() => setExpanded(prev => !prev)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 0',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    width: '100%',
                    textAlign: 'left',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ChevronIcon expanded={expanded} />
                    <span style={{
                        fontSize: 'var(--cr-type-caption)',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                        letterSpacing: 0,
                    }}>
                        {group.label}
                    </span>
                </div>
                <span style={{
                    fontSize: '11px',
                    fontFamily: "'JetBrains Mono', monospace",
                    color: 'var(--text-tertiary)',
                    opacity: 0.5,
                    whiteSpace: 'nowrap',
                }}>
                    {group.pipelines.length} workflow{group.pipelines.length !== 1 ? 's' : ''}
                    {group.totalJobs > 0 && <> · {group.totalJobs} jobs</>}
                </span>
            </button>

            {/* ── Expanded content ──────────────────────────── */}
            {expanded && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    paddingLeft: '16px',
                    paddingBottom: '8px',
                    borderLeft: '1px solid rgba(255,255,255,0.06)',
                    marginLeft: '4px',
                }}>
                    {group.pipelines.map((ci, i) => {
                        const triggers = ci.triggers ? ci.triggers.split(',').map(s => s.trim()).filter(Boolean) : [];
                        const stages = ci.stages ? ci.stages.split(',').map(s => s.trim()).filter(Boolean) : [];
                        return (
                            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '5px', padding: '4px 0' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                        <span style={{ color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                            <CiPipelineIcon />
                                        </span>
                                        <span style={{
                                            fontSize: '12px',
                                            fontFamily: "'JetBrains Mono', monospace",
                                            color: 'var(--text-secondary)',
                                            fontWeight: 500,
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            minWidth: 0,
                                        }}>
                                            {ciFileName(ci.filePath)}
                                        </span>
                                        <span style={{
                                            fontSize: '10.5px',
                                            fontFamily: "'JetBrains Mono', monospace",
                                            color: 'var(--text-tertiary)',
                                            opacity: 0.45,
                                            flexShrink: 0,
                                        }}>
                                            {ci.jobCount} jobs
                                        </span>
                                    </div>
                                    <CiTriggerPills triggers={triggers} />
                                </div>
                                {stages.length > 0 && <CiPipelineDiagram triggers={[]} stages={stages} />}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** Grouped collapsible CI section — for repos with ≥ CI_GROUP_THRESHOLD pipelines */
const CI_GROUP_THRESHOLD = 4;

function CiPipelineGroupedList({ pipelines }: { pipelines: CiPipelineData[] }) {
    const groups = groupCiPipelines(pipelines);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {groups.map((group, i) => (
                <CiPipelineGroup
                    key={group.label}
                    group={group}
                    defaultExpanded={i === 0}
                />
            ))}
        </div>
    );
}
// ─── Docker Image Sub-components ──────────────────────────────────────────────

type UniqueImage = {
    name: string;
    tag: string;
    fullRef: string;
    shortName: string;
    shortTag: string;
    files: string[];
    context: 'base_image' | 'infrastructure' | 'ci_runner';
};

const CONTEXT_META: Record<UniqueImage['context'], { label: string; color: string }> = {
    base_image:      { label: 'Base',           color: 'var(--accent-primary)' },
    infrastructure:  { label: 'Infrastructure', color: 'var(--text-tertiary)' },
    ci_runner:       { label: 'CI',             color: 'var(--text-tertiary)' },
};

/** Collapsible group header for a Docker context category */
function DockerContextGroup({ context, images, repoUrl, fileBranch, forceExpanded }: {
    context: UniqueImage['context'];
    images: FuzzyFilterResult<UniqueImage>[];
    repoUrl: string | null;
    fileBranch: string;
    forceExpanded?: boolean;
}) {
    const [expanded, setExpanded] = useState(context === 'base_image');
    const isExpanded = forceExpanded || expanded;

    const meta = CONTEXT_META[context];

    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            <button
                onClick={() => setExpanded(prev => !prev)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '7px 0',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    width: '100%',
                    textAlign: 'left',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ChevronIcon expanded={isExpanded} />
                    <span style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: meta.color,
                        letterSpacing: '0.02em',
                    }}>
                        {meta.label}
                    </span>
                </div>
                <span style={{
                    fontSize: '10px',
                    fontFamily: "'JetBrains Mono', monospace",
                    color: 'var(--text-tertiary)',
                    opacity: 0.5,
                }}>
                    {images.length}
                </span>
            </button>

            {isExpanded && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px',
                    paddingLeft: '16px',
                    paddingBottom: '4px',
                }}>
                    {images.map((result, i) => (
                        <DockerImageRow
                            key={`${result.item.name}-${result.item.tag}-${i}`}
                            imageResult={result}
                            repoUrl={repoUrl}
                            fileBranch={fileBranch}
                            forceExpanded={forceExpanded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/** A single deduplicated image row — expandable to show source files */
function DockerImageRow({ imageResult, repoUrl, fileBranch, forceExpanded }: {
    imageResult: FuzzyFilterResult<UniqueImage>;
    repoUrl: string | null;
    fileBranch: string;
    forceExpanded?: boolean;
}) {
    const image = imageResult.item;
    const matches = imageResult.matches || [];
    
    // matches array aligns with the keys config in DockerImagesSection:
    // [img.shortName, img.shortTag, ...img.files]
    const nameMatch = matches[0];
    const tagMatch = matches[1];
    const fileMatches = matches.slice(2);

    const [expanded, setExpanded] = useState(false);
    const hasMultipleFiles = image.files.length > 1;
    const isExpanded = (forceExpanded && hasMultipleFiles) || expanded;
    
    const isNameTruncated = image.shortName !== image.name;

    const nameEl = (
        <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: 'var(--text-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
            lineHeight: '20px',
        }}>
            {highlightMatches(image.shortName, nameMatch?.ranges)}
        </span>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* ── Main row ── */}
            <div
                onClick={image.files.length > 0 ? () => setExpanded(p => !p) : undefined}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 0',
                    cursor: image.files.length > 0 ? 'pointer' : 'default',
                    minWidth: 0,
                    borderRadius: '4px',
                }}
            >
                {/* Expand indicator (only if files exist) */}
                {image.files.length > 0 ? (
                    <span style={{
                        width: '10px',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: 0.35,
                    }}>
                        <ChevronIcon expanded={isExpanded} />
                    </span>
                ) : (
                    <span style={{ width: '10px', flexShrink: 0 }} />
                )}

                {/* Image name — with tooltip if truncated */}
                <div style={{ minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
                    {isNameTruncated ? (
                        <SimpleTooltip content={image.fullRef} side="left">
                            {nameEl}
                        </SimpleTooltip>
                    ) : (
                        nameEl
                    )}
                </div>

                {/* Tag badge */}
                <span style={{
                    fontSize: '9.5px',
                    fontFamily: "'JetBrains Mono', monospace",
                    color: 'var(--text-tertiary)',
                    opacity: 0.55,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}>
                    {highlightMatches(image.shortTag, tagMatch?.ranges)}
                </span>

                {/* Spacer */}
                <span style={{ flex: 1 }} />

                {/* File count badge */}
                {hasMultipleFiles && (
                    <span style={{
                        fontSize: '9px',
                        fontFamily: "'JetBrains Mono', monospace",
                        color: 'var(--text-tertiary)',
                        opacity: 0.4,
                        flexShrink: 0,
                    }}>
                        ×{image.files.length}
                    </span>
                )}
            </div>

            {/* ── Expanded file list ── */}
            {isExpanded && image.files.length > 0 && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    paddingLeft: '18px',
                    paddingBottom: '4px',
                    paddingTop: '2px',
                }}>
                    {image.files.map((fp, i) => {
                        const fileUrl = buildFileUrl(repoUrl, fp, fileBranch);

                        return (
                            <div key={i} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                minWidth: 0,
                            }}>
                                <span style={{
                                    width: '3px',
                                    height: '3px',
                                    borderRadius: '50%',
                                    backgroundColor: 'var(--text-tertiary)',
                                    opacity: 0.3,
                                    flexShrink: 0,
                                }} />
                                {fileUrl ? (
                                    <a
                                        href={fileUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="drawer-link"
                                        onClick={e => e.stopPropagation()}
                                        style={{
                                            fontSize: '10.5px',
                                            fontFamily: "'JetBrains Mono', monospace",
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            minWidth: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                        }}
                                    >
                                        <span style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                        }}>{highlightMatches(fp, fileMatches[i]?.ranges)}</span>
                                        <ExternalLinkIcon size={9} />
                                    </a>
                                ) : (
                                    <span style={{
                                        fontSize: '10px',
                                        fontFamily: "'JetBrains Mono', monospace",
                                        color: 'var(--text-tertiary)',
                                        opacity: 0.5,
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        minWidth: 0,
                                    }}>
                                        {highlightMatches(fp, fileMatches[i]?.ranges)}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function DockerImagesSection({ dockerImages, repoUrl, fileBranch }: {
    dockerImages: NonNullable<RegistryRepoDrawerData['dockerImages']>;
    repoUrl: string | null;
    fileBranch: string;
}) {
    // ── Deduplicate: group by unique image, collect source files ──
    const imageMap = new Map<string, UniqueImage>();
    for (const di of dockerImages) {
        const name = di.imageName ?? '';
        const tag = di.imageTag ?? 'latest';
        const fullRef = name ? `${name}:${tag}` : tag;
        const key = `${name}::${tag}::${di.context ?? 'base_image'}`;

        if (!imageMap.has(key)) {
            // Smart short name: strip common registry prefix
            const nameParts = name.split('/');
            const shortName = nameParts.length > 2
                ? nameParts.slice(-2).join('/') // last 2 segments
                : nameParts.length > 1
                    ? nameParts.slice(-1)[0]!   // last segment only
                    : name;

            imageMap.set(key, {
                name,
                tag,
                fullRef,
                shortName: shortName || name,
                shortTag: tag,
                files: [],
                context: (di.context ?? 'base_image') as UniqueImage['context'],
            });
        }
        const entry = imageMap.get(key)!;
        if (di.filePath && !entry.files.includes(di.filePath)) {
            entry.files.push(di.filePath);
        }
    }

    const uniqueImages = [...imageMap.values()];
    const totalUnique = uniqueImages.length;

    // ── Search State ──
    const [dockerSearch, setDockerSearch] = useState('');

    // ── Fuzzy Filter ──
    const filteredResults = useFuzzyFilter(uniqueImages, dockerSearch, {
        keys: (img) => [img.shortName, img.shortTag, ...img.files],
    });
    
    // We pass the full filtered results down so the rows can highlight matches
    const visibleResults = filteredResults;

    return (
        <SearchableDrawerSection 
            label={`Docker · ${totalUnique}`}
            searchQuery={dockerSearch}
            onSearchChange={setDockerSearch}
            placeholder="Filter images or files..."
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {visibleResults.length === 0 ? (
                    <div style={{
                        padding: '12px 0',
                        fontSize: '11.5px',
                        color: 'var(--text-tertiary)',
                        textAlign: 'center',
                    }}>
                        No matches for "{dockerSearch}"
                    </div>
                ) : (
                    (['base_image', 'infrastructure', 'ci_runner'] as const).map(ctx => {
                        const ctxResults = visibleResults.filter(r => r.item.context === ctx);
                        if (ctxResults.length === 0) return null;

                        return (
                            <DockerContextGroup
                                key={ctx}
                                context={ctx}
                                images={ctxResults}
                                repoUrl={repoUrl}
                                fileBranch={fileBranch}
                                forceExpanded={Boolean(dockerSearch)}
                            />
                        );
                    })
                )}
            </div>
        </SearchableDrawerSection>
    );
}

// ─── Repo Drawer Content ──────────────────────────────────────────────────────

function RepoDrawerContent({ data }: { data: RegistryRepoDrawerData }) {
    const livenessTier = tierFromCommits(data.livenessCommits);
    const livenessColor = LIVENESS_COLOR[livenessTier] ?? '#52525b';
    const livenessLabel = LIVENESS_LABEL[livenessTier] ?? livenessTier;
    const hasPulse = livenessTier !== 'unknown';

    const ciPipelines = data.ciPipelines ?? [];
    const dockerImages = data.dockerImages ?? [];
    const toolConfigs = data.toolConfigs ?? [];
    const tasks = data.tasks ?? [];
    const fileBranch = data.defaultBranch ?? data.branch ?? data.coreBranches[0] ?? 'main';
    // Normalise repo URL — add https:// if missing (same logic as the header link)
    const repoUrl = data.url && !data.url.startsWith('http') ? `https://${data.url}` : data.url;

    return (
        <>
            {/* Header */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingRight: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {/* Git icon */}
                    <div style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <RepositoryIcon />
                    </div>
                    <h3 style={{
                        fontSize: 'var(--cr-type-h2)', fontWeight: 600, color: 'var(--text-primary)',
                        letterSpacing: 0, margin: 0, lineHeight: 1.2, wordBreak: 'break-word',
                    }}>
                        {data.name}
                    </h3>
                </div>
                {data.url && (
                    <div>
                        <a href={data.url.startsWith('http') ? data.url : `https://${data.url}`}
                            target="_blank" rel="noopener noreferrer"
                            className="drawer-link"
                            style={{
                                fontSize: '11px',
                                fontFamily: "'JetBrains Mono', monospace",
                                wordBreak: 'break-all',
                            }}
                        >
                            <span>{data.url.replace(/^https?:\/\//, '')}</span>
                            <ExternalLinkIcon />
                        </a>
                    </div>
                )}
            </div>

            {/* Meta Grid */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px', alignItems: 'center' }}>
                {/* Ingestion */}
                {(() => {
                    const meta = LEVEL_META[data.ingestionLevel] ?? { color: '#71717a', label: data.ingestionLevel.toUpperCase(), desc: '' };
                    return (
                        <BadgeWithLabel
                            label="Ingestion"
                            value={meta.label}
                            color={meta.color}
                            title={meta.desc}
                        />
                    );
                })()}

                {/* Platform */}
                {data.hostingPlatform && data.hostingPlatform !== 'unknown' && PLATFORM_META[data.hostingPlatform] && (
                    <BadgeWithLabel
                        label="Platform"
                        value={PLATFORM_META[data.hostingPlatform].label}
                        color={PLATFORM_META[data.hostingPlatform].color}
                    />
                )}

                {/* Activity */}
                {hasPulse && (
                    <BadgeWithLabel
                        label="Activity"
                        value={livenessLabel}
                        color={livenessColor}
                        icon={<LivenessDot level={livenessTier} />}
                        title={`${data.livenessCommits ?? 0} commits in 12mo`}
                    />
                )}

                {/* Branches */}
                {data.coreBranches && data.coreBranches.length > 0 && (
                    <BadgeWithLabel
                        label={data.coreBranches.length > 1 ? "Branches" : "Branch"}
                        value={
                            <span>
                                {data.coreBranches.map((b, i) => (
                                    <span key={b}>
                                        {i > 0 && <span style={{ color: 'var(--text-tertiary)' }}>, </span>}
                                        <span style={{ color: b === data.defaultBranch ? '#22c55e' : 'var(--text-secondary)' }}>
                                            {b === data.defaultBranch && <span style={{ marginRight: '2px' }}>✱</span>}{b}
                                        </span>
                                    </span>
                                ))}
                            </span>
                        }
                        color="var(--text-secondary)"
                    />
                )}

                {/* Team */}
                {data.teams.length > 0 && (
                    <BadgeWithLabel
                        label="Team"
                        value={data.teams.join(', ')}
                        color="var(--text-secondary)"
                        icon={<TeamIcon size={12} />}
                    />
                )}

                {/* Language */}
                {data.languages.length > 0 && (
                    <BadgeWithLabel
                        label="Language"
                        value={data.languages.join(', ')}
                        color="var(--text-secondary)"
                    />
                )}

                {/* Package Manager */}
                {(() => {
                    const pmConfig = toolConfigs.find(tc => ['npm', 'yarn', 'pnpm', 'bun'].includes(tc.toolType));
                    if (!pmConfig) return null;
                    return (
                        <BadgeWithLabel
                            label="Pkg Manager"
                            value={toolLabel(pmConfig.toolType)}
                            color="var(--text-secondary)"
                            icon={<ToolConfigIcon size={12} />}
                        />
                    );
                })()}
            </div>



            {/* CI Pipelines */}
            {ciPipelines.length > 0 && (
                <DrawerSection label={`CI / CD${ciPipelines.length >= CI_GROUP_THRESHOLD ? ` · ${ciPipelines.length} workflows` : ''}`}>
                    {ciPipelines.length >= CI_GROUP_THRESHOLD ? (
                        <CiPipelineGroupedList pipelines={ciPipelines} />
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                            {ciPipelines.map((ci, i) => (
                                <CiPipelineItem key={i} ci={ci} />
                            ))}
                        </div>
                    )}
                </DrawerSection>
            )}

            {/* Docker Images — deduplicated, grouped, searchable */}
            {dockerImages.length > 0 && (
                <DockerImagesSection
                    dockerImages={dockerImages}
                    repoUrl={repoUrl}
                    fileBranch={fileBranch}
                />
            )}

            {/* Tool Configs */}
            {toolConfigs.length > 0 && (
                <DrawerSection label="Tools &amp; Config">
                    <ToolConfigList configs={toolConfigs} />
                </DrawerSection>
            )}

            {/* Tasks — grouped by runner */}
            {tasks.length > 0 && (() => {
                const grouped = tasks.reduce<Record<string, string[]>>((acc, t) => {
                    const runner = t.runner || 'script';
                    if (!acc[runner]) acc[runner] = [];
                    acc[runner].push(t.name);
                    return acc;
                }, {});
                return (
                    <DrawerSection label="Tasks">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {Object.entries(grouped).map(([runner, names]) => (
                                <div key={runner}>
                                    <div style={{
                                        fontSize: '10px',
                                        fontWeight: 600,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                        color: 'var(--text-tertiary)',
                                        marginBottom: '6px',
                                        opacity: 0.7,
                                    }}>
                                        {runner}
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                                        {names.map(n => (
                                            <span key={n} style={{
                                                fontFamily: "'JetBrains Mono', monospace",
                                                fontSize: '11.5px',
                                                color: 'var(--text-secondary)',
                                                padding: '2px 7px',
                                                borderRadius: '4px',
                                                background: 'rgba(255,255,255,0.04)',
                                                border: '1px solid rgba(255,255,255,0.06)',
                                            }}>
                                                {n}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </DrawerSection>
                );
            })()}


            {/* Fingerprint */}
            {data.repoHash && (
                <DrawerSection label="Fingerprint">
                    <MonoValue>{data.repoHash.slice(0, 12)}…</MonoValue>
                </DrawerSection>
            )}

            {/* Metrics — compact dense block */}
            <div style={{
                display: 'flex', flexDirection: 'column', gap: '5px',
                paddingTop: '20px', marginTop: '20px',
                borderTop: '1px solid rgba(255,255,255,0.09)',
            }}>
                <SectionLabel>Metrics</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                    <StatRow
                        label="Commits (12mo)"
                        value={data.livenessCommits ?? '—'}
                        color={(data.livenessCommits ?? 0) > 50 ? '#22c55e' : undefined}
                    />
                    <StatRow label="Source files" value={data.fileCount.toLocaleString()} />
                    <StatRow label="Indexed functions" value={data.functionCount.toLocaleString()} color={data.functionCount > 0 ? '#22d3ee' : '#52525b'} />
                </div>
            </div>
        </>
    );
}

// ─── Service Drawer Content ───────────────────────────────────────────────────

function ServiceDrawerContent({ data }: { data: RegistryServiceDrawerData }) {
    return (
        <>
            {/* Header */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingRight: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {/* Service icon */}
                    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <NodeIcon type="Service" size={20} />
                    </div>
                    <h3 style={{
                        fontSize: 'var(--cr-type-h2)', fontWeight: 600, color: 'var(--text-primary)',
                        letterSpacing: 0, margin: 0, lineHeight: 1.2,
                    }}>
                        {data.name}
                    </h3>
                </div>
            </div>

            {/* Meta Grid */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px', alignItems: 'center' }}>
                {data.team && (
                    <BadgeWithLabel
                        label="Team"
                        value={data.team}
                        color="var(--text-secondary)"
                        icon={<TeamIcon size={12} />}
                    />
                )}

                {data.languages.length > 0 && (
                    <BadgeWithLabel
                        label="Language"
                        value={data.languages.join(', ')}
                        color="var(--text-secondary)"
                    />
                )}
            </div>



            {/* Repository */}
            {data.repositoryName && (
                <DrawerSection label="Repository">
                    {data.repositoryUrl ? (
                        <a href={data.repositoryUrl.startsWith('http') ? data.repositoryUrl : `https://${data.repositoryUrl}`}
                            target="_blank" rel="noopener noreferrer"
                            className="drawer-link"
                            style={{ fontSize: '13px' }}
                        >
                            {data.repositoryName}
                            <ExternalLinkIcon />
                        </a>
                    ) : (
                        <MonoValue>{data.repositoryName}</MonoValue>
                    )}
                </DrawerSection>
            )}

            {/* Metrics */}
            <DrawerSection label="Coverage">
                <StatRow label="Indexed functions" value={data.indexedFunctionCount.toLocaleString()} color={data.indexedFunctionCount > 0 ? '#22d3ee' : '#52525b'} />
                <StatRow label="Exposed endpoints" value={data.exposedEndpointCount.toLocaleString()} color={data.exposedEndpointCount > 0 ? '#22c55e' : undefined} />
                <StatRow label="Dependencies" value={data.dependencyCount.toLocaleString()} />
            </DrawerSection>
        </>
    );
}

// ─── Drawer Shell ─────────────────────────────────────────────────────────────

export function RegistryDrawer({
    data,
    onClose,
}: {
    data: RegistryDrawerData;
    onClose: () => void;
}) {
    return (
        <DrawerShell
            ariaLabel={data.kind === 'repo' ? `Repository details: ${data.name}` : `Service details: ${data.name}`}
            onClose={onClose}
        >
            {data.kind === 'repo'
                ? <RepoDrawerContent data={data} />
                : <ServiceDrawerContent data={data} />
            }
        </DrawerShell>
    );
}
