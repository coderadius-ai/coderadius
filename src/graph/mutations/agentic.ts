/**
 * Agentic Context Radar — Query Layer
 *
 * Returns a composite Agentic Context Radar report for the dashboard
 * dashboard: maturity matrix, MCP census, duplicate clusters, governance gaps.
 * All queries are pure Cypher — zero LLM.
 *
 * DATA MODEL NOTE:
 * AgenticConfig nodes are attached to **Service** nodes (not Repository directly),
 * because the structural plugin resolves the closest auto-discovered service root.
 * All queries traverse: (Repository)<-[:STORED_IN]-(Service)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)
 * and also defensively check the direct (Repository)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig) path.
 */
import { run } from './_run.js';
import { logger } from '../../utils/logger.js';
import { buildSemanticDuplicatesQuery, type SemanticDuplicatesQueryOpts } from '../queries/semantic-duplicates-query.js';
import { querySkillDuplicatesView, type SkillDuplicatesView } from '../queries/skill-duplicates.js';
import {
    dedupeCatalogConsumers,
    reposFromConsumers,
    teamsFromConsumers,
    pickCatalogProvenance,
    type RawCatalogConsumer,
    type RawCatalogProvenance,
} from '../queries/catalog-consumers.js';
import type { CatalogConsumer, CatalogProvenance } from '@coderadius/shared-types';
import { queryTeamAliasProposals, type TeamAliasProposal } from './team-alias.js';
import { teamListFallbackExpr, teamFallbackExpr } from '../cypher-utils.js';
import { tierFromCommits } from '@coderadius/shared-types';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface MaturityRow {
    repoName: string;
    repoUrl: string | null;
    teamName: string;
    teamSources: string[];
    tools: string[];
    maturityLevel: number;     // 0–4
    maturityLabel: string;     // Dark / Aware / Configured / Skilled / Orchestrated
    configs: number;
    skills: number;
    workflows: number;
    subagents: number;
    ruleNames: string[];
    skillNames: string[];
    workflowNames: string[];
    subagentNames: string[];
    /**
     * Raw non-merge commit count in the last 12 months. 0 means dormant, null
     * means unknown (no .git history available). The discrete activity tier
     * is derived on read via `tierFromCommits()` in
     * `@coderadius/shared-types/liveness`.
     */
    livenessCommits: number | null;
}

export interface McpServerRow {
    serverName: string;
    repos: { name: string; url: string | null }[];
    teams: string[];
}

export interface DuplicateCluster {
    fingerprint: string;
    configType: string;
    description: string;
    instances: Array<{ repo: string; team: string; filePath: string }>;
}

export interface CapabilityCoverage {
    repo: string;
    team: string;
    coveredCapabilities: string[];
}

export interface CapabilityEntry {
    name: string;
    type: string;              // skill | workflow | rule
    description: string;
    filePath: string | null;
    repos: { name: string; url: string | null }[];
    teams: string[];
    capabilities: string[];
    usageCount: number;        // distinct consuming services
    consumers: CatalogConsumer[];
    provenance?: CatalogProvenance;
}

export interface SemanticDuplicate {
    configIdA: string;
    serviceA: string;
    configA: string;
    configTypeA: string;
    filePathA: string;
    configIdB: string;
    serviceB: string;
    configB: string;
    configTypeB: string;
    filePathB: string;
    similarity: number;         // 0–1 cosine similarity
    scope: 'same-service' | 'cross-service';
}

export interface TechBlindspot {
    technology: string;             // normalized name, e.g. "React", "Vitest"
    totalRepos: number;             // repos that depend on this technology
    coveredRepos: number;           // repos that have AI config for this tech
    uncoveredRepoNames: string[];   // names of repos without coverage
    coveragePct: number;            // 0–100
}

export interface SkillRecommendation {
    skillName: string;
    skillType: string;
    sourceTeam: string;
    sourceRepo: string;
    targetTeam: string;
    targetRepos: string[];
    sharedPackageCount: number;     // how many packages they share
}

export interface AgentHarnessReport {
    matrix: MaturityRow[];
    mcpCensus: McpServerRow[];
    duplicates: DuplicateCluster[];
    capabilityCoverage: CapabilityCoverage[];
    catalog: CapabilityEntry[];
    semanticDuplicates: SemanticDuplicate[];          // [] if no embeddings yet
    techBlindspots: TechBlindspot[];                  // [] if no packages ingested
    skillRecommendations: SkillRecommendation[];      // [] if no cross-team matches
    teamAliasProposals: TeamAliasProposal[];          // [] if no phantoms detected
    skillDuplicates: SkillDuplicatesView;             // cross-repo skill duplicate clusters
}

