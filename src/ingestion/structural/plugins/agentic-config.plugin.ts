import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEnrichment } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';
import { hashContent } from '../../core/merkle.js';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// Agentic Config Plugin — Extract AI coding tool configurations
//
// Extracts rules, instructions, MDC configs, LLM configurations across tools like
// Cursor, Copilot, Windsurf, Cline, Gemini, Claude, Devin, Aider, Continue, etc.
//
// v2: Added contentFingerprint (near-duplicate detection) and topics extraction.
// v3: Explicit fallback mode for LLM-based metadata enrichment.
// ═══════════════════════════════════════════════════════════════════════════════

/** Common regex for identifying YAML frontmatter at the start of Markdown/MDC files. */
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n/;

// ─── Strict Types ────────────────────────────────────────────────────────────
// Canonical list of supported AI coding tools and config types.
// Adding a new tool/type here automatically propagates type safety across
// the entire codebase (plugin, Zod schema, Cypher queries).

export const AI_TOOLS = [
    'cursor', 'copilot', 'windsurf', 'cline', 'gemini', 'claude',
    'antigravity', 'devin', 'coderabbit', 'aider', 'continue', 'codex',
    'roo', 'amazonq', 'augment', 'generic', 'trae', 'openhands',
    'pearai', 'void', 'cody', 'sweep', 'codeium', 'supermaven',
    'crewai', 'langgraph', 'autogen',
    'goose', 'bolt', 'promptfoo',
    'knowledge_base',
] as const;
export type AITool = typeof AI_TOOLS[number];

export const AGENTIC_CONFIG_TYPES = [
    'global_rule', 'rule', 'mcp_config', 'skill',
    'tool_settings', 'agent_instructions', 'workflow', 'plugin',
    'memory_bank', 'history',
    'subagents_config', 'subagent_rule', 'tasks_config', 'multi_agent_config',
    'skill_registry',
] as const;
export type AgenticConfigType = typeof AGENTIC_CONFIG_TYPES[number];

interface ToolResolution {
    tool: AITool;
    configType: AgenticConfigType;
}

interface ToolMatcher {
    pattern: RegExp;
    tool: AITool;
    configType: AgenticConfigType;
}

// All patterns use (?:^|.*\/) prefix for monorepo support: a file at
// packages/api/.cursorrules must match the same as root-level .cursorrules.
const P = '(?:^|.*\\/)';

