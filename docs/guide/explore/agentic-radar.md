# Agent Harness

Agent Harness is the fleet-wide view of AI-tooling adoption: which repositories are safe to let an agent work in unsupervised, which skills exist across the organization and where they've been duplicated instead of shared. It's built for engineering leaders managing enough repositories that they can no longer answer "is this codebase safe for an agent to touch?" from memory.

It answers questions like:

- *"Which of our repositories can an agent be trusted to work in autonomously, and which need a human in the loop?"*
- *"What's blocking repo X from being agent-ready, and what do I run to fix it?"*
- *"Which team built a reusable skill that three other teams have quietly reimplemented?"*

---

## The Problem at Scale

When an organization adopts AI coding tools, each team configures them independently. Within weeks: one team writes a `.cursorrules` file encoding real architectural constraints; another team spends the same two weeks rebuilding an almost identical file from scratch, unaware the first one exists; most teams have no rules at all, and their agents operate with zero organizational context.

That's context debt at the organizational level. Agent Harness makes it visible: per repository, and per skill.

---

## How It Works

### Data Collection: the Agentic Config Plugin

The Agentic Config Plugin runs as part of the standard ingestion pipeline. It scans every repository for AI configuration files, matching patterns for 31 recognized tool identifiers (Cursor, Claude, Windsurf, Copilot, Gemini, and 26 others, including a generic catch-all and a knowledge-base detector). A few of the patterns:

```
.cursorrules                    → Cursor global rules
.cursor/rules/*.{md,mdc}        → Cursor scoped rules
.cursor/mcp.json                → Cursor MCP server configuration
.windsurfrules                  → Windsurf global rules
.github/copilot-instructions.md → GitHub Copilot instructions
CLAUDE.md                       → Claude global instructions
GEMINI.md                       → Gemini global instructions
AGENTS.md                       → Generic, tool-agnostic agent instructions
.agents/skills/*/SKILL.md       → Generic portable skills
langgraph.json                  → LangGraph multi-agent configuration
agents.yaml                     → CrewAI agent definitions
```

See [Context Engineering](./context-engineering.md) for the full pattern tables.

For every file matched, the plugin extracts:

| Property | Description |
|----------|-------------|
| `tool` | The AI tool the file targets (`cursor`, `claude`, `windsurf`, ...) |
| `configType` | The functional role: `global_rule`, `scoped_rule`, `skill`, `workflow`, `mcp_config`, `subagents_config`, etc. |
| `topics` | Auto-extracted keyword categories (security, testing, architecture, ci-cd, database, ...) |
| `contentFingerprint` | A normalized hash for near-duplicate detection; resilient to cosmetic differences between copies |
| `description` | Extracted from frontmatter or the first heading in the file |

Each match becomes an `AgenticConfig` node, linked to the owning service and, transitively, to its team and repository.

### The Graph Traversal

```
(Repository)<-[:STORED_IN]-(Service)-[:HAS_AGENTIC_CONFIG]->(AgenticConfig)
(Team)-[:OWNS]->(Service)
```

If a repository has no team ownership recorded in the graph, its configs are attributed to the repository's GitHub org as a fallback.

### Liveness

The registry's [Pulse tiers](./system-registry.md#pulse-liveness) (`elite`/`high`/`medium`/`low`/`unknown`) apply to every repository shown here too. There is currently **no liveness filter** anywhere in Agent Harness. A 0-commit repo counts exactly the same as an active one in every score and count on this page. If you need to exclude dormant repos from your own analysis, filter on `livenessCommits` yourself; the dashboard doesn't do it for you.

---

## Two Views: Readiness and Skill Library

Agent Harness has two tabs.

### Readiness

Readiness answers: *for this repository, can an agent be trusted to work autonomously, or does it need supervision?* The verdict is derived entirely from your loaded [governance](../governance.md) rules, specifically every rule tagged `agent-readiness`. Nine ship by default:

| Rule | Level | What it checks |
|------|-------|-----------------|
| `ar-tests-present` | error | CI pipeline includes a test stage |
| `ar-codeowners` | warning | At least one team owns the repository |
| `ar-rules-validated` | warning | An agent rules file exists (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, ...) |
| `ar-blast-radius` | warning | Repo has been analyzed at `semantic` or `contracts` depth, so blast radius is computable |
| `ar-architecture-context` | warning | Agent context covers cross-repo topology (APIs, events, shared data), not just internals, ideally grounded via the CodeRadius MCP |
| `ar-skills-coverage` | warning | At least one agent skill is defined |
| `ar-makefile-targets` | warning | A Makefile exposes `setup`, `test`, and `run` targets |
| `ar-context-actionable` | warning | Agent context carries tooling commands (build/test/CI), not just prose overview |
| `ar-context-minimal` | warning | Agent context files aren't bloated past the size that's shown to help |

**Scoring:** each check is weighted by level (`error` = 3, `warning` = 2), and the repo's score is `passed weight / total weight × 100`, rounded. The verdict:

| Score | Verdict |
|-------|---------|
| ≥ 80 | **Autonomous** |
| 50-79 | **Supervised** |
| < 50 | **Off-limits** |