// ─── Maturity Levels ─────────────────────────────────────────────────────────

const MATURITY_LABELS = ['Dark', 'Aware', 'Configured', 'Skilled', 'Orchestrated'] as const;

function computeMaturity(row: {
    configCount: number;
    hasNonEmptyRule: boolean;
    skillCount: number;
    workflowCount: number;
    hasMcp: boolean;
    hasScopedRules: boolean;
    hasSubagents: boolean;
}): { level: number; label: string } {
    // Level 4: Multi-agent Subagents OR (MCP + scoped rules + workflows) = fully orchestrated pipeline
    if (row.hasSubagents || (row.hasMcp && row.hasScopedRules && row.workflowCount > 0)) {
        return { level: 4, label: MATURITY_LABELS[4] };
    }
    // Level 3: Custom skills or workflows = invested automation
    if (row.skillCount > 0 || row.workflowCount > 0) {
        return { level: 3, label: MATURITY_LABELS[3] };
    }
    // Level 2: Non-empty, meaningful rules (>200 chars)
    if (row.hasNonEmptyRule) {
        return { level: 2, label: MATURITY_LABELS[2] };
    }
    // Level 1: At least some config file exists
    if (row.configCount > 0) {
        return { level: 1, label: MATURITY_LABELS[1] };
    }
    // Level 0: Nothing
    return { level: 0, label: MATURITY_LABELS[0] };
}

// ─── Core Report Builder ─────────────────────────────────────────────────────

export async function getAgentHarnessReport(): Promise<AgentHarnessReport> {
    const [
        matrix,
        mcpCensus,
        duplicates,
        capabilityCoverage,
        catalog,
        semanticDuplicates,
        techBlindspots,
        skillRecommendations,
        teamAliasProposals,
        skillDuplicates,
    ] = await Promise.all([
        queryMaturityMatrix(),
        queryMcpCensus(),
        queryDuplicates(),
        queryCapabilityCoverage(),
        queryCatalog(),
        querySemanticDuplicates(),
        queryTechBlindspots(),
        querySkillRecommendations(),
        queryTeamAliasProposals(),
        querySkillDuplicatesView(),
    ]);

    return {
        matrix,
        mcpCensus,
        duplicates,
        capabilityCoverage,
        catalog,
        semanticDuplicates,
        techBlindspots,
        skillRecommendations,
        teamAliasProposals,
        skillDuplicates,
    };
}

/* Removed legacy getAgenticReadinessReport */

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Removed local teamNameExpr in favor of teamListFallbackExpr from cypher-utils.

// ─── Query Implementations ───────────────────────────────────────────────────

