# MCP Server

An AI coding agent editing `orders-service` has no idea that `shipping-service` and `notification-service` both read from the same `orders` table. It will rename a field, change a response shape, or drop a message payload without knowing who breaks. The CodeRadius MCP (Model Context Protocol) server closes that gap: it exposes your architecture graph as a set of callable tools, so an agent running inside Cursor, Claude, or Windsurf can query real service topology, data contracts, and blast radius mid-task instead of guessing.

## What Is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard for connecting AI models to external tools. An MCP server exposes typed tools; an agent calls them during a conversation and gets structured JSON back. CodeRadius implements an MCP server that turns your architecture graph into exactly that kind of tool set, with no manual copy-pasting of service names or schemas into the agent's context window.

## Starting the Server

```bash
cr mcp start
```

The server uses the `stdio` transport (standard input/output). Your IDE spawns the process and keeps it alive for the duration of the session; you don't run this manually except to debug it.

## Connecting Your IDE

### Automatic: `cr mcp configure`

```bash
cr mcp configure
```

An interactive wizard that detects which of Cursor, Windsurf, Claude Desktop, Claude Code, Antigravity, and Gemini CLI are installed on your machine, then writes the MCP registration for you. Choose between global (all projects) or local (current workspace) scope per target. For Claude Code it shells out to `claude mcp add` instead of patching JSON directly. This is also suggested automatically at the end of every `cr analyze code` run.

### Manual: edit the config file yourself

If you'd rather not run the wizard, or you're on a client it doesn't detect, register the server by hand. All JSON-based clients use the same shape: a `cr` command with `mcp start` as its args, under a `coderadius` key in `mcpServers`.

Where each client keeps that file:

| Client | Global | Per-project |
|--------|--------|-------------|
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/mcp_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | not supported |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | not supported |
| Claude Code | via CLI, see below | via CLI, see below |

**Cursor**: `.cursor/mcp.json` (repo-local) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "coderadius": {
      "command": "cr",
      "args": ["mcp", "start"]
    }
  }
}
```

**Claude Desktop (macOS)**: `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "coderadius": {
      "command": "cr",
      "args": ["mcp", "start"]
    }
  }
}
```

**Windsurf**: `~/.codeium/windsurf/mcp_config.json` (global) or `.windsurf/mcp_config.json` (local):

```json
{
  "mcpServers": {
    "coderadius": {
      "command": "cr",
      "args": ["mcp", "start"]
    }
  }
}
```

**Claude Code** registers servers through its CLI rather than a JSON file you edit:

```bash
claude mcp add --transport stdio --scope user coderadius -- cr mcp start
```

Use `--scope project` instead of `--scope user` to register it for the current workspace only (this writes a `.mcp.json` you can commit for the whole team).

**Mastra** (programmatic, for multi-agent workflows):

```typescript
import { MCPClient } from '@mastra/mcp';

const coderadiusClient = new MCPClient({
  servers: {
    coderadius: {
      command: 'cr',
      args: ['mcp', 'start'],
    },
  },
});

