/**
 * Canonical MCP server identity. Owned here (neutral), consumed by the CLI
 * wizard (`cr mcp configure`) and asserted by the ar-architecture-context
 * policy, which treats a configured `coderadius` MCP server as a grounding
 * link between AI agents and the live architecture graph.
 */
export const MCP_SERVER_NAME = 'coderadius';