async function queryMaturityMatrix(): Promise<MaturityRow[]> {
    const result = await run(`
        MATCH (r:Repository)
        OPTIONAL MATCH (t:Team)-[:OWNS]->(ts:Service)-[:STORED_IN]->(r)
        WITH r, collect(DISTINCT t.name) AS teamNames

        OPTIONAL MATCH (r)-[:IMPORTS_CONTEXT_FROM]->(imported:Repository)
        WITH r, teamNames, collect(DISTINCT imported) + [r] AS relatedRepos
        UNWIND relatedRepos AS targetRepo

        OPTIONAL MATCH (targetRepo)-[:HAS_AGENTIC_CONFIG]->(rc:AgenticConfig)
        WITH r, teamNames, targetRepo, collect(DISTINCT rc) AS repoConfigs

        OPTIONAL MATCH (svc:Service)-[:STORED_IN]->(targetRepo)
        OPTIONAL MATCH (svc)-[:HAS_AGENTIC_CONFIG]->(sc:AgenticConfig)
        WITH r, teamNames, repoConfigs + collect(DISTINCT sc) AS combined
        UNWIND (CASE WHEN size(combined) = 0 THEN [null] ELSE combined END) AS rawCfg
        WITH r, teamNames, collect(DISTINCT rawCfg) AS configs
        UNWIND (CASE WHEN size(configs) = 0 THEN [null] ELSE configs END) AS config
        WITH r, teamNames,
             collect(config.tool) AS rawTools,
             count(config) AS totalConfigCount,
             sum(CASE WHEN config IS NOT NULL AND config.configType IN ['global_rule', 'rule', 'agent_instructions'] THEN 1 ELSE 0 END) AS rulesCount,
             sum(CASE WHEN config IS NOT NULL AND config.configType = 'skill' THEN 1 ELSE 0 END) AS skillsCount,
             sum(CASE WHEN config IS NOT NULL AND config.configType = 'workflow' THEN 1 ELSE 0 END) AS workflowsCount,
             sum(CASE WHEN config IS NOT NULL AND config.configType IN ['subagents_config', 'subagent_rule', 'multi_agent_config', 'tasks_config'] THEN 1 ELSE 0 END) AS subagentsCount,
             collect(CASE WHEN config IS NOT NULL AND config.configType IN ['global_rule', 'rule', 'agent_instructions'] THEN config.name ELSE null END) AS rulesNames,
             collect(CASE WHEN config IS NOT NULL AND config.configType = 'skill' THEN config.name ELSE null END) AS skillsNames,
             collect(CASE WHEN config IS NOT NULL AND config.configType = 'workflow' THEN config.name ELSE null END) AS workflowsNames,
             collect(CASE WHEN config IS NOT NULL AND config.configType IN ['subagents_config', 'subagent_rule', 'multi_agent_config', 'tasks_config'] THEN config.name ELSE null END) AS subagentsNames,
             sum(CASE WHEN config IS NOT NULL AND config.configType = 'mcp_config' THEN 1 ELSE 0 END) AS mcpCount,
             sum(CASE WHEN config IS NOT NULL AND config.configType = 'rule' THEN 1 ELSE 0 END) AS scopedCount,
             sum(CASE WHEN config IS NOT NULL AND config.fileSize > 200 AND config.configType IN ['global_rule', 'rule', 'agent_instructions'] THEN 1 ELSE 0 END) AS nonEmptyRuleCount
        RETURN
            r.name AS repoName,
            r.url AS repoUrl,
            ${teamListFallbackExpr('teamNames', 'r')} AS teamName,
            rawTools,
            totalConfigCount,
            rulesCount,
            skillsCount,
            workflowsCount,
            subagentsCount,
            rulesNames,
            skillsNames,
            workflowsNames,
            subagentsNames,
            mcpCount > 0 AS hasMcp,
            scopedCount > 0 AS hasScopedRules,
            subagentsCount > 0 AS hasSubagents,
            nonEmptyRuleCount > 0 AS hasNonEmptyRule,
            r.livenessCommits AS livenessCommits
        ORDER BY teamName, repoName
    `);

    return result.records.map(rec => {
        const rawTools = rec.get('rawTools') as string[];
        const tools = [...new Set(rawTools.filter(Boolean))];

        const maturity = computeMaturity({
            configCount:    Number(rec.get('totalConfigCount')),
            hasNonEmptyRule: Boolean(rec.get('hasNonEmptyRule')),
            skillCount:     Number(rec.get('skillsCount')),
            workflowCount:  Number(rec.get('workflowsCount')),
            hasMcp:         Boolean(rec.get('hasMcp')),
            hasScopedRules: Boolean(rec.get('hasScopedRules')),
            hasSubagents:   Boolean(rec.get('hasSubagents')),
        });

        return {
            repoName:        rec.get('repoName') as string,
            repoUrl:         rec.get('repoUrl') as string | null,
            teamName:        rec.get('teamName') as string,
            teamSources:     [],  // populated from CODEOWNERS/Backstage in future; empty for now
            tools,
            maturityLevel:   maturity.level,
            maturityLabel:   maturity.label,
            configs:         Number(rec.get('rulesCount')),
            skills:          Number(rec.get('skillsCount')),
            workflows:       Number(rec.get('workflowsCount')),
            subagents:       Number(rec.get('subagentsCount')),
            ruleNames:       [...new Set((rec.get('rulesNames') as string[]).filter(Boolean))],
            skillNames:      [...new Set((rec.get('skillsNames') as string[]).filter(Boolean))],
            workflowNames:   [...new Set((rec.get('workflowsNames') as string[]).filter(Boolean))],
            subagentNames:   [...new Set((rec.get('subagentsNames') as string[]).filter(Boolean))],
            livenessCommits: rec.get('livenessCommits') != null ? Number(rec.get('livenessCommits')) : null,
        };
    });
}