A failed `error`-level check (only `ar-tests-present` today) caps the verdict at **Supervised** even if the weighted score alone would clear 80. An untested repo never gets a green light regardless of how much else it has going for it.

Each failing check produces a remediation action. Where a `cr` command exists, the UI gives you a copy-paste button (e.g. `ar-blast-radius` → `cr analyze code`, `ar-architecture-context` → `cr analyze code && cr mcp configure`). Where the fix is manual (add a CODEOWNERS file, trim a bloated context file), it says so instead of pretending a command can do it.

The table itself: **Score**, **Repository** (with team), **Verdict**, **Checks** (a pass/fail signal bar), **Activity** (commit-based liveness bar). Sorted by score descending by default. The fleet header above the table rolls all repos into one average score plus an Autonomous/Supervised/Off-limits distribution bar.

**Export policy**: the "Export policy" button runs `cr policy export agent-readiness`, writing the pack to `.coderadius/policies/` so you can customize thresholds locally. Wire it into CI with:

```bash
cr policy verify --rules-path agent-readiness --fail-on warning
```

If the Readiness tab shows nothing, it's because no `agent-readiness`-tagged rules have been evaluated yet. Run `cr analyze code` and the pack ships and evaluates automatically; nothing to install separately.

### Skill Library

Every agent skill across the fleet, in one searchable list. A skill is either **duplicated** (the same capability exists in more than one service, detected via cross-repo semantic similarity above a 0.90 cosine-similarity threshold on the skill's embedding) or it isn't. There's no adoption-tier ladder underneath that; a skill is either flagged for consolidation or it's just part of the library.

Each entry shows its owner, consumer services (adopted count vs. total), and (for duplicated skills) the specific competing copies with their similarity score and team. Filter to duplicates-only with the "Duplicated" chip, or search by name/team.

Semantic duplicate detection requires embeddings to be configured. Without them, the tab still lists every skill, just with `duplicated: 0`.

---

## Maturity Levels (Computed, Not a Rendered Tab)

Every repository is still assigned an **Agentic Maturity Level** from `L0` to `L4`, computed from the presence and sophistication of its AI configurations. This computation feeds the underlying data (available via the JSON payload and MCP tools) but the current dashboard has no dedicated maturity histogram or matrix view. If you built a workflow around watching a maturity distribution shift over time, you'll need to read `matrix[].maturityLevel` from `cr ui --json` yourself for now.

### L0: Dark
No AI configuration files detected.

### L1: Aware
At least one config file exists, but it's empty or minimal (under 200 characters).

### L2: Configured
A non-empty rule file exists (200+ characters), enough to encode real constraints.

### L3: Skilled
The repository has at least one custom **Skill** or **Workflow**, a portable, executable capability.

### L4: Orchestrated
Either multi-agent subagent configs exist (`.roomodes`, `.clinemodes`, `agents.yaml`), or the repo combines an **MCP server** + **scoped rules** + at least one **workflow** into a full pipeline.

> **Note:** For practical templates at each level (what to actually write), see [Context Engineering](./context-engineering.md).

---

## Signals Feeding "Governance Alerts"

The header stat **Governance Alerts** is a sum of four computed-but-not-yet-tabbed signals:

- **Tech blindspots**: a widely-used technology (React, Postgres, NestJS, ...) with repos that depend on it but carry no AI context mentioning it
- **Skill recommendations**: cross-team skill-transplant suggestions based on shared package overlap between a source team and a target team
- **Duplicates**: structural (fingerprint-exact) config duplicates across repos
- **Semantic duplicates**: near-duplicate configs found via embedding similarity, cross-service

None of these four currently has its own tab in the dashboard. They're real fields on the report (`techBlindspots`, `skillRecommendations`, `duplicates`, `semanticDuplicates`). The fastest way to get at them today is `cr ui --json | jq '.radar'`.

---

## Frequently Asked Questions

**Q: Agent Harness only shows 2 repositories. I expected 300.**

You're reading from your local Memgraph instance. Check that `MEMGRAPH_URI` points to the production graph, not a dev instance, before running `cr ui`.

**Q: A critical repository shows "Off-limits" and I don't understand why.**

Open its row in the Readiness tab and look at the Checks column. It's a direct pass/fail breakdown against the nine `agent-readiness` rules. Off-limits means the weighted score is below 50, so more than half the checks are failing; it's rarely one rule. If the score would otherwise clear 80 but the verdict is stuck at Supervised, that's the single `error`-level check (`ar-tests-present`, missing CI test stage) capping it. That's a different, narrower signal from full Off-limits.

**Q: How do I run this against the production graph automatically?**

Schedule `cr ui --out health-$(date +%Y-%m-%d).html` as a weekly cron job or GitHub Actions workflow against your production Memgraph credentials, and archive the output somewhere your team can reach it.

---

## Further Reading

- [Context Engineering](./context-engineering.md): Practical templates for reaching each maturity level, and the full supported config-format tables
- [Governance](../governance.md): The policy engine that computes the Readiness verdict
- [System Registry](./system-registry.md): Liveness tiers and the repository detail drawer referenced above