const tools = await coderadiusClient.getTools();
```

The server identifies itself over the wire as protocol name `radius`, distinct from the `coderadius` key you register it under in `mcpServers`. This only matters if you're inspecting raw JSON-RPC handshake frames; it has no effect on configuration.

## Available Tools

Agents tend to call these in a predictable arc: orient (`resolve_service_context`), explore the fleet (`list_services`, `get_service_details`, `get_repository_details`), then check impact before touching anything shared (`analyze_blast_radius`, `trace_data_lineage`, `get_data_contract`, `evaluate_code_change_impact`). `analyze_architecture_gravity` and `analyze_agentic_context` are whole-graph scans used in review and org-intelligence workflows rather than per-task.

Every tool that resolves a name (a service, a resource, a field) supports fuzzy matching. If a name is ambiguous, the tool returns a warning listing the candidate URNs. Call again with the exact URN.

### `resolve_service_context`

**Purpose**: Identifies which service a file, repository URL, or repository name belongs to, plus its owning team and language. Tool description tells agents to call this first.

**Input parameters** (all optional, but pass at least one):

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | string | A file path from the workspace, relative or absolute (e.g. `apps/checkout/src/handlers/create-order.ts`). Matched against known service paths. |
| `repositoryUrl` | string | The git remote URL (e.g. `github.com/acme/orders`). |
| `repositoryName` | string | The repository name. |

**Example response**: an array, not a single object (a file path can match more than one service in a monorepo):

```json
[
  {
    "name": "orders-service",
    "language": "TypeScript",
    "description": "Handles order creation and lifecycle.",
    "team": "commerce",
    "repository": "acme/orders",
    "repositoryUrl": "https://github.com/acme/orders",
    "pathInRepo": "apps/checkout"
  }
]
```

If nothing matches, the tool returns an empty result and a text hint to call `list_services` instead.

### `list_services`

**Purpose**: Lists every service in the graph: team, repository, languages, indexed function count, and deployment topology. Services with `deploymentUnitCount > 0` are monoliths with more than one runtime facet; use `get_service_details` to see their names.

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer (optional) | Max results, 1-200. Default 50. |
| `offset` | integer (optional) | Results to skip. Default 0. |

**Example response** (one entry):

```json
[
  {
    "id": "cr:service:orders-service",
    "name": "orders-service",
    "description": "Handles order creation and lifecycle.",
    "team": "commerce",
    "languages": ["TypeScript"],
    "repository": { "name": "acme/orders", "url": "https://github.com/acme/orders" },
    "indexedFunctionCount": 84,
    "deploymentUnitCount": 0,
    "topology": "standard"
  }
]
```

### `get_service_details`

**Purpose**: Deep detail on one service: team, repository, languages, exposed APIs with endpoint counts, indexed function count, deployment units (for monolith services), and an infrastructure block (CI/CD pipelines, Docker images, tool configs, build tasks). The tool's own description points agents to `get_data_contract` for a specific API's endpoints and `get_repository_details` for governance posture.

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `serviceName` | string | The exact service name. |

**Example response:**

```json
{
  "id": "cr:service:orders-service",
  "name": "orders-service",
  "description": "Handles order creation and lifecycle.",
  "team": "commerce",
  "languages": ["TypeScript"],
  "repository": { "name": "acme/orders", "url": "https://github.com/acme/orders", "pathInRepo": null },
  "exposedApis": [
    { "title": "Orders API", "version": "1.2.0", "endpointCount": 6, "hint": "OpenAPI" }
  ],
  "indexedFunctionCount": 84,
  "deploymentUnits": [],
  "infrastructure": {
    "ciPipelines": [{ "tool": "github-actions", "filePath": ".github/workflows/ci.yml", "hasTestStage": true, "hasDeployStage": true, "jobCount": 4 }],
    "dockerImages": [{ "name": "acme/orders-service", "tag": "latest", "filePath": "Dockerfile" }],
    "toolConfigs": [{ "tool": "renovate", "filePath": "renovate.json" }],
    "tasks": [{ "name": "test", "runner": "npm" }]
  }
}
```

### `get_repository_details`

**Purpose**: Repository-level detail: the services it hosts, CI/CD pipelines, Docker images, tool configs (tsconfig, renovate, ...), build tasks, liveness (12-month commit count), and scan mode (`structure`, `semantic`, or `contracts`, showing how deep the last analysis went).

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `repositoryName` | string | The exact repository name. |

### `analyze_blast_radius`

**Purpose**: Single-hop blast radius of a named resource: an `APIEndpoint`, `DataStructure`, `Datastore`, `DataContainer`, `MessageChannel`, or `SystemProcess`. Returns upstream producers (who writes to it) and downstream consumers (who reads from it).

**When agents use it**: Before touching a shared resource (renaming a database column, changing an API response shape, altering a message payload). "If I change this, who breaks?"

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `resourceName` | string | Name or URN of the resource. Fuzzy matching supported (e.g. `orders` matches `cr:datacontainer:orders`). |

**Example response** (resource `orders`, a `DataContainer`):

```json
{
  "target": { "urn": "cr:datacontainer:orders", "name": "orders", "type": "DataContainer" },
  "downstreamBlasts": [
    {
      "serviceName": "shipping-service",
      "serviceUrn": "cr:service:shipping-service",
      "teamOwner": "logistics",
      "relationships": ["READS"],
      "functions": [{ "name": "reserveStock", "file": "src/handlers/reserve-stock.ts" }],
      "repository": { "name": "acme/shipping", "url": "https://github.com/acme/shipping" }
    }
  ],
  "upstreamBlasts": [
    {
      "serviceName": "orders-service",
      "serviceUrn": "cr:service:orders-service",
      "teamOwner": "commerce",
      "relationships": ["WRITES"],
      "functions": [{ "name": "createOrder", "file": "src/handlers/create-order.ts" }],
      "repository": { "name": "acme/orders", "url": "https://github.com/acme/orders" }
    }
  ],
  "summary": {
    "blastRadiusScore": 42,
    "factors": {
      "downstreamServices": 1,
      "upstreamServices": 1,
      "crossTeamBlast": true,
      "teamsInvolved": 2,
      "hasWriteDependencies": true
    },
    "teamsInvolved": ["commerce", "logistics"]
  }
}
```

There is no top-level `resource` object and no singular `service`/`team`/`relationship` fields. Each blasted entry carries its own `serviceName`, `teamOwner`, and a `relationships` array (a service can both read and write, e.g. `["READS", "WRITES"]`).

### `trace_data_lineage`

**Purpose**: Follows one data field (e.g. `customerId`) across service boundaries through message channels, APIs, and databases. This is multi-hop, unlike `analyze_blast_radius`'s single hop.

**When agents use it**: A field is being renamed or retyped; the agent needs to know every downstream consumer, even two or three services away.

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `fieldName` | string | Name or URN of the field to trace. |

**Example response** (field `customerId`, produced by `orders-service`, consumed by `notification-service` via a message channel):

```json
{
  "targetField": {
    "urn": "cr:schema:message_payload:acme:orders:OrderCreatedEvent:field:customerId",
    "name": "customerId",
    "structure": "OrderCreatedEvent"
  },
  "journey": [
    {
      "serviceName": "orders-service",
      "serviceUrn": "cr:service:orders-service",
      "teamOwner": "commerce",
      "functionId": "cr:function:acme/orders:ts:src/handlers/create-order.ts::createOrder",
      "functionName": "createOrder",
      "action": "PRODUCES",
      "bridgeResource": { "name": "order.created", "type": "MessageChannel" },
      "structureName": "OrderCreatedEvent",
      "repository": { "name": "acme/orders", "url": "https://github.com/acme/orders" },
      "contractFields": [{ "fieldName": "customerId", "participation": "PRODUCES_FIELD" }]
    },
    {
      "serviceName": "notification-service",
      "serviceUrn": "cr:service:notification-service",
      "teamOwner": "platform",
      "functionId": "cr:function:acme/notification:ts:src/handlers/on-order-created.ts::onOrderCreated",
      "functionName": "onOrderCreated",
      "action": "CONSUMES",
      "bridgeResource": { "name": "order.created", "type": "MessageChannel" },
      "structureName": "OrderCreatedEvent",
      "repository": { "name": "acme/notification", "url": "https://github.com/acme/notification" },
      "contractFields": [{ "fieldName": "customerId", "participation": "CONSUMES_FIELD" }]
    }
  ],
  "summary": { "servicesTraversed": 2, "totalHops": 1, "requiresDeepScan": false }
}
```

There is no `field`/`lineage`/`hop`/`from`/`via`/`to`/`survives` shape. The real fields are `targetField`, `journey` (a list of `LineageStep`), and `summary`. `requiresDeepScan` is `true` only when the BFS walk found no journey at all. The field may still propagate through a path static analysis can't see (an untyped payload, a dynamic dispatch).

### `get_data_contract`

**Purpose**: The exact field-level schema of a payload, table, or API: names, types, and required-ness. Prevents an agent from guessing a field name.

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `structureUrn` | string (optional) | Exact `DataStructure` URN, e.g. `cr:schema:message_payload:acme:orders:OrderCreatedEvent`. Preferred (unambiguous). |
| `schemaName` | string (optional) | Schema name, e.g. `OrderCreatedEvent`. Ambiguous: the same name can identify different `DataStructure` nodes in different services once URN scoping applies. |
| `scopeKey` | string (optional) | Bounded-context scope, e.g. `acme:orders`. Combine with `schemaName` to disambiguate instead of passing `structureUrn`. |

You must supply `structureUrn` or `schemaName`. Omitting both returns an error. A bare `schemaName` still works: it resolves a best-effort match and the response echoes back the resolved `structureUrn`/`scopeKey` so a follow-up call can be precise.

**Example response:**

```json
{
  "structureUrn": "cr:schema:message_payload:acme:orders:OrderCreatedEvent",
  "scopeKey": "acme:orders",
  "schemaFields": [
    { "source": "schema", "name": "orderId", "type": "uuid", "required": true },
    { "source": "schema", "name": "customerId", "type": "uuid", "required": true },
    { "source": "schema", "name": "totalAmount", "type": "decimal", "required": true }
  ],
  "endpointContracts": []
}
```

`endpointContracts` is populated separately by matching the same name against `APIEndpoint.path` or `.name`. A schema name and a route happen to share the lookup key, so if `orders` is also a route, its endpoint fields show up there too, each entry carrying `path`, `method`, `summary`, `apiTitle`, and `fields`.

### `analyze_architecture_gravity`

**Purpose**: Global scan for Single Points of Failure: shared-database anti-patterns and services with dangerously high coupling. Returns the top 5 results ranked by SPOF score (0-100), capped for LLM context-window efficiency. For monolith services in the result, also returns `runtimeImpactedDUs`: how many deployment units would stop functioning if that node failed.

**Input**: none.

### `analyze_agentic_context`

**Purpose**: Renders the Agent Harness's maturity matrix as a markdown table: team, repository, tools used, config count, skill count, workflow count. The underlying report computes more (capability coverage, tech blind spots, skill duplicates, team-alias proposals) but only the matrix reaches this tool today; the rest is discarded before the response is built.

**Input**: none.

### `evaluate_code_change_impact`

**Purpose**: Calculates blast radius for a **proposed** change before it's committed (the Impact Evaluation Engine as an MCP tool). The agent supplies proposed file contents; CodeRadius diffs the resulting topology against the live graph and returns findings.

**When agents use it**: Agentic PR review. An agent evaluating a diff can check its blast radius before writing a review comment.

**What it actually touches**: this is not an in-memory-only operation. The tool writes each proposed file's content to its real path in the working tree (backing up any existing content first), runs extraction against that state, then restores the original content in a `finally` block. It needs write access to the repo checkout the MCP server is running against, and a crash between the write and the restore would leave the proposed content in place. The `finally` block is the only thing standing between "temporary" and "permanent."

**Input parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `changedFiles` | array | `{ path: string, proposedContent: string }` objects. `path` is repo-relative. |
| `prTitle` | string (optional) | Change description, passed to the LLM extractor as context. |

**Example usage in an agent:**

```typescript
const impact = await coderadiusMcp.callTool('evaluate_code_change_impact', {
  prTitle: 'Rename userId to customerId in payment payload',
  changedFiles: [
    {
      path: 'src/payments/dto/payment-created.dto.ts',
      proposedContent: 'export interface PaymentCreatedDto { customerId: string; /* ... */ }',
    },
  ],
});