const TOOL_MATCHERS: ToolMatcher[] = [
    // Generic Standards
    { pattern: new RegExp(`${P}\\.mcp(\\..*?)?\\.json$`, 'i'), tool: 'generic', configType: 'mcp_config' },

    // Cursor
    { pattern: new RegExp(`${P}\\.cursorrules$`, 'i'), tool: 'cursor', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.cursor\\/rules\\/.*\\.(md|mdc)$`, 'i'), tool: 'cursor', configType: 'rule' },
    { pattern: new RegExp(`${P}\\.cursor\\/mcp(\\..*?)?\\.json$`, 'i'), tool: 'cursor', configType: 'mcp_config' },
    { pattern: new RegExp(`${P}\\.cursor\\/skills\\/.*\\/skill\\.md$`, 'i'), tool: 'cursor', configType: 'skill' },
    { pattern: new RegExp(`${P}\\.cursor\\/worktrees\\.json$`, 'i'), tool: 'cursor', configType: 'tool_settings' },

    // Copilot
    { pattern: new RegExp(`${P}\\.github\\/copilot-instructions\\.md$`, 'i'), tool: 'copilot', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.github\\/copilot\\/.*\\.md$`, 'i'), tool: 'copilot', configType: 'rule' },

    // Windsurf
    { pattern: new RegExp(`${P}\\.windsurfrules$`, 'i'), tool: 'windsurf', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.windsurf\\/rules\\/.*\\.md$`, 'i'), tool: 'windsurf', configType: 'rule' },
    { pattern: new RegExp(`${P}\\.windsurf\\/cascade\\.json$`, 'i'), tool: 'windsurf', configType: 'tool_settings' },

    // Cline
    { pattern: new RegExp(`${P}\\.clinerules$`, 'i'), tool: 'cline', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.cline\\/rules\\/.*\\.md$`, 'i'), tool: 'cline', configType: 'rule' },
    { pattern: new RegExp(`${P}\\.clinemodes$`, 'i'), tool: 'cline', configType: 'subagents_config' },
    { pattern: new RegExp(`${P}\\.cline\\/rules-[^\\/]+\\.md$`, 'i'), tool: 'cline', configType: 'subagent_rule' },

    // Roo Code (ex Roo Cline)
    { pattern: new RegExp(`${P}\\.roorules$`, 'i'), tool: 'roo', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.roo\\/rules\\/.*\\.md$`, 'i'), tool: 'roo', configType: 'rule' },
    { pattern: new RegExp(`${P}\\.roomodes$`, 'i'), tool: 'roo', configType: 'subagents_config' },
    { pattern: new RegExp(`${P}custom_modes\\.(yaml|json)$`, 'i'), tool: 'roo', configType: 'subagents_config' },
    { pattern: new RegExp(`${P}\\.roo\\/rules-[^\\/]+\\.md$`, 'i'), tool: 'roo', configType: 'subagent_rule' },
    { pattern: new RegExp(`${P}\\.roo\\/rules-[^\\/]+\\/.*\\.md$`, 'i'), tool: 'roo', configType: 'subagent_rule' },

    // Gemini
    { pattern: new RegExp(`${P}GEMINI(?:\\..*?)?\\.md$`, 'i'), tool: 'gemini', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.gemini\\/settings(\\..*?)?\\.json$`, 'i'), tool: 'gemini', configType: 'tool_settings' },

    // Claude
    { pattern: new RegExp(`${P}CLAUDE\\.md$`, 'i'), tool: 'claude', configType: 'global_rule' },
    { pattern: new RegExp(`${P}CLAUDE\\..*\\.md$`, 'i'), tool: 'claude', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.worktreeinclude$`, 'i'), tool: 'claude', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.claude\\/settings(\\..*?)?\\.json$`, 'i'), tool: 'claude', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.claude\\/rules\\/.*\\.(md|mdc)$`, 'i'), tool: 'claude', configType: 'rule' },
    { pattern: new RegExp(`${P}\\.claude\\/skills\\/.*\\/SKILL\\.md$`, 'i'), tool: 'claude', configType: 'skill' },
    { pattern: new RegExp(`${P}\\.claude\\/commands\\/.*\\.md$`, 'i'), tool: 'claude', configType: 'skill' },
    { pattern: new RegExp(`${P}\\.claude\\/output-styles\\/.*\\.md$`, 'i'), tool: 'claude', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.claude\\/agents\\/.*\\.md$`, 'i'), tool: 'claude', configType: 'subagent_rule' },

    // Antigravity (Google)
    { pattern: new RegExp(`${P}\\.gemini\\/antigravity\\/`, 'i'), tool: 'antigravity', configType: 'tool_settings' },

    // Devin
    { pattern: new RegExp(`${P}\\.devin\\/`, 'i'), tool: 'devin', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}devin(\\..*?)?\\.json$`, 'i'), tool: 'devin', configType: 'tool_settings' },

    // Amazon Q
    { pattern: new RegExp(`${P}\\.amazonq\\/rules\\/.*\\.md$`, 'i'), tool: 'amazonq', configType: 'rule' },

    // CodeRabbit
    { pattern: new RegExp(`${P}\\.coderabbit\\.yaml$`, 'i'), tool: 'coderabbit', configType: 'tool_settings' },

    // Aider
    { pattern: new RegExp(`${P}\\.aider\\.conf\\.yml$`, 'i'), tool: 'aider', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.aiderignore$`, 'i'), tool: 'aider', configType: 'tool_settings' },

    // Continue
    { pattern: new RegExp(`${P}\\.continue\\/config\\.(json|yaml)$`, 'i'), tool: 'continue', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.prompts\\/.*\\.prompt$`, 'i'), tool: 'continue', configType: 'rule' },

    // Codex
    { pattern: new RegExp(`${P}CODEX(?:\\..*?)?\\.md$`, 'i'), tool: 'codex', configType: 'global_rule' },

    // Augment
    { pattern: new RegExp(`${P}augment-guidelines\\.md$`, 'i'), tool: 'augment', configType: 'global_rule' },

    // Generic Agentic Definitions (consolidated [._]agents? or .ai prefix)
    { pattern: new RegExp(`${P}AGENTS?(?:\\..*?)?\\.md$`, 'i'), tool: 'generic', configType: 'agent_instructions' },
    { pattern: new RegExp(`${P}([._]agents?|\\.ai)\\/(.*\\/)?rules\\/.*\\.(md|mdc|blade\\.php)$`, 'i'), tool: 'generic', configType: 'rule' },
    { pattern: new RegExp(`${P}([._]agents?|\\.ai)\\/(.*\\/)?skills?\\/.*\\/SKILL\\.(md|blade\\.php)$`, 'i'), tool: 'generic', configType: 'skill' },
    { pattern: new RegExp(`${P}([._]agents?|\\.ai)\\/(.*\\/)?workflows\\/.*\\.(md|blade\\.php)$`, 'i'), tool: 'generic', configType: 'workflow' },
    { pattern: new RegExp(`${P}([._]agents?|\\.ai)\\/(.*\\/)?plugins\\/.*\\/plugin\\.json$`, 'i'), tool: 'generic', configType: 'plugin' },
    { pattern: new RegExp(`${P}([._]agents?|\\.ai)\\/.*\\.(md|mdc|blade\\.php)$`, 'i'), tool: 'generic', configType: 'rule' },

    // Trae (ByteDance AI IDE)
    { pattern: new RegExp(`${P}\\.trae\\/rules\\/.*\\.md$`, 'i'), tool: 'trae', configType: 'rule' },
    { pattern: new RegExp(`${P}(user_)?rules\\.md$`, 'i'), tool: 'trae', configType: 'global_rule' },

    // OpenHands (ex OpenDevin)
    { pattern: new RegExp(`${P}\\.openhands\\/(.*\\.toml|.*\\.md)$`, 'i'), tool: 'openhands', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}openhands\\.toml$`, 'i'), tool: 'openhands', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.openhands\\/microagents\\/.*\\.(md|toml)$`, 'i'), tool: 'openhands', configType: 'subagent_rule' },

    // PearAI
    { pattern: new RegExp(`${P}\\.pearai\\/config\\.json$`, 'i'), tool: 'pearai', configType: 'tool_settings' },
    { pattern: new RegExp(`${P}\\.pearairules$`, 'i'), tool: 'pearai', configType: 'global_rule' },

    // Void (Open Source Cursor Alternative)
    { pattern: new RegExp(`${P}\\.voidrules$`, 'i'), tool: 'void', configType: 'global_rule' },
    { pattern: new RegExp(`${P}\\.void\\/rules\\/.*\\.md$`, 'i'), tool: 'void', configType: 'rule' },

    // Sourcegraph Cody
    { pattern: new RegExp(`${P}\\.cody\\/(.*\\.json|ignore)$`, 'i'), tool: 'cody', configType: 'tool_settings' },

    // Sweep AI
    { pattern: new RegExp(`${P}sweep\\.yaml$`, 'i'), tool: 'sweep', configType: 'tool_settings' },

    // Codeium (Standalone engine, distinto da Windsurf)
    { pattern: new RegExp(`${P}\\.codeiumignore$`, 'i'), tool: 'codeium', configType: 'tool_settings' },

    // Supermaven
    { pattern: new RegExp(`${P}\\.?supermaven\\.(json|toml)$`, 'i'), tool: 'supermaven', configType: 'tool_settings' },

    // CrewAI
    { pattern: new RegExp(`${P}(config\\/)?agents\\.yaml$`, 'i'), tool: 'crewai', configType: 'subagents_config' },
    { pattern: new RegExp(`${P}(config\\/)?tasks\\.yaml$`, 'i'), tool: 'crewai', configType: 'tasks_config' },

    // LangGraph
    { pattern: new RegExp(`${P}langgraph\\.json$`, 'i'), tool: 'langgraph', configType: 'multi_agent_config' },

    // AutoGen
    { pattern: new RegExp(`${P}OAI_CONFIG_LIST(\\.json)?$`, 'i'), tool: 'autogen', configType: 'tool_settings' },

    // Goose
    { pattern: new RegExp(`${P}\\.goosehints$`, 'i'), tool: 'goose', configType: 'global_rule' },

    // Bolt.new
    { pattern: new RegExp(`${P}\\.bolt\\/prompt$`, 'i'), tool: 'bolt', configType: 'global_rule' },

    // Promptfoo
    { pattern: new RegExp(`${P}promptfoo\\.yaml$`, 'i'), tool: 'promptfoo', configType: 'tool_settings' },

    // --- INTEGRAZIONI PER TOOL GIA' PRESENTI ---

    // Cline & Roo Code (MCP e Memory Bank)
    { pattern: new RegExp(`${P}\\.cline\\/mcp(\\..*?)?\\.json$`, 'i'), tool: 'cline', configType: 'mcp_config' },
    { pattern: new RegExp(`${P}\\.cline\\/memory\\/.*\\.md$`, 'i'), tool: 'cline', configType: 'memory_bank' },
    { pattern: new RegExp(`${P}\\.roo\\/mcp(\\..*?)?\\.json$`, 'i'), tool: 'roo', configType: 'mcp_config' },

    // Aider (File di history del contesto AI)
    { pattern: new RegExp(`${P}\\.aider\\.(chat|input)\\.history(\\.md)?$`, 'i'), tool: 'aider', configType: 'history' },

    // skills.sh ecosystem — project-level lock file tracking installed agent skills
    { pattern: new RegExp(`${P}skills-lock\\.json$`, 'i'), tool: 'generic', configType: 'skill_registry' },

    // Knowledge Base — shared coding standards / rules repos
    // Matches SCREAMING_CASE .md files at the repo root (e.g. BACKBONE.md, GOLDEN_PATH.md)
    // Must come LAST so more specific tool matchers win first.
    { pattern: /^[A-Z][A-Z0-9_-]+\.md$/, tool: 'knowledge_base', configType: 'rule' },
];

/**
 * Markdown files that are standard repo hygiene, not agentic rules.
 * Used to filter out false positives from the knowledge_base SCREAMING_CASE matcher.
 */
const NON_AGENTIC_MD = new Set([
    'README.md', 'CHANGELOG.md', 'CHANGES.md', 'CONTRIBUTING.md',
    'LICENSE.md', 'LICENCE.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
    'SUPPORT.md', 'AUTHORS.md', 'CODEOWNERS.md', 'MAINTAINERS.md',
    'UPGRADING.md', 'MIGRATION.md', 'PULL_REQUEST_TEMPLATE.md',
    'ISSUE_TEMPLATE.md', 'FUNDING.md', 'RELEASES.md',
]);

function resolveToolAndType(relativePath: string): ToolResolution | null {
    const normalized = relativePath.replace(/\\/g, '/');
    for (const matcher of TOOL_MATCHERS) {
        if (matcher.pattern.test(normalized)) {
            return { tool: matcher.tool, configType: matcher.configType };
        }
    }
    return null;
}

function parseFrontmatter(content: string): Record<string, any> {
    const properties: Record<string, any> = {};
    const match = content.match(FRONTMATTER_REGEX);
    
    if (match && match[1]) {
        const body = match[1];
        const lines = body.split('\n');
        for (const line of lines) {
            const separatorIdx = line.indexOf(':');
            if (separatorIdx === -1) continue;
            
            const key = line.substring(0, separatorIdx).trim();
            const rawVal = line.substring(separatorIdx + 1).trim();
            
            if (key === 'description' || key === 'name') {
                // Strip quotes
                let val = rawVal;
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
                    val = val.substring(1, val.length - 1);
                }
                properties[key] = val;
            } else if (key === 'globs') {
                // Basic parsing of ["glob1", "glob2"]
                let val = rawVal;
                if (val.startsWith('[') && val.endsWith(']')) {
                    val = val.substring(1, val.length - 1);
                    const parts = val.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
                    properties[key] = parts.join(',');
                } else {
                    properties[key] = val;
                }
            } else if (key === 'alwaysApply') {
                properties[key] = rawVal.toLowerCase() === 'true';
            }
        }
    }
    return properties;
}

function deriveName(relativePath: string, basename: string, _tool: AITool, configType: AgenticConfigType): string {
    if (configType === 'global_rule' || configType === 'tool_settings' || configType === 'agent_instructions') {
        return basename;
    }
    if (configType === 'rule' || configType === 'workflow') {
        let name = basename.replace(/\.(mdc|md|json|yaml|yml|blade\.php)$/, '');
        if (name === 'core' || name === 'index' || name === 'rules' || name === 'instructions') {
            const parts = relativePath.split('/');
            if (parts.length >= 2) {
                const parent = parts[parts.length - 2];
                if (parent.match(/^\d+/) && parts.length >= 3) {
                    // Handle version dirs, e.g. .ai/laravel/11/core.blade.php -> laravel-11-core
                    name = `${parts[parts.length - 3]}-${parent}-${name}`;
                } else {
                    // e.g. .ai/boost/core.blade.php -> boost-core
                    name = `${parent}-${name}`;
                }
            }
        }
        return name;
    }
    if (configType === 'skill' || configType === 'plugin') {
        const parts = relativePath.split('/');
        if (parts.length >= 2) {
            return parts[parts.length - 2]; // e.g. plugins/[name]/plugin.json
        }
    }
    return basename;
}

function deriveDescriptionFromBody(content: string, hasFrontmatter: boolean): string | undefined {
    // If it has frontmatter, skip it.
    let body = content;
    if (hasFrontmatter) {
        body = content.replace(FRONTMATTER_REGEX, '');
    }

    const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // Find the first heading
    const heading = lines.find(l => l.startsWith('# '));
    if (heading) return heading.substring(2).trim();

    // Or the first non-empty line
    if (lines.length > 0) return lines[0];
    return undefined;
}

// ─── Content Fingerprint ─────────────────────────────────────────────────────
// Normalized hash for near-duplicate detection.
// Strips whitespace, lowercases, removes comments and frontmatter so that
// cosmetically different copies of the same rule cluster together.

function computeContentFingerprint(content: string): string {
    const normalized = content
        .toLowerCase()
        .replace(FRONTMATTER_REGEX, '')  // strip frontmatter
        .replace(/\/\/.*$/gm, '')                      // strip single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')              // strip block comments
        .replace(/<!--[\s\S]*?-->/g, '')               // strip HTML comments
        .replace(/\s+/g, '');                           // collapse all whitespace

    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

// ─── Governance Topic Vocabulary ─────────────────────────────────────────────
// Canonical list of HIGH-LEVEL engineering domains used by:
//   1. Regex fallback (TOPIC_PATTERNS below)
//   2. LLM extraction agent (Zod enum in agentic-metadata-extractor.ts)
// These are governance categories, NOT specific technologies.
// Technologies are extracted separately as free-form tags by the LLM.

export const GOVERNANCE_TOPICS = [
    'architecture',
    'cross-repo-architecture',
    'coding-standards',
    'testing',
    'developer-experience',
    'ci-cd',
    'observability',
    'security',
    'data-management',
    'workflow',
    'business-domain',
    'documentation',
] as const;
export type GovernanceTopic = typeof GOVERNANCE_TOPICS[number];

// ─── Topic Extraction (Regex Fallback) ───────────────────────────────────────
// Regex-based keyword scanning — used as fallback when LLM enrichment
// fails or is skipped. The LLM enrichment step in plugin-manager.ts
// overwrites these with higher-quality results.

const TOPIC_PATTERNS: Array<{ topic: GovernanceTopic; pattern: RegExp }> = [
    { topic: 'security',             pattern: /\b(security|auth|owasp|injection|sanitiz|xss|csrf|vulnerabilit|secret|encrypt)/i },
    { topic: 'testing',              pattern: /\b(test|coverage|tdd|jest|vitest|playwright|cypress|spec|assert|mock)/i },
    { topic: 'architecture',         pattern: /\b(architect|clean.?architecture|solid|depend.?inject|layer|hexagonal|domain.?driven|module|boundary)/i },
    // NOTE: 'cross-repo-architecture' has NO regex fallback. Detecting it means
    // recognising relationships BETWEEN services/repos (upstream/downstream,
    // inter-service API contracts, shared events) — semantics a keyword pattern
    // cannot reliably tell apart from intra-repo design. It is emitted by the LLM
    // extractor only; this regex path stays at the coarse 'architecture'.
    { topic: 'coding-standards',     pattern: /\b(lint|eslint|prettier|format|naming.?convention|code.?style|biome|react|component|hook|typescript|type.?safe|strict)/i },
    { topic: 'documentation',        pattern: /\b(document|jsdoc|tsdoc|readme|changelog|comment|api.?doc)/i },
    { topic: 'observability',        pattern: /\b(observ|monitor|logging|log|sentry|apm|alert|metric|trace|error.?handl|exception)/i },
    { topic: 'developer-experience', pattern: /\b(makefile|make|setup|onboard|dx|local.?dev|scaffold|template|boilerplate)/i },
    { topic: 'ci-cd',                pattern: /\b(ci|cd|pipeline|deploy|github.?action|docker|kubernetes|helm|container|registry)/i },
    { topic: 'data-management',      pattern: /\b(database|sql|postgres|mysql|mongo|redis|migration|prisma|drizzle|cache|orm)/i },
    { topic: 'workflow',             pattern: /\b(git|commit|branch|merge|pr|pull.?request|conventional.?commit|jira|ticket|sprint|slack|webhook|code.?review)/i },
    { topic: 'business-domain',      pattern: /\b(business|domain|feature|product|requirement|use.?case|acceptance)/i },
];

function extractTopics(content: string): string {
    const matched: string[] = [];
    for (const { topic, pattern } of TOPIC_PATTERNS) {
        if (pattern.test(content)) {
            matched.push(topic);
        }
    }
    return matched.join(',');
}

// ─── skills.sh lock file parser ──────────────────────────────────────────────

interface SkillsLockFile {
    version: number;
    skills: Record<string, {
        source?: string;
        sourceType?: string;
        sourceUrl?: string;
        ref?: string;
        skillPath?: string;
        skillFolderHash?: string;
        pluginName?: string;
        installedAt?: string;
        updatedAt?: string;
    }>;
}

function parseSkillsLock(content: string, _context: PluginContext): StructuralExtractionResult {
    let lock: SkillsLockFile;
    try {
        lock = JSON.parse(content);
    } catch {
        return { entities: [], summary: 'skills-lock.json: invalid JSON' };
    }

    if (!lock.skills || typeof lock.skills !== 'object') {
        return { entities: [], summary: 'skills-lock.json: no skills field' };
    }

    const enrichments: StructuralEnrichment[] = Object.entries(lock.skills).map(([skillName, entry]) => {
        const props: Record<string, unknown> = {};
        if (entry.source) props.skillSource = entry.source;
        if (entry.sourceUrl) props.skillSourceUrl = entry.sourceUrl;
        if (entry.sourceType) props.skillSourceType = entry.sourceType;
        if (entry.skillFolderHash) props.skillHash = entry.skillFolderHash;
        if (entry.installedAt) props.skillInstalledAt = entry.installedAt;
        if (entry.updatedAt) props.skillUpdatedAt = entry.updatedAt;
        return {
            label: 'AgenticConfig',
            matchField: 'skillName',
            matchValue: skillName,
            properties: props,
        };
    });

    return {
        entities: [],
        enrichments,
        summary: `skills-lock.json: ${enrichments.length} provenance enrichment(s)`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════

export const agenticConfigPlugin: StructuralPlugin = {
    name: 'agentic-config',
    label: 'AgenticConfig',
    managedLabels: ['AgenticConfig'],

    matchFile(relativePath: string, basename: string): boolean {
        // Exclude standard repo hygiene files from the knowledge_base catch-all
        if (NON_AGENTIC_MD.has(basename)) return false;
        return resolveToolAndType(relativePath) !== null;
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const resolution = resolveToolAndType(context.relativePath);
        if (!resolution) {
            return { entities: [], summary: 'No tool matched' };
        }

        const { tool, configType } = resolution;

        if (configType === 'skill_registry') {
            return parseSkillsLock(content, context);
        }

        let mcpServers: string | undefined = undefined;
        if (configType === 'mcp_config') {
            try {
                const parsed = JSON.parse(content);
                if (parsed.mcpServers) {
                    mcpServers = Object.keys(parsed.mcpServers).join(',');
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        const frontmatter = parseFrontmatter(content);
        const hasFrontmatter = Object.keys(frontmatter).length > 0;
        
        let description = frontmatter['description'];
        let skillName = frontmatter['name'];

        if (!description) {
            description = deriveDescriptionFromBody(content, hasFrontmatter);
            if (description && description.length > 150) {
                description = description.substring(0, 147) + '...';
            }
        }

        const basename = context.relativePath.split('/').pop() || '';
        const name = deriveName(context.relativePath, basename, tool, configType);

        // ── v2 additions ─────────────────────────────────────────────────────
        const contentFingerprint = computeContentFingerprint(content);
        const topics = extractTopics(content);

        const entity = {
            id: buildUrn('agenticconfig', context.repoName, tool, context.relativePath),
            labels: ['AgenticConfig'],
            properties: {
                name,
                tool,
                configType,
                contentHash: hashContent(content),
                contentFingerprint,
                contentPreview: content.substring(0, 4000),
                filePath: context.relativePath,
                fileSize: content.length,
                
                // Governance topics (comma-separated, e.g. "security,testing,typescript")
                ...(topics ? { topics } : {}),

                // Frontmatter optionally mapped
                ...(description ? { description } : {}),
                ...(frontmatter['globs'] ? { scope: frontmatter['globs'] } : {}),
                ...(typeof frontmatter['alwaysApply'] === 'boolean' ? { alwaysApply: frontmatter['alwaysApply'] } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                ...(skillName ? { skillName } : {}),
                ...(context.symlinkTarget ? { symlinkTarget: context.symlinkTarget, installedVia: 'symlink' } : {}),

                _sourcePath: context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'DEFINES',
        };

        return {
            entities: [entity],
            summary: `[${tool}] ${configType}: ${name}`,
        };
    },
};
