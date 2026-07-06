import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { logger } from '../../utils/logger.js';
import { normalizeDependencyRef } from '../topology-resolver.js';
import { linkTeamOwnsRepository, linkTeamOwnsService, mergeTeam } from '../../graph/mutations/c4.js';
import { getQualifiedRepoName } from '../../graph/urn.js';
import type { ResolvedRepo } from '../../graph/types.js';
import type { DiscoveredService } from './autodiscovery.js';
import type { ProgressReporter } from '../core/progress.js';

export interface CodeownersRule {
    pattern: string;
    teams: string[];
    users: string[];
    lineNumber: number;
}

export interface CodeownersResult {
    filePath: string;
    rules: CodeownersRule[];
    teamsCreated: string[];
    ownershipEdges: { team: string; target: string; targetType: 'Service' | 'Repository' }[];
}

export interface CodeownersIngestionSummary {
    reposWithCodeowners: number;
    totalTeams: number;
    totalEdges: number;
    results: CodeownersResult[];
}

const COMMON_LOCATIONS = [
    'CODEOWNERS',
    '.github/CODEOWNERS',
    '.gitlab/CODEOWNERS',
    'docs/CODEOWNERS'
];

/**
 * Checks if a CODEOWNERS pattern covers a service root directory.
 * A rule "covers" a service root if the service root falls WITHIN the pattern's scope.
 *
 * @param rulePattern gitignore-style pattern (e.g. "apps/*")
 * @param serviceRootRelPath path to service relative to repo root (e.g. "apps/payment-api" or "apps/payment-api/")
 */
export function doesRuleCoverServiceRoot(rulePattern: string, serviceRootRelPath: string): boolean {
    // Normalize paths to ignore exact trailing slash differences
    const normPattern = rulePattern.replace(/\/+$/, '');
    const normRoot = serviceRootRelPath.replace(/\/+$/, '');
    
    // Exact match
    if (normPattern === normRoot || normPattern === `/${normRoot}`) return true;

    // Global wildcard
    if (normPattern === '*') return true;

    // Pattern is an ancestor of the service root
    // e.g., pattern is "apps/*" or "apps/**" or "apps"
    // Note: minimatch by default does NOT traverse slashes with a single asterisk (*).
    // This implies 'apps/*' matches 'apps/payment-api' but NOT 'apps/payment-api/worker'.
    // This is the correct, intended behaviour conforming to GitHub CODEOWNERS standards.
    const baseMatch = normPattern.match(/^([^*/]+(?:\/[^*/]+)*)/);
    if (!baseMatch) {
         // It might start with a wildcard, like "**/*.ts". This doesn't conceptually "cover" the root, it covers files.
         // Or it's "/*", handled below if not "/*" exactly
         if (normPattern === '/*' || normPattern === '**' || normPattern === '/**') return true;
         return false; 
    }

    const basePath = baseMatch[1];
    
    // If the base path of the pattern is longer than the service root, it's a sub-path rule.
    // e.g. base is "apps/payment-api/db" and service root is "apps/payment-api"
    if (basePath.length > normRoot.length) {
        return false;
    }

    // Direct string manipulation isn't enough, we use minimatch against the service root itself.
    // We want to know if the service root "directory" matches the given directory pattern.
    // In minimatch, "apps/*" will match "apps/payment-api".
    // "apps/**" will match "apps/payment-api".
    // "apps" does NOT match "apps/payment-api" in minimatch by default, it matches the folder "apps".
    // But in CODEOWNERS, "apps/" means "everything inside apps".
    
    // Prepare pattern for CODEOWNERS semantics matching just the directory:
    let matchPattern = normPattern;
    if (rulePattern.endsWith('/') && !matchPattern.includes('*')) {
        matchPattern += '/**'; // "apps/" means "apps/**"
    } else if (!matchPattern.includes('*')) {
        matchPattern += '/**'; // "apps" often means "apps/**" in github codeowners if it's a dir
    }

    return minimatch(normRoot, matchPattern, { dot: true, matchBase: false });
}

