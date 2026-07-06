# Context Engineering with CodeRadius

Context engineering is the discipline of systematically building, distributing, and governing the instructions, constraints, and knowledge that AI coding agents use inside a codebase. In a five-person team it's informal: the senior engineer writes a `.cursorrules` file and shares it in Slack. Across 300 repositories and 20 teams, informal doesn't scale. CodeRadius exists to industrialize it: detect what context exists, where it's missing, and where it's been duplicated instead of shared.

> **Note:** This guide is for teams maturing their AI coding context systematically. If you're getting started, begin with [Governance](../governance.md) and [Impact Evaluation](../impact-evaluation.md).

---

## What Is AI Coding Context?

1. **Global rules**: always-on instructions for a repository (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`).
2. **Scoped rules**: instructions activated only for specific file patterns (`.cursor/rules/database-migrations.mdc` applies only when editing `**/migrations/**`).
3. **Skills**: portable, executable procedures the agent follows for a specific repeatable task.
4. **Workflows**: multi-step automation scripts.
5. **MCP Servers**: real-time data connections letting the agent query live systems as part of its reasoning (e.g., CodeRadius itself for blast radius data, or Jira for open tickets).

Together these form the **AI context stack** for a repository. The richer and more accurate it is, the less an agent has to guess.

---

## Reaching Each Maturity Level: In Practice

> **Note:** The L0-L4 maturity model is defined in [Agent Harness](./agentic-radar.md#maturity-levels-computed-not-a-rendered-tab). This section covers what to actually write.

### Getting to L1: Awareness

Create a global rule file and put any real content in it. Even a one-paragraph description of the service's purpose stops the agent from guessing.

```markdown
# .cursorrules (or CLAUDE.md, or AGENTS.md)

This is the **payment-service**, responsible for processing card transactions
and refunds via a card-processor API.

- Language: TypeScript (strict mode)
- Framework: NestJS with hexagonal architecture
- Database: PostgreSQL via Prisma ORM
- Never use `any` types
- All async operations must use async/await, not callbacks
```

### Getting to L2: Configuration

Expand to substantive content: domain-specific constraints, prohibited patterns, and architectural boundaries. The threshold is **200+ characters**: enough for 5-10 constraints that actually change agent behavior.

```markdown
# .cursorrules

## Architecture
This service follows Clean Architecture. Business logic lives in `src/domain/`.
Infrastructure adapters (payment processor, PostgreSQL) live in `src/infra/`.
Never import from `infra/` directly inside `domain/`.

## API Design
- All endpoints must be versioned (`/api/v1/...`)
- Request/response payloads must be validated with Zod schemas
- Raw `req.body` access is forbidden outside DTO validation layers

## Error Handling
- Never swallow errors silently. All catch blocks must log via the shared Logger.
- Payment failures must emit a `payment.failed` event to the MessageBus.

## Prohibited Patterns
- Never use `setTimeout` for business logic. Use the scheduled task system.
- Never store card data. Tokenization via the payment processor is mandatory.
- Never log PII (email addresses, names, card numbers).
```

### Getting to L3: Skills

A skill is a structured markdown file teaching the agent how to perform a specific repeatable task in this codebase.

Skill directory: `.agents/skills/<skill-name>/SKILL.md`

```markdown
---
name: "database-migration"
description: "How to create a new database migration for the payment service"
---

# Database Migration Skill

## When to use this skill
Use this when asked to add a new column, create a new table, or modify an
existing database schema in the payment service.

## Steps

1. **Create the migration file**
   Run: `npm run migration:create -- --name <descriptive-name>`
   This creates a timestamped file in `src/infra/db/migrations/`.

2. **Write the migration**
   - All migrations must be idempotent (use `IF NOT EXISTS`, `IF EXISTS`)
   - Include both `up` and `down` methods
   - Add a comment with the ticket reference: `-- TICKET: PAY-{number}`

3. **Update the Prisma schema**
   Reflect the migration in `prisma/schema.prisma`. Run: `npx prisma generate`

4. **Test the migration**
   Run: `npm run migration:run -- --env test`
   Verify it applies and rolls back cleanly.

5. **Update the seed data** (if applicable)
   Update `src/infra/db/seed.ts` with any new required reference data.
```

This skill, once committed, is detected by CodeRadius and indexed in the Agent Harness Skill Library, discoverable by anyone scanning the fleet.

### Getting to L4: Orchestration

Two paths, either one qualifies:

**Path A: MCP Integration**

```json
{
  "mcpServers": {
    "coderadius": {
      "command": "cr",
      "args": ["mcp", "start"]
    },
    "jira": {
      "command": "npx",
      "args": ["-y", "@jira/mcp-server"],
      "env": { "JIRA_API_TOKEN": "..." }
    }
  }
}
```

**Path B: Subagent Modes**

```yaml
# agents.yaml (CrewAI example: a `config/` prefix also works)
agents:
  - name: architect
    role: Senior Software Architect
    goal: Review all architectural decisions for consistency with domain boundaries
    backstory: An expert in hexagonal architecture and domain-driven design

  - name: security-reviewer
    role: Application Security Specialist
    goal: Identify OWASP violations and data exposure risks in proposed code changes
    backstory: A specialist in payment system security and PCI DSS compliance
```

---

## Distributing Context at Scale

A "Golden Path" is a curated set of AI context files every new repository gets by default: a baseline `global_rule` encoding organization-wide standards, a security-scoped rule for sensitive file patterns, and a reference to the org's core MCP server.

Typical distribution mechanisms: a Backstage template that scaffolds the Golden Path files automatically, a scheduled CI job that checks every repo for baseline files and opens a PR if missing, or a one-time seeding script for a big-bang rollout. None of these are CodeRadius features; they're standard practice for propagating any baseline config.

Once CodeRadius is ingesting the fleet, use [Agent Harness's Skill Library](./agentic-radar.md#skill-library) to find skills that exist in only one repo, generalize them, and distribute the result the same way.

---

## Supported Config File Formats

### Global Rules (always-on instructions)

| File | Tool |
|------|------|
| `.cursorrules` | Cursor |
| `CLAUDE.md` (or `CLAUDE.<x>.md`) | Claude (Anthropic) |
| `GEMINI.md` | Gemini (Google) |
| `CODEX.md` | OpenAI Codex |
| `AGENTS.md` | Generic, tool-agnostic agent instructions |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roorules` | Roo Code |
| `.voidrules` | Void |
| `.pearairules` | PearAI |
| `.goosehints` | Goose |
| `augment-guidelines.md` | Augment Code |
| `.github/copilot-instructions.md` | GitHub Copilot |

### Scoped Rules (file-pattern-activated)

| Pattern | Tool |
|---------|------|
| `.cursor/rules/*.{md,mdc}` | Cursor |
| `.claude/rules/*.{md,mdc}` | Claude |
| `.windsurf/rules/*.md` | Windsurf |
| `.cline/rules/*.md` | Cline |
| `.roo/rules/*.md` | Roo Code |
| `.amazonq/rules/*.md` | Amazon Q |
| `.agents/rules/*.md` or `.ai/rules/*.md` | Generic (also matches `_agents/` and `.blade.php` for Laravel-style agent docs) |

### Skills and Workflows

| Pattern | Type |
|---------|------|
| `.agents/skills/*/SKILL.md` | Generic Portable Skill (also matches `.ai/`, `_agents/` prefixes) |
| `.claude/skills/*/SKILL.md` | Claude Skill |
| `.claude/commands/*.md` | Claude Skill (slash command) |
| `.cursor/skills/*/skill.md` | Cursor Skill |
| `.agents/workflows/*.md` | Generic Portable Workflow |

### Subagents

| Pattern | Tool |
|---------|------|
| `.claude/agents/*.md` | Claude subagent |
| `.cline/rules-<mode>.md` | Cline custom-mode rule |
| `.roo/rules-<mode>.md` or `.roo/rules-<mode>/*.md` | Roo Code custom-mode rule |
| `.openhands/microagents/*.md` | OpenHands microagent |

### MCP Configuration Files

These are the MCP config files the scanner *detects inside the repositories it analyzes*, to map which teams have wired agents to which servers. This is not where you set up CodeRadius itself.

> Looking to connect CodeRadius's own MCP server to your IDE? Run `cr mcp configure` (an interactive wizard that detects Cursor, Windsurf, Claude Desktop, Claude Code, Antigravity, and Gemini CLI, and writes the registration for you), or add it manually:
>
> ```json
> {
>   "mcpServers": {
>     "coderadius": { "command": "cr", "args": ["mcp", "start"] }
>   }
> }
> ```
>
> Full instructions per client: [MCP Server guide](../mcp-server.md).

| File | Tool |
|------|------|
| `.cursor/mcp.json` | Cursor |
| `.cline/mcp.json` | Cline |
| `.roo/mcp.json` | Roo Code |
| `.mcp.json` (any path) | Generic |

### Multi-Agent / Orchestration

| File | Framework |
|------|-----------|
| `agents.yaml` (or `config/agents.yaml`) | CrewAI |
| `tasks.yaml` (or `config/tasks.yaml`) | CrewAI |
| `langgraph.json` | LangGraph |
| `.roomodes` or `custom_modes.yaml`/`.json` | Roo Code Custom Modes |
| `.clinemodes` | Cline Custom Modes |

### Knowledge Base

Any root-level SCREAMING_CASE markdown file (`GOLDEN_PATH.md`, `BACKBONE.md`, ...) is auto-detected as a shared-standards document, unless it's a recognized repo-hygiene file: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AUTHORS.md`, `MAINTAINERS.md`, and a handful of others in the exclusion list.

### skills.sh Ecosystem

`skills-lock.json` is recognized as a skill registry lock file. When present, each locked skill is enriched with provenance: `skillSource`, `skillSourceUrl`, `skillInstalledAt`, `skillUpdatedAt`. The Skill Library can then tell you where an installed skill actually came from.

### Other Recognized Tools

Beyond the tables above, the plugin also recognizes tool-specific settings for Antigravity, Devin, CodeRabbit, Aider, Continue, Trae, Sourcegraph Cody, Sweep, Codeium, Supermaven, AutoGen, Bolt, and Promptfoo, plus broader OpenHands `tool_settings` detection (`.openhands/*.toml`, `.openhands/*.md`, root `openhands.toml`) beyond the microagent pattern tabled above. If your tool isn't listed and it writes a config file to a predictable path, it's worth checking. New tools get added to the pattern list regularly.

### Content Fingerprint

Duplicate detection hashes a normalized version of each file's content: lowercased, frontmatter stripped, `//`, `/* */`, and `<!-- -->` comments stripped, all whitespace collapsed, then SHA-256 truncated to 16 hex characters. Two files that differ only in comments, indentation, or frontmatter hash identically.