if (impact.findings.some(f => f.severity === 'DANGER')) {
  // Revise the proposed change to be backward-compatible
}
```

## Security Considerations

Two separate credential stores back this server. Don't conflate them:

- **LLM provider keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) live in `~/.coderadius/config/credentials.json`, written by `cr init`. These belong to ingestion, not to the MCP server.
- **Memgraph connection** is controlled by environment variables, set independently of `cr init`: `MEMGRAPH_URI` (default `bolt://localhost:7687`), `MEMGRAPH_USER` and `MEMGRAPH_PASSWORD` (default `coderadius` / `coderadius`). Whoever runs `cr up` or provisions the Memgraph instance sets these.

The server exposes read-only query tools only. No tool path reaches a Cypher `CREATE`, `MERGE`, `SET`, or `DELETE`. `evaluate_code_change_impact` is the one exception worth remembering: it doesn't mutate the graph, but it does write to the filesystem temporarily (see its section above).

All communication between the MCP client (your IDE agent) and the MCP server (`cr mcp start`) is local `stdio`. No data transits the network unless the Memgraph instance itself is remote.

If your Memgraph instance holds sensitive architectural information (internal service names, database schemas, credential variable names), treat access to the MCP server with the same care as access to the graph instance itself. Restrict who can run `cr mcp start` in production environments.

## Debugging MCP Issues

**The agent doesn't seem to be calling CodeRadius tools:**
1. Verify the MCP server is registered in your IDE's MCP config file (or re-run `cr mcp configure`).
2. Restart the IDE after any configuration change.
3. Check that `cr mcp start` runs without errors from a terminal.

**Tools return empty or unexpected results:**
1. Check `MEMGRAPH_URI` (and `MEMGRAPH_USER`/`MEMGRAPH_PASSWORD` if you've overridden the defaults) points at the instance you expect. Production vs. development is the usual mixup.
2. Run `cr ui` to confirm the graph is populated.

**The server crashes on startup:**
1. Run `cr mcp start` manually. Startup errors go to stderr (stdout stays clean for the JSON-RPC protocol).
2. Confirm Memgraph is running: `cr up`.
