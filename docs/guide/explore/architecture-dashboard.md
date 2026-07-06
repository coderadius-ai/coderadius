# Architecture Dashboard

`cr ui` renders every architectural signal CodeRadius has extracted: service inventory, policy compliance, blast radius, AI-tooling readiness, single points of failure, and package health. All are combined into one self-contained HTML file. No server, no database connection for the person reading it: open it in a browser, or attach it to a Slack message, or archive it as a CI artifact.

> **Note:** If you're evaluating CodeRadius for the first time, start with [Governance](../governance.md), [Impact Evaluation](../impact-evaluation.md), or [MCP Server](../mcp-server.md). The dashboard is the reporting layer on top of those workflows, not a replacement for them.

```bash
cr ui
```

This connects to your Memgraph instance, runs every domain's queries concurrently, and writes a zero-dependency HTML file that opens automatically in your default browser.

---

## Dashboard Domains

The dashboard has **six domains**, each its own sidebar entry:

| Domain | Sidebar Label | What It Shows |
|--------|---------------|---------------|
| System Registry | System Registry | Auto-generated service catalog: repositories, services, endpoints, teams |
| Governance | Governance | Policy compliance against your loaded rule packs, rule-by-rule and entity-by-entity |
| Blast Radius Explorer | Blast Radius Explorer | Interactive topology graph of cross-service dependencies and downstream impact |
| Agent Harness | Agent Harness | Per-repo AI-agent readiness verdict, plus fleet-wide skill duplication |
| SPOFs | SPOFs | Single points of failure: data monoliths and service bottlenecks |
| Package Intelligence | Package Intelligence | Package inventory, internal registry adoption, CVE exposure |

Each domain is documented on its own page, linked at the bottom of this one.

---

## Generating the Dashboard

### Basic Usage

```bash
# Generate and auto-open in browser
cr ui

# Write to a specific file instead of opening a browser
cr ui --out ./reports/health-$(date +%Y-%m-%d).html

# Focus on one domain
cr ui --focus gravity

# Focus on several domains at once (comma-separated)
cr ui --focus governance,inventory

# Output the raw JSON payload for CI/headless pipelines
cr ui --json
```

### Options Reference

| Option | Default | Description |
|--------|---------|--------------|
| `--out <file>` | Auto-generated temp file | Write the HTML report to a specific path instead of auto-opening |
| `--focus <domains>` | All domains | Comma-separated list of domains to render. Allowed values: `inventory`, `governance`, `blast`, `agentic-radar`, `gravity`, `deps` |
| `--json` | `false` | Output the raw JSON payload to stdout (no HTML rendering) |

> **Note:** When `--focus` is used, the sidebar is suppressed and the dashboard renders as a single- or multi-domain report, useful for Slack notifications, stakeholder emails, or CI artifacts that need to stay focused on one concern.

### CI/CD Automation

Schedule the dashboard as a weekly artifact:

#### GitHub Actions

```yaml
name: "Weekly Architecture Health Report"
on:
  schedule:
    - cron: '0 8 * * 1'  # Every Monday at 08:00 UTC

jobs:
  dashboard:
    runs-on: ubuntu-latest
    steps:
      - name: Install CodeRadius
        run: curl -sSL https://cdn.coderadius.ai/install.sh | bash

      - name: Generate Dashboard
        env:
          MEMGRAPH_URI: ${{ secrets.CODERADIUS_MEMGRAPH_URI }}
        run: cr ui --out health-report.html

      - name: Upload Artifact
        uses: actions/upload-artifact@v4
        with:
          name: architecture-dashboard
          path: health-report.html
```

#### GitLab CI/CD

```yaml
architecture_dashboard:
  stage: report
  image: node:20-alpine
  before_script:
    - curl -sSL https://cdn.coderadius.ai/install.sh | bash
  script:
    - cr ui --out health-report.html
  artifacts:
    paths:
      - health-report.html
    expire_in: 30 days
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

---

## Reading the Header Stats Bar

The top of the dashboard shows a horizontal bar of KPIs. Each active domain contributes its own metrics to this bar:

| Metric | Source Domain | Meaning |
|--------|--------------|---------|
| **Registered** | System Registry | Total repositories in the graph |
| **Compliance**, **Rules**, error/warning counts | Governance | Percentage of entities fully policy-compliant, and rule pass/fail counts |
| **Repositories**, **Total Catalog**, **Governance Alerts** | Agent Harness | Repos scored, size of the deduplicated capability catalog, and a combined count of tech blindspots + skill recommendations + duplicate clusters |
| **Seismic**, **Critical**, **High**, **Services at Risk** | SPOFs | Counts of resources at each SPOF tier, and the number of distinct services touched by any of them |

When you use `--focus`, only the metrics for the focused domain(s) are shown.

---

## Understanding the Sidebar

Each sidebar entry shows a domain icon and label, a page title and subtitle, and domain-specific header stats that replace the global bar when that domain is selected. Clicking an entry scrolls to that domain and swaps the header stats accordingly.

---

## Domain Deep-Dives

- **[System Registry](./system-registry.md)**: The auto-generated service catalog. Repositories, services, endpoints, teams, depth, and liveness data.
- **[Governance](../governance.md)**: Policy-as-code compliance. Rule packs, per-entity evaluation, and the `agent-readiness` pack that feeds the Agent Harness.
- **[Blast Radius Explorer](./blast-radius-scoring.md)**: Downstream gravity scoring and impact tiers for every node in the topology.
- **[Agent Harness](./agentic-radar.md)**: Per-repo AI-agent readiness verdict and cross-team skill duplication.
- **[SPOFs & Data Gravity](./data-gravity.md)**: Single points of failure: data monolith and service bottleneck ranking.
- **[Vulnerability Scanning](../vulnerability-scanning.md)**: CVE exposure across the fleet, surfaced on the Package Intelligence tab.

---

## JSON Output Schema

```bash
# Pipe to jq for inspection
cr ui --json | jq '.inventory.summary'

# Save to file
cr ui --json > dashboard-$(date +%Y%m%d).json
```

The payload has one key per domain: `inventory`, `governance`, `topology`, `radar`, `gravity`, `deps`. Two payload keys differ from their `--focus` names: `--focus blast` fills `topology`, and `--focus agentic-radar` fills `radar`. Each key holds the full data set that domain's UI renders from. A domain key is `null` if `--focus` excluded it. Build custom dashboards, Slack bots, or monitoring integrations directly on top of this.

---

## Further Reading

- [CLI Reference: cr ui](../cli-commands.md#architecture-dashboard): Full command documentation
- [Governance](../governance.md): Policy-as-code rules that feed the Governance domain and the Agent Harness readiness verdict