async function queryMcpCensus(): Promise<McpServerRow[]> {
    const result = await run(`
        MATCH (svc:Service)-[:STORED_IN]->(r:Repository)
        MATCH (svc)-[:HAS_AGENTIC_CONFIG]->(c:AgenticConfig)
        WHERE c.configType = 'mcp_config' AND c.mcpServers IS NOT NULL
        OPTIONAL MATCH (t:Team)-[:OWNS]->(svc)
        WITH c.mcpServers AS serversCsv, r, t,
             ${teamFallbackExpr('t', 'r', false)} AS teamName
        RETURN serversCsv, collect(DISTINCT {name: r.name, url: r.url}) AS repos, collect(DISTINCT teamName) AS teams
    `);

    const serverMap = new Map<string, { repos: Map<string, string | null>; teams: Set<string> }>();

    for (const rec of result.records) {
        const csv = rec.get('serversCsv') as string;
        const reposArray = rec.get('repos') as any[];
        const teams = rec.get('teams') as string[];

        for (const server of csv.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!serverMap.has(server)) {
                serverMap.set(server, { repos: new Map(), teams: new Set() });
            }
            const entry = serverMap.get(server)!;
            for (const repoObj of reposArray) {
                 entry.repos.set(repoObj.name, repoObj.url || null);
            }
            teams.forEach(t => entry.teams.add(t));
        }
    }

    return Array.from(serverMap.entries())
        .map(([serverName, { repos, teams }]) => ({
            serverName,
            repos: Array.from(repos.entries()).map(([name, url]) => ({ name, url })),
            teams: Array.from(teams),
        }))
        .sort((a, b) => b.repos.length - a.repos.length);
}

async function queryDuplicates(): Promise<DuplicateCluster[]> {
    const result = await run(`
        MATCH (svc:Service)-[:STORED_IN]->(r:Repository)
        MATCH (svc)-[:HAS_AGENTIC_CONFIG]->(c:AgenticConfig)
        WHERE c.contentFingerprint IS NOT NULL
        OPTIONAL MATCH (t:Team)-[:OWNS]->(svc)
        WITH c, r, collect(t.name) AS teams
        WITH c, r, ${teamListFallbackExpr('teams', 'r', false)} AS teamName
        WITH c.contentFingerprint AS fp, c.configType AS configType,
             coalesce(c.semanticIntent, c.description, c.name) AS desc,
             r.name AS repoName, c.filePath AS filePath,
             teamName
        WITH fp, configType, desc,
             collect(repoName) AS repos,
             collect(teamName) AS teams,
             collect(filePath) AS paths,
             count(*) AS cnt
        WHERE cnt > 1
        RETURN fp AS fingerprint, configType, desc AS description, repos, teams, paths
        ORDER BY cnt DESC
    `);

    return result.records.map(rec => {
        const repos  = rec.get('repos')  as string[];
        const teams  = rec.get('teams')  as string[];
        const paths  = rec.get('paths')  as string[];

        const instances = repos.map((repo, i) => ({
            repo,
            team:     teams[i]  || 'Unassigned',
            filePath: paths[i]  || '',
        }));

        return {
            fingerprint: rec.get('fingerprint') as string,
            configType:  rec.get('configType')  as string,
            description: (rec.get('description') as string) || 'Unknown',
            instances,
        };
    });
}

async function queryCapabilityCoverage(): Promise<CapabilityCoverage[]> {
    const result = await run(`
        MATCH (svc:Service)-[:STORED_IN]->(r:Repository)
        MATCH (svc)-[:HAS_AGENTIC_CONFIG]->(c:AgenticConfig)
        OPTIONAL MATCH (t:Team)-[:OWNS]->(svc)
        WITH r.name AS repoName, t, r,
             ${teamFallbackExpr('t', 'r', false)} AS teamName,
             collect(DISTINCT c.topics) AS allCapabilitiesCsv
        RETURN repoName, teamName, allCapabilitiesCsv
        ORDER BY teamName, repoName
    `);

    const coverage: CapabilityCoverage[] = [];

    for (const rec of result.records) {
        const repoName     = rec.get('repoName')    as string;
        const teamName     = rec.get('teamName')    as string;
        const allCapabilitiesCsv = rec.get('allCapabilitiesCsv') as string[];

        const coveredCapabilities = new Set<string>();
        for (const csv of allCapabilitiesCsv) {
            if (csv) csv.split(',').filter(Boolean).forEach(c => coveredCapabilities.add(c.trim()));
        }

        if (coveredCapabilities.size > 0) {
            coverage.push({
                repo: repoName,
                team: teamName,
                coveredCapabilities: Array.from(coveredCapabilities),
            });
        }
    }

    return coverage;
}

