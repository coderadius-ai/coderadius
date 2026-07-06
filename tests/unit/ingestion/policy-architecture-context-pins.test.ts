import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicies, getBuiltinPacksDir } from '../../../src/policy-runner/loader.js';
import { MCP_SERVER_NAME } from '../../../src/mcp/constants.js';

// YAML cannot import TS constants, so the MCP server name is duplicated as a
// string literal inside the policy query. Pin it against the single source of
// truth so a rename fails loudly here instead of silently breaking the OK
// verdict in production.

const RULE_PATH = path.join(getBuiltinPacksDir(), 'agent-readiness', 'ar-architecture-context.yaml');

describe('ar-architecture-context: literal pins', () => {
    it('loads as a valid, read-only policy rule', async () => {
        const rules = await loadPolicies({ rulesPath: RULE_PATH });
        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('ar-architecture-context');
        expect(rules[0].tags).toContain('agent-readiness');
    });

    it('embeds the MCP server name from the source constant', () => {
        const yaml = fs.readFileSync(RULE_PATH, 'utf-8');
        expect(yaml).toContain(`trim(x) = '${MCP_SERVER_NAME}'`);
    });

    it('matches the cross-repo-architecture topic by exact membership, not substring', () => {
        // 'architecture' is a substring of 'cross-repo-architecture'; a CONTAINS-based
        // match would mis-count. Pin the exact split+trim membership test instead.
        const yaml = fs.readFileSync(RULE_PATH, 'utf-8');
        expect(yaml).toContain(`trim(x) = 'cross-repo-architecture'`);
    });
});
