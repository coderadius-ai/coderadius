// ═══════════════════════════════════════════════════════════════════════════════
// TeamAliasResolverAgent — LLM-Powered Team Identity Resolution
//
// Receives two lists: known teams (from Backstage/CODEOWNERS) and phantom names
// (GitLab org prefixes with no matching Team node). Returns structured proposals
// mapping phantoms to their canonical teams.
//
// Pattern: identical to infra-discovery.ts — structured input → Zod-validated output.
// Cost: 1 LLM call per entire organisation, ~500 tokens input.
// ═══════════════════════════════════════════════════════════════════════════════

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getModel } from '../models/provider.js';

export const TeamAliasProposalSchema = z.object({
    proposals: z.array(z.object({
        phantomName: z.string().describe('The phantom org-prefix name to resolve'),
        canonicalTeam: z.string().describe('The matching known team name'),
        confidence: z.number().min(0).max(1).describe('Confidence score 0-1'),
        reasoning: z.string().describe('Explanation of why this match was made'),
    })),
    unresolvable: z.array(z.string()).describe(
        'Phantom names that could not be matched to any known team'
    ),
});

export type TeamAliasProposalResult = z.infer<typeof TeamAliasProposalSchema>;

let _agent: Agent | null = null;

export function getTeamAliasResolverAgent(): Agent {
    if (!_agent) {
        _agent = new Agent({
            id: 'team-alias-resolver',
            name: 'Team Identity Resolver',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are an Enterprise IT Organization Analyst specializing in team identity resolution.

I will provide you with two lists:
1. KNOWN TEAMS: Official team names from service catalogs (Backstage, CODEOWNERS).
2. PHANTOM NAMES: Namespace strings extracted from Git repository URLs that are NOT matched to any known team. Each phantom includes the number of repositories it covers.

For each PHANTOM NAME, determine if it is an alias, abbreviation, or organizational variant of a KNOWN TEAM.

Common Enterprise naming patterns to look for:
- Department prefixes: "it-dev-auto-integration" → "auto-integration" (IT development prefix)
- GitLab group hierarchy: full group path stripped to team name
- Naming convention drift: "team-payments" vs "payments-squad"
- Abbreviations: "fe-core" → "frontend-core"
- Environment/role suffixes: "-prod", "-staging" stripped before comparison
- Organizational prefixes: "ops-", "sre-", "platform-" as hierarchy markers

Rules:
- confidence > 0.8 ONLY if the match is near-certain (one is a substring of the other, obvious prefix stripping)
- confidence 0.5-0.8 for plausible but uncertain matches (abbreviation, partial overlap)
- confidence < 0.5 for speculative matches — prefer putting these in "unresolvable" instead
- If no match exists, put the phantom in "unresolvable" — NEVER invent a team that doesn't exist in KNOWN TEAMS
- The "canonicalTeam" field MUST be an exact string from the KNOWN TEAMS list
- Return valid JSON matching the required schema`,
            model: getModel('ingest'),
        });
    }
    return _agent;
}