async function queryCatalog(): Promise<CapabilityEntry[]> {
    // A "consumer" is a distinct service that has the capability. We collect RAW
    // consumer rows (one per service-dir occurrence) and dedupe in TS, because
    // Memgraph does not dedupe map literals under `collect(DISTINCT ...)` — a
    // skill in 4 harness dirs of one repo would otherwise report adoption 4.
    const result = await run(`
        MATCH (ac:AgenticConfig)
        WHERE ac.configType IN ['skill', 'workflow', 'rule', 'subagent_rule', 'subagents_config', 'multi_agent_config', 'tasks_config', 'agent_instructions']
        OPTIONAL MATCH (svc:Service)-[:HAS_AGENTIC_CONFIG]->(ac)
        OPTIONAL MATCH (r1:Repository)-[:HAS_AGENTIC_CONFIG]->(ac)
        OPTIONAL MATCH (svc)-[:STORED_IN]->(r2:Repository)
        WITH ac, svc, coalesce(r1, r2) AS r
        WHERE r IS NOT NULL
        OPTIONAL MATCH (t:Team)-[:OWNS]->(svc)
        WITH ac, svc, r,
             coalesce(ac.semanticIntent, ac.description, 'No description') AS desc,
             coalesce(ac.topics, '') AS topics,
             coalesce(svc.name, r.name) AS consumerService,
             r.name AS repoName, r.url AS repoUrl,
             ${teamFallbackExpr('t', 'r', false)} AS teamName
        WITH ac.name AS name, ac.configType AS configType,
             collect(DISTINCT desc)[0] AS description,
             collect(DISTINCT ac.filePath)[0] AS filePath,
             collect(DISTINCT topics)[0] AS rawCapabilities,
             collect({ service: consumerService, repo: repoName, url: repoUrl, team: teamName }) AS rawConsumers,
             collect({ source: ac.skillSource, url: ac.skillSourceUrl, type: ac.skillSourceType, installedAt: ac.skillInstalledAt, updatedAt: ac.skillUpdatedAt }) AS rawProvenance
        RETURN name, configType, description, filePath, rawConsumers, rawCapabilities, rawProvenance
        ORDER BY name ASC
    `);

    return result.records
        .map(rec => {
            const rawCapabilities = rec.get('rawCapabilities') as string;
            const capabilities = rawCapabilities ? rawCapabilities.split(',').map(c => c.trim()).filter(Boolean) : [];
            const consumers = dedupeCatalogConsumers(rec.get('rawConsumers') as RawCatalogConsumer[]);
            return {
                name:        rec.get('name') as string,
                type:        rec.get('configType') as string,
                description: rec.get('description') as string,
                filePath:    rec.get('filePath') as string | null,
                repos:       reposFromConsumers(consumers),
                teams:       teamsFromConsumers(consumers),
                capabilities,
                usageCount:  consumers.length,
                consumers,
                provenance:  pickCatalogProvenance(rec.get('rawProvenance') as RawCatalogProvenance[]),
            };
        })
        .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
}

export async function querySemanticDuplicates(
    opts: SemanticDuplicatesQueryOpts = {},
): Promise<SemanticDuplicate[]> {
    // If no AgenticConfig nodes have embeddings yet, skip gracefully.
    const countResult = await run(
        `MATCH (a:AgenticConfig) WHERE a.embedding IS NOT NULL RETURN count(a) AS c`
    );
    const embeddedCount = Number(countResult.records[0]?.get('c') ?? 0);
    if (embeddedCount === 0) return [];

    // For each embedded AgenticConfig, find Top-K neighbours above threshold.
    // id(a) < id(b) avoids double-counting; exact-content duplicates (same
    // fingerprint) are filtered out, since they're already covered by the
    // structural duplicates cluster (queryDuplicates).
    try {
        const { query, params } = buildSemanticDuplicatesQuery(opts);
        const result = await run(query, params);

        return result.records.map(r => ({
            configIdA:   r.get('configIdA') as string,
            serviceA:    r.get('serviceA') as string,
            configA:     r.get('configA') as string,
            configTypeA: r.get('configTypeA') as string,
            filePathA:   r.get('filePathA') as string,
            configIdB:   r.get('configIdB') as string,
            serviceB:    r.get('serviceB') as string,
            configB:     r.get('configB') as string,
            configTypeB: r.get('configTypeB') as string,
            filePathB:   r.get('filePathB') as string,
            similarity:  r.get('similarity') as number,
            scope:       r.get('scope') as 'same-service' | 'cross-service',
        }));
    } catch (err) {
        logger.debug(`[AgenticRadar] Semantic duplicates unavailable: ${(err as Error).message}`);
        return [];
    }
}

// ─── Technology Normalization Map ────────────────────────────────────────────
// Maps package names to a canonical technology label.
// Matching is done in TypeScript (not Cypher) to avoid CONTAINS substring bugs.

