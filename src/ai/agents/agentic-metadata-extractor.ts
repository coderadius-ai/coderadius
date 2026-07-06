// ═══════════════════════════════════════════════════════════════════════════════
// AgenticMetadataExtractor — LLM Agent for Semantic Metadata Extraction
//
// Reads the raw content preview of an AgenticConfig file (rule, skill, MCP
// config, workflow, etc.) and returns structured metadata:
//   - intent:        Clean plain-text description
//   - topics:        1-4 high-level engineering domains (closed enum)
//   - technologies:  1-5 specific tools/frameworks (open vocabulary, lowercase)
//
// Cost: 1 LLM call per AgenticConfig entity (~200 input tokens, Gemini Flash).
// Called from plugin-manager.ts AFTER structural persistence, OUTSIDE the
// Memgraph session.
// ═══════════════════════════════════════════════════════════════════════════════

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getModel } from '../models/provider.js';
import { GOVERNANCE_TOPICS } from '../../ingestion/structural/plugins/agentic-config.plugin.js';

// ─── Zod Schema (Structured Output) ─────────────────────────────────────────

const GovernanceTopicEnum = z.enum(GOVERNANCE_TOPICS);

export const AgenticMetadataSchema = z.object({
    isAgenticContent: z.boolean().describe(
        'true if this file genuinely contains AI agent instructions, rules, skills, or configurations. '
        + 'false if it is general project documentation (architecture docs, release notes, technical specifications) '
        + 'that does not provide behavioral guidance to an AI coding assistant. '
        + 'When in doubt, lean toward true — false should only be used for clear non-agentic content.'
    ),
    intent: z.string().describe(
        'A clean, 1-2 sentence description of what this rule/skill/config does. '
        + 'Plain text ONLY — no markdown formatting, no raw code, no YAML syntax. '
        + 'Example: "Enforces consistent React component structure using functional components with TypeScript props interfaces."'
    ),
    topics: z.array(GovernanceTopicEnum).min(1).max(12)
        .transform(arr => arr.slice(0, 4))  // Vertex AI ignores maxItems; silently enforce max 4
        .describe(
        'Select 1 to 4 high-level engineering domains this config covers. '
        + "Use 'cross-repo-architecture' when the file describes how this service relates to OTHER services/repos (not just its own internals). "
        + "Use 'developer-experience' for local setup, Makefiles, and DX tooling. "
        + "Use 'ci-cd' for deployments and pipelines. "
        + "Use 'observability' for logs, monitoring, and error tracking."
    ),
    technologies: z.array(z.string()).max(5).describe(
        "Specific languages, frameworks, or tools mentioned (e.g., 'react', 'php', 'docker', 'jira', 'makefile', 'sentry'). "
        + "Keep them lowercase and concise. Empty array if no specific technology is identifiable."
    ),
});

export type AgenticMetadata = z.infer<typeof AgenticMetadataSchema>;

// ─── Agent ──────────────────────────────────────────────────────────────────

let _agent: Agent | null = null;

export function getAgenticMetadataExtractorAgent(): Agent {
    if (!_agent) {
        _agent = new Agent({
            id: 'agentic-metadata-extractor',
            name: 'Agentic Metadata Extractor',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are a technical documentation analyst specializing in AI coding assistant configurations.

You will receive the content of an agentic config file (like .cursorrules, .mdc scoped rules, skill definitions, MCP configs, workflow definitions, etc.) along with its name and type.

Your task is to extract four fields:

1. **isAgenticContent**: true/false — Is this file genuinely providing behavioral guidance to an AI coding assistant?
   - true: Rules, skills, workflows, coding standards, instructions that guide AI behaviour or developer practice
   - false: Generic project docs (architecture diagrams, release notes, API references, business specs not aimed at AI)
   - When in doubt, lean true. Only mark false for clearly non-agentic documentation.

2. **intent**: A clean, human-readable 1-2 sentence description of what this config does.
   - Use plain text ONLY. No markdown, no code blocks, no YAML.
   - Be specific about the technology and purpose.
   - If the content is a coding style rule, describe what coding patterns it enforces.
   - If the content is a skill, describe what task the skill automates.
   - If the content is an MCP config, describe what servers/tools it connects.
   - If the content is opaque (JSON settings, binary-like), describe it based on the filename and type.

3. **topics**: 1-4 HIGH-LEVEL engineering domains from the allowed vocabulary.
   These are governance categories, NOT specific technologies:
   - 'architecture' → INTERNAL design of THIS repo: patterns, DDD, clean architecture, layers, module boundaries within the codebase
   - 'cross-repo-architecture' → How this service relates to OTHER services/repos: upstream/downstream dependencies, inter-service API contracts, shared message channels/events, service topology (e.g. "publishes order.created consumed by shipping-service", "calls payment-service for refunds"). NOT a mere technology mention ("uses Kafka") without an inter-service relationship.
   - 'coding-standards' → Linting, formatting, naming conventions, code style, best practices
   - 'testing' → Unit tests, integration tests, e2e, coverage, TDD
   - 'developer-experience' → Local setup, Makefiles, DX tooling, IDE config, onboarding
   - 'ci-cd' → CI/CD pipelines, deployments, Docker, Kubernetes, GitHub Actions
   - 'observability' → Logging, monitoring, error tracking, Sentry, APM, alerting
   - 'security' → Auth, OWASP, XSS, CSRF, input validation, secrets management
   - 'data-management' → Databases, migrations, caching, data modeling, Prisma, Redis
   - 'workflow' → Git branching, PR processes, Jira, project management, code review
   - 'business-domain' → Domain-specific logic, business rules, product features
   - 'documentation' → JSDoc, TSDoc, README, changelog, API docs, inline comments

4. **technologies**: Specific tools, frameworks, or languages mentioned in the content.
   Examples: 'react', 'typescript', 'php', 'docker', 'sentry', 'prisma', 'jest', 'eslint'.
   Keep lowercase. Max 5. Empty array if nothing specific is identifiable.

RULES:
- If the content is too short or opaque, write a generic description based on the config name and type.
- NEVER return markdown formatting in the intent field.
- ALWAYS return at least 1 topic.
- PRIORITY: If the file documents interactions with OTHER services/repositories, you MUST include 'cross-repo-architecture'. It takes priority — drop a lower-value topic before dropping it. It may coexist with 'architecture' when the file ALSO documents internal code patterns.
- CRITICAL: The topics array MUST contain EXACTLY 1, 2, 3, or 4 items. NEVER return 5 or more topics. If the config touches many domains, pick only the 4 most important ones. Returning more than 4 will crash the system.
- technologies should be LOWERCASE.`,
            model: getModel('ingest'),
        });
    }
    return _agent;
}

export { AgenticMetadataSchema as AgenticMetadataExtractionSchema };
