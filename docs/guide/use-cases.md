# Use Cases

Three scenarios where the breakage is topological, not syntactical. These issues are invisible to a linter, a code search, or a Slack thread, because none of them look inside a single file.

---

## 1. A payload field is removed, a consumer breaks silently

**Without CodeRadius**: a developer on the payment team renames `userId` to `customerId` in the body of a message published to `payment.completed`. Tests pass, review approves, it ships. Two weeks later the notification service starts throwing JSON parsing errors. It still expects `userId`. Finding the cause takes a multi-day thread across two teams.

**With CodeRadius**: the developer runs impact evaluation before pushing.

```bash
cr blast --base main --head HEAD -m "Rename userId to customerId in payment payload"
```

`cr blast` resolves downstream consumers of the `payment.completed` channel and finds two: `notification-service` (team: platform) and `reporting-service` (team: data). Because consumers exist, it reports a DANGER finding and exits `2`. The PR is blocked in CI.

```
DANGER  Breaking change on MessageChannel payment.completed

Downstream consumers:
  -> notification-service  (team: platform)
  -> reporting-service      (team: data)
```

Exit code `2` blocks the merge; `0` would mean no consumers were affected, `1` means a non-blocking warning to triage. Use `--advisory` while rolling this out gradually. It always exits `0` but still prints the finding, so teams can see what would have blocked without being blocked yet.

**Fix**: add a backward-compatible alias (`customerId` alongside a deprecated `userId`), re-run, get exit `0`.

This is cross-repo by construction: the producer and the two consumers live in different repositories owned by different teams. No file-level linter sees across that boundary.

→ [Impact Evaluation](./impact-evaluation.md)

---

## 2. An AI agent refactors an API, MCP stops it before it ships

**Without CodeRadius**: a developer asks their IDE agent to "refactor the orders endpoint to use the new response format." The agent changes `GET /api/v1/orders/{id}` by renaming fields and nesting the response differently. Tests pass, the diff looks clean. Four other internal services call this endpoint; none of them are in the current repo, none have tests against the new shape. It ships. Four services start 500ing.

**With CodeRadius (MCP)**: the agent is connected to the CodeRadius MCP server. Before writing the change, it calls `analyze_blast_radius`:

```json
{ "resourceName": "GET /api/v1/orders/{id}" }
```

The tool returns downstream consumers:

```json
{
  "downstreamBlasts": [
    { "serviceName": "acme-billing-service", "teamOwner": "finance", "relationships": ["CALLS"] },
    { "serviceName": "acme-admin-panel", "teamOwner": "internal-tools", "relationships": ["CALLS"] },
    { "serviceName": "acme-shipping-service", "teamOwner": "logistics", "relationships": ["CALLS"] },
    { "serviceName": "acme-notification-service", "teamOwner": "platform", "relationships": ["CALLS"] }
  ],
  "summary": { "factors": ["4 downstream services depend on this endpoint"] }
}
```

Given four consumers, the agent adds `GET /api/v2/orders/{id}` with the new shape and a deprecation header on v1 instead of breaking the existing endpoint. Zero breakage. This is a client-side decision the tool result makes possible, not something CodeRadius enforces on its own.

→ [MCP Server Reference](./mcp-server.md)

---

## 3. A new service ships without CI or ownership, caught the same week

**Without CodeRadius**: a team scaffolds a service, ships features for six months. During a quarterly review, someone notices there's no CI pipeline and no declared team ownership. Nobody knows who's on call. By then three developers have onboarded and learned the wrong patterns from it.

**With CodeRadius**: after ingestion, `cr policy verify` evaluates the shipped `agent-readiness` pack against the new repository and reports two violations:

| Rule | Severity | Violation |
|---|---|---|
| `ar-tests-present` | error | No CI pipeline with a test stage detected |
| `ar-codeowners` | warning | No team ownership detected |

```bash
cr policy verify --output graph
```

writes the results as `PolicyEvaluation` nodes; `cr ui` reads and renders them as a checklist in the Governance tab. (A third shipped rule, `ar-makefile-targets`, would also fire here if the repo has no `Makefile` exposing `setup`/`test`/`run` targets. Omitted above because this repo has one.)

The team lead sees this the week the repo lands, not two quarters later.

→ [Governance](./governance.md)

---

## The common thread

- A linter can't tell you a downstream service consumes your message payload.
- Code search can't tell you four services call your API endpoint.
- A catalog file can't tell you a repo is missing CI. That's a check against organizational policy, evaluated against the graph.

All three require a model of the architecture that spans repositories. That's what CodeRadius builds.

---

## Next steps

- [Governance](./governance.md): write and enforce rules like scenario 3
- [Impact Evaluation](./impact-evaluation.md): run blast radius like scenario 1
- [MCP Server](./mcp-server.md): connect an agent like scenario 2