const TECH_NORMALIZATION: Record<string, string> = {
    // Frontend Frameworks
    'react': 'React', 'react-dom': 'React', '@types/react': 'React',
    'next': 'Next.js', '@next/bundle-analyzer': 'Next.js', '@next/font': 'Next.js',
    'vue': 'Vue', '@vue/cli-service': 'Vue', 'nuxt': 'Nuxt',
    '@angular/core': 'Angular', '@angular/cli': 'Angular',
    'svelte': 'Svelte', '@sveltejs/kit': 'SvelteKit',
    'solid-js': 'Solid',

    // Backend / Runtime
    '@nestjs/core': 'NestJS', '@nestjs/common': 'NestJS',
    'express': 'Express', '@types/express': 'Express',
    'fastify': 'Fastify',
    'hono': 'Hono',
    'koa': 'Koa',

    // Testing
    'vitest': 'Vitest', '@vitest/ui': 'Vitest',
    'jest': 'Jest', '@jest/core': 'Jest', 'ts-jest': 'Jest',
    '@testing-library/react': 'Testing Library', '@testing-library/vue': 'Testing Library',
    'playwright': 'Playwright', '@playwright/test': 'Playwright',
    'cypress': 'Cypress',
    'storybook': 'Storybook', '@storybook/react': 'Storybook', '@storybook/vue3': 'Storybook',

    // ORM / Database
    '@prisma/client': 'Prisma', 'prisma': 'Prisma',
    'drizzle-orm': 'Drizzle',
    'typeorm': 'TypeORM',
    'sequelize': 'Sequelize',
    'mongoose': 'Mongoose',
    'knex': 'Knex',

    // State Management
    'zustand': 'Zustand', 'redux': 'Redux', '@reduxjs/toolkit': 'Redux',
    'mobx': 'MobX', 'jotai': 'Jotai', 'recoil': 'Recoil',

    // Build / Bundlers
    'vite': 'Vite', '@vitejs/plugin-react': 'Vite',
    'webpack': 'Webpack', 'turbopack': 'Turbopack',
    'esbuild': 'esbuild', 'rollup': 'Rollup',

    // Styling
    'tailwindcss': 'Tailwind CSS', '@tailwindcss/typography': 'Tailwind CSS',
    'styled-components': 'Styled Components',
    'sass': 'Sass',

    // Infrastructure
    'docker-compose': 'Docker',
    '@aws-sdk/client-s3': 'AWS SDK', 'aws-sdk': 'AWS SDK',
    '@google-cloud/storage': 'Google Cloud',
    'firebase': 'Firebase', 'firebase-admin': 'Firebase',

    // Observability
    '@sentry/node': 'Sentry', '@sentry/react': 'Sentry', '@sentry/browser': 'Sentry',
    '@opentelemetry/sdk-node': 'OpenTelemetry', '@opentelemetry/api': 'OpenTelemetry',
    'pino': 'Pino', 'winston': 'Winston',

    // Auth
    'next-auth': 'NextAuth', '@auth/core': 'Auth.js',

    // Validation / Schema
    'zod': 'Zod', 'joi': 'Joi', 'yup': 'Yup',

    // GraphQL
    'graphql': 'GraphQL', '@apollo/server': 'Apollo', '@apollo/client': 'Apollo',

    // Messaging
    'bullmq': 'BullMQ', 'amqplib': 'RabbitMQ', 'kafkajs': 'Kafka', 'ioredis': 'Redis',

    // TypeScript / Linting
    'typescript': 'TypeScript',
    'eslint': 'ESLint', '@eslint/js': 'ESLint',
    'biome': 'Biome', '@biomejs/biome': 'Biome',
    'prettier': 'Prettier',
};

// ─── Tech Blindspots ─────────────────────────────────────────────────────────

