/**
 * CLI Command: cr mcp start
 *
 * Silent stdio MCP server. Called by IDEs behind the scenes.
 * All logger output is suppressed to keep stdout clean for JSON-RPC.
 */

import { Command } from 'commander';
import { logger } from '../../../utils/logger.js';


export function registerMcpStartCommand(parent: Command): void {
    parent
        .command('start')
        .description('Start the MCP stdio server (called by IDEs behind the scenes)')
        .action(async () => {
            const { Neo4jMcpRepository } = await import('../../../graph/repositories/mcp.js');
            try {
                // Suppress all logger output — stdio must be clean for JSON-RPC
                logger.setSilent(true);

                const { startMcpServer } = await import('@coderadius/mcp-server');
                const repository = new Neo4jMcpRepository();
                await startMcpServer(repository);
                // The process remains running to handle stdio
            } catch (err) {
                // Write errors to stderr only — never pollute stdout
                console.error('Failed to start MCP server:', (err as Error).message);
                process.exit(1);
            }
        });
}