export function parseCodeownersFile(content: string): CodeownersRule[] {
    const rules: CodeownersRule[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();

        // Strip inline comments before any parsing
        // A comment starts with '#' at the beginning of the line OR preceded by a space.
        const commentMatch = line.match(/(^|\s)#/);
        if (commentMatch) {
            line = line.substring(0, commentMatch.index).trim();
        }

        // Skip completely empty lines
        if (!line) {
            continue;
        }

        // GitLab sections [Section Name] - skip header
        if (line.startsWith('[') && line.includes(']')) {
            // e.g. "[Frontend] @team-frontend" or just "[Frontend]"
            const sectionEnd = line.indexOf(']');
            line = line.substring(sectionEnd + 1).trim();
            if (!line) continue;
        }

        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length < 2) continue; // Pattern with no owners

        const pattern = parts[0];
        const owners = parts.slice(1);
        const teams: string[] = [];
        const users: string[] = [];

        for (const owner of owners) {
            // GitLab role specifier "@@maintainer"
            if (owner.startsWith('@@')) continue;

            if (owner.includes('/')) {
                // It's a team (@org/team or @group/subgroup)
                // Normalize it (remove @org/ prefix)
                const teamName = normalizeDependencyRef(owner.replace(/^@/, ''));
                teams.push(teamName);
            } else if (owner.startsWith('@')) {
                // User
                users.push(owner.replace(/^@/, ''));
            } else if (owner.includes('@')) {
                // Email
                users.push(owner);
            }
        }

        if (teams.length > 0 || users.length > 0) {
            rules.push({
                pattern,
                teams,
                users,
                lineNumber: i + 1,
            });
        }
    }

    return rules;
}

export async function ingestCodeowners(
    repos: ResolvedRepo[],
    serviceRoots: DiscoveredService[],
    reporter?: ProgressReporter
): Promise<CodeownersIngestionSummary> {
    const summary: CodeownersIngestionSummary = {
        reposWithCodeowners: 0,
        totalTeams: 0,
        totalEdges: 0,
        results: [],
    };

    const globalTeamsCreated = new Set<string>();

    for (const repo of repos) {
        let codeownersPath: string | null = null;
        let content: string | null = null;

        // Discover CODEOWNERS file in standard locations
        for (const loc of COMMON_LOCATIONS) {
            const fullPath = path.join(repo.path, loc);
            if (fs.existsSync(fullPath)) {
                codeownersPath = loc;
                content = fs.readFileSync(fullPath, 'utf-8');
                break;
            }
        }

        if (!content || !codeownersPath) continue;

        summary.reposWithCodeowners++;
        const rules = parseCodeownersFile(content);
        if (rules.length === 0) continue;

        const qualifiedRepoName = getQualifiedRepoName(repo);
        const result: CodeownersResult = {
            filePath: codeownersPath,
            rules,
            teamsCreated: [],
            ownershipEdges: [],
        };
        
        const localTeamsCreated = new Set<string>();
        const localEdgesCreated = new Set<string>();

        // FIX: DiscoveredService has no `repoName` property — filter by absolute path instead
        const repoServices = serviceRoots.filter(s =>
            s.path === repo.path || s.path.startsWith(repo.path + path.sep)
        );

        for (const service of repoServices) {
            const relRoot = path.relative(repo.path, service.path);

            // Walk rules in reverse (last match wins)
            for (let i = rules.length - 1; i >= 0; i--) {
                const rule = rules[i];
                if (doesRuleCoverServiceRoot(rule.pattern, relRoot)) {
                    for (const team of rule.teams) {
                        if (!globalTeamsCreated.has(team)) {
                            await mergeTeam(team, repo.commit || 'unknown');
                            globalTeamsCreated.add(team);
                            localTeamsCreated.add(team);
                        }
                        
                        const edgeKey = `${team}->${service.name}`;
                        if (!localEdgesCreated.has(edgeKey)) {
                            await linkTeamOwnsService(team, qualifiedRepoName, service.name, repo.commit || 'unknown', 'codeowners');
                            localEdgesCreated.add(edgeKey);
                            result.ownershipEdges.push({ team, target: service.name, targetType: 'Service' });
                            summary.totalEdges++;
                        }
                    }
                    break; // Stop looking for this service, last rule won
                }
            }
        }

        // Global wildcard repo ownership
        for (let i = rules.length - 1; i >= 0; i--) {
            const rule = rules[i];
            if (rule.pattern === '*') {
                for (const team of rule.teams) {
                    if (!globalTeamsCreated.has(team)) {
                        await mergeTeam(team, repo.commit || 'unknown');
                        globalTeamsCreated.add(team);
                        localTeamsCreated.add(team);
                    }
                    
                    const edgeKey = `${team}->${qualifiedRepoName}(repo)`;
                    if (!localEdgesCreated.has(edgeKey)) {
                        await linkTeamOwnsRepository(team, qualifiedRepoName, 'codeowners', repo.commit || 'unknown');
                        localEdgesCreated.add(edgeKey);
                        result.ownershipEdges.push({ team, target: qualifiedRepoName, targetType: 'Repository' });
                        summary.totalEdges++;
                    }
                }
                break; // Last wildcard won
            }
        }

        result.teamsCreated = Array.from(localTeamsCreated);
        summary.results.push(result);
    }

    summary.totalTeams = globalTeamsCreated.size;
    return summary;
}