async function queryTechBlindspots(): Promise<TechBlindspot[]> {
    // Step 1: Get all packages and which repos depend on them (only active repos)
    // PERFORMANCE optimization: filter in Cypher to only packages we actually normalize
    const knownPackages = Object.keys(TECH_NORMALIZATION);
    const pkgResult = await run(`
        MATCH (r:Repository)-[:DEPENDS_ON]->(p:Package)
        WHERE r.livenessCommits IS NOT NULL AND r.livenessCommits > 0
          AND p.name IN $knownPackages
        RETURN p.name AS pkgName, collect(DISTINCT r.name) AS repoNames
    `, { knownPackages });

    // Step 2: Get only the small metadata fields (technologies + topics CSV).
    // We deliberately SKIP contentPreview — it's up to 4000 chars per config,
    // and transferring it across Bolt for hundreds of repos kills performance.
    // technologies + topics are short comma-separated strings, negligible payload.
    const configResult = await run(`
        MATCH (r:Repository)
        WHERE r.livenessCommits IS NOT NULL AND r.livenessCommits > 0
        OPTIONAL MATCH (svc:Service)-[:STORED_IN]->(r)
        OPTIONAL MATCH (svc)-[:HAS_AGENTIC_CONFIG]->(ac:AgenticConfig)
        WITH r.name AS repoName,
             collect(DISTINCT coalesce(ac.technologies, '')) AS techCsvs,
             collect(DISTINCT coalesce(ac.topics, '')) AS topicCsvs
        RETURN repoName, techCsvs, topicCsvs
    `);

    // Build a map: repoName → Set<normalized-tech-labels> that repo has AI coverage for
    const repoCoverage = new Map<string, Set<string>>();
    for (const rec of configResult.records) {
        const repoName = rec.get('repoName') as string;
        const covered = new Set<string>();

        const techCsvs = rec.get('techCsvs') as string[];
        const topicCsvs = rec.get('topicCsvs') as string[];

        // Concatenate small metadata fields only (no contentPreview — too heavy over Bolt)
        const allText = [...techCsvs, ...topicCsvs]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        // Dual-pass matching: check both raw package names AND normalized labels.
        //
        // Why: LLM-populated `technologies` fields contain raw package names
        // (e.g., "tailwindcss", "next-auth", "@nestjs/core") — NOT normalized labels.
        // Searching for "Tailwind CSS" in "tailwindcss" would always return false.
        //
        // Pass 1: raw package name (primary) — simple includes, very fast.
        // Pass 2: normalized label (fallback) — catches human-written prose ("uses NestJS").
        for (const [pkgName, normalizedTech] of Object.entries(TECH_NORMALIZATION)) {
            if (covered.has(normalizedTech)) continue; // already confirmed covered

            // Pass 1: raw package name (e.g., "tailwindcss", "@nestjs/core")
            // Simple includes is correct: package names are specific enough to avoid
            // false positives, and \b fails on scoped names like "@nestjs/core".
            if (allText.includes(pkgName.toLowerCase())) {
                covered.add(normalizedTech);
                continue;
            }

            // Pass 2: normalized label (e.g., "Tailwind CSS", "NestJS")
            // Catches cases where the LLM wrote the human-readable name in topics.
            const escapedTech = normalizedTech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escapedTech}\\b`, 'i');
            if (regex.test(allText)) {
                covered.add(normalizedTech);
            }
        }

        repoCoverage.set(repoName, covered);
    }

    // Step 3: Group packages by normalized technology and aggregate repos
    const techRepos = new Map<string, Set<string>>();
    for (const rec of pkgResult.records) {
        const pkgName = rec.get('pkgName') as string;
        const repoNames = rec.get('repoNames') as string[];

        const normalizedTech = TECH_NORMALIZATION[pkgName];
        if (!normalizedTech) continue; // Only report on recognized technologies

        if (!techRepos.has(normalizedTech)) {
            techRepos.set(normalizedTech, new Set());
        }
        const repoSet = techRepos.get(normalizedTech)!;
        for (const repo of repoNames) {
            repoSet.add(repo);
        }
    }

    // Step 4: For each technology, determine which repos lack AI coverage
    const blindspots: TechBlindspot[] = [];
    for (const [tech, repos] of techRepos.entries()) {
        if (repos.size < 3) continue; // Only report if 3+ repos use it

        const uncovered: string[] = [];
        let coveredCount = 0;

        for (const repo of repos) {
            const coverage = repoCoverage.get(repo);
            if (coverage && coverage.has(tech)) {
                coveredCount++;
            } else {
                uncovered.push(repo);
            }
        }

        if (uncovered.length === 0) continue; // Fully covered, no blindspot

        blindspots.push({
            technology: tech,
            totalRepos: repos.size,
            coveredRepos: coveredCount,
            uncoveredRepoNames: uncovered.sort(),
            coveragePct: Math.round((coveredCount / repos.size) * 100),
        });
    }

    // Sort: most repos first, then lowest coverage
    return blindspots
        .sort((a, b) => b.totalRepos - a.totalRepos || a.coveragePct - b.coveragePct)
        .slice(0, 20);
}

// ─── Skill Recommendations ──────────────────────────────────────────────────

async function querySkillRecommendations(): Promise<SkillRecommendation[]> {
    try {
        // Step 1: Pull all Repositories, their active Teams, existing configs, and dependencies.
        // We do this in one flat, fast scan (no N×M joins).
        const repoResult = await run(`
            MATCH (r:Repository)
            WHERE r.livenessCommits IS NOT NULL AND r.livenessCommits > 0

            OPTIONAL MATCH (t:Team)-[:OWNS]->(svc:Service)-[:STORED_IN]->(r)
            WITH r, t, ${teamFallbackExpr('t', 'r', false)} AS teamName

            OPTIONAL MATCH (svc2:Service)-[:STORED_IN]->(r)
            OPTIONAL MATCH (svc2)-[:HAS_AGENTIC_CONFIG]->(ac:AgenticConfig)
            WITH r, teamName, collect(DISTINCT ac.name + "::" + ac.configType) AS configs

            OPTIONAL MATCH (r)-[:DEPENDS_ON]->(p:Package)
            RETURN r.name AS repoName, r.livenessCommits AS livenessCommits, teamName, configs, collect(DISTINCT p.name) AS packages
        `);

        // Build adjacency lists in TS memory (blazing fast)
        const repos = new Map<string, { livenessCommits: number | null, team: string, configs: Set<string>, packages: Set<string> }>();
        const candidateSkills: Array<{ skillName: string, skillType: string, sourceRepo: string, sourceTeam: string }> = [];

        for (const rec of repoResult.records) {
            const repoName = rec.get('repoName') as string;
            const rawCommits = rec.get('livenessCommits');
            const livenessCommits = rawCommits != null ? Number(rawCommits) : null;
            const tier = tierFromCommits(livenessCommits);
            const team = rec.get('teamName') as string;

            // Filter out null strings like "null::null" from OPTIONAL MATCH
            const rawConfigs = rec.get('configs') as string[];
            const validConfigs = new Set<string>();

            for (const c of rawConfigs) {
                if (c && !c.startsWith('null')) {
                    validConfigs.add(c);
                    const [name, type] = c.split('::');
                    if ((type === 'skill' || type === 'workflow') && (tier === 'elite' || tier === 'high')) {
                        candidateSkills.push({ skillName: name, skillType: type, sourceRepo: repoName, sourceTeam: team });
                    }
                }
            }

            const rawPackages = rec.get('packages') as string[];
            const validPackages = new Set<string>(rawPackages.filter(p => typeof p === 'string'));

            repos.set(repoName, { livenessCommits, team, configs: validConfigs, packages: validPackages });
        }

        // Limit the number of candidate skills we recommend (prevent UI blowup)
        const topCandidates = candidateSkills.slice(0, 50);
        const recommendations: SkillRecommendation[] = [];

        // Step 2: Compute V8 Set intersection sizes
        // In-memory Array intersections for 200 repos * 50 skills take ~1 millisecond combined.
        for (const skill of topCandidates) {
            const srcData = repos.get(skill.sourceRepo);
            if (!srcData || srcData.packages.size === 0) continue;

            const targetsByTeam = new Map<string, { repos: string[], maxOverlap: number }>();

            for (const [targetRepoName, tgtData] of repos.entries()) {
                if (targetRepoName === skill.sourceRepo) continue;
                if (tgtData.team === skill.sourceTeam) continue; // cross-team only
                if (tgtData.configs.has(`${skill.skillName}::${skill.skillType}`)) continue; // already has it

                // Compute intersection
                let sharedCount = 0;
                for (const pkg of srcData.packages) {
                    if (tgtData.packages.has(pkg)) sharedCount++;
                }

                if (sharedCount >= 5) {
                    if (!targetsByTeam.has(tgtData.team)) {
                        targetsByTeam.set(tgtData.team, { repos: [], maxOverlap: 0 });
                    }
                    const tb = targetsByTeam.get(tgtData.team)!;
                    tb.repos.push(targetRepoName);
                    if (sharedCount > tb.maxOverlap) tb.maxOverlap = sharedCount;
                }
            }

            if (targetsByTeam.size > 0) {
                for (const [targetTeam, data] of targetsByTeam.entries()) {
                    recommendations.push({
                        skillName: skill.skillName,
                        skillType: skill.skillType,
                        sourceTeam: skill.sourceTeam,
                        sourceRepo: skill.sourceRepo,
                        targetTeam: targetTeam,
                        targetRepos: data.repos.slice(0, 10), // cap to 10 repos per team
                        sharedPackageCount: data.maxOverlap,
                    });
                }
            }
        }

        // Sort by highest value overlap and limit to 10 overall alerts
        return recommendations
            .sort((a, b) => b.sharedPackageCount - a.sharedPackageCount)
            .slice(0, 10);
    } catch {
        return [];
    }
}
