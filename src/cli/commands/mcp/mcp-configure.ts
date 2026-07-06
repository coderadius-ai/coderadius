/**
 * CLI Command: cr mcp configure
 *
 * Interactive wizard that auto-detects IDE environments and injects
 * MCP server configuration. Supports Cursor, Windsurf, Claude Desktop,
 * Claude Code (via CLI), and Gemini CLI.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { MCP_SERVER_NAME } from '../../../mcp/constants.js';

// ─── MCP Payload ────────────────────────────────────────────────────────────

const MCP_SERVER_ENTRY = {
    command: 'cr',
    args: ['mcp', 'start'],
};

// ─── Target Registry ────────────────────────────────────────────────────────

interface IdeTarget {
    name: string;
    detect: () => boolean;
    supportsLocal: boolean;
    method: 'json' | 'cli';
    globalPath?: () => string;
    localPath?: () => string | null;
}

function buildTargetRegistry(): IdeTarget[] {
    return [
        {
            name: 'Cursor',
            detect: () => fs.existsSync(path.join(os.homedir(), '.cursor')),
            globalPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
            localPath: () => path.join(process.cwd(), '.cursor', 'mcp.json'),
            supportsLocal: true,
            method: 'json',
        },
        {
            name: 'Windsurf',
            detect: () => fs.existsSync(path.join(os.homedir(), '.codeium', 'windsurf')),
            globalPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
            localPath: () => path.join(process.cwd(), '.windsurf', 'mcp_config.json'),
            supportsLocal: true,
            method: 'json',
        },
        {
            name: 'Claude Desktop',
            detect: () => {
                if (process.platform !== 'darwin') return false;
                return fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Claude'));
            },
            globalPath: () => path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
            localPath: () => null,
            supportsLocal: false,
            method: 'json',
        },
        {
            name: 'Claude Code',
            detect: () => {
                try {
                    execSync('which claude', { stdio: 'pipe' });
                    return true;
                } catch {
                    return false;
                }
            },
            supportsLocal: true,
            method: 'cli',
        },
        {
            name: 'Antigravity',
            detect: () => fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity')),
            globalPath: () => path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
            localPath: () => null,
            supportsLocal: false,
            method: 'json',
        },
        {
            name: 'Gemini CLI',
            detect: () => fs.existsSync(path.join(os.homedir(), '.gemini')),
            globalPath: () => path.join(os.homedir(), '.gemini', 'settings.json'),
            localPath: () => path.join(process.cwd(), '.gemini', 'settings.json'),
            supportsLocal: true,
            method: 'json',
        },
    ];
}

// ─── Safe JSON Patching ─────────────────────────────────────────────────────

function patchMcpConfig(filePath: string): { action: 'created' | 'updated' | 'skipped'; path: string } {
    const fileAlreadyExisted = fs.existsSync(filePath);
    let config: any = {};

    if (fileAlreadyExisted) {
        try {
            config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            // Malformed JSON — back up and start fresh
            const backupPath = filePath + '.bak';
            fs.copyFileSync(filePath, backupPath);
            config = {};
        }
    }

    if (!config.mcpServers) {
        config.mcpServers = {};
    }

    if (config.mcpServers[MCP_SERVER_NAME]) {
        return { action: 'skipped', path: filePath };
    }

    config.mcpServers[MCP_SERVER_NAME] = { ...MCP_SERVER_ENTRY };

    // Create parent directories if needed
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    return { action: fileAlreadyExisted ? 'updated' : 'created', path: filePath };
}

// ─── Claude Code CLI ────────────────────────────────────────────────────────

function configureClaudeCode(scope: 'user' | 'project'): { success: boolean; command: string; error?: string } {
    const args = [
        'mcp', 'add',
        '--transport', 'stdio',
        '--scope', scope,
        MCP_SERVER_NAME,
        '--',
        MCP_SERVER_ENTRY.command,
        ...MCP_SERVER_ENTRY.args,
    ];

    const command = `claude ${args.join(' ')}`;

    try {
        execSync(command, { stdio: 'pipe' });
        return { success: true, command };
    } catch (err) {
        return { success: false, command, error: (err as Error).message };
    }
}

// ─── Wizard ─────────────────────────────────────────────────────────────────

export function registerMcpConfigureCommand(parent: Command): void {
    parent
        .command('configure')
        .description('Interactive wizard to configure MCP in your IDE environments')
        .action(async () => {
            console.log();
            p.intro(chalk.bgCyan.black(' CODERADIUS MCP SETUP '));

            // 1. Detect available IDE environments
            const allTargets = buildTargetRegistry();
            const detected = allTargets.filter(t => t.detect());

            if (detected.length === 0) {
                p.log.warn('No compatible IDE environments detected.');
                p.log.info('Supported: Cursor, Windsurf, Claude Desktop, Claude Code, Gemini CLI');
                p.outro(chalk.dim('Install a supported IDE and try again.'));
                return;
            }

            // Show what was detected
            const detectedSummary = detected.map(t => {
                const scopeHint = t.method === 'cli'
                    ? 'via CLI'
                    : t.supportsLocal
                        ? 'global + local'
                        : 'global only';
                return `${chalk.green('●')} ${t.name} ${chalk.dim(`(${scopeHint})`)}`;
            }).join('\n');

            p.note(detectedSummary, 'Detected environments');

            // 2. Multi-select which targets to configure
            const selectedTargets = await p.multiselect({
                message: 'Select targets to configure:',
                options: detected.map(t => ({
                    value: t.name,
                    label: t.name,
                    hint: t.method === 'cli' ? 'via CLI' : t.supportsLocal ? 'global + local' : 'global only',
                })),
                initialValues: detected.map(t => t.name),
                required: true,
            });

            if (p.isCancel(selectedTargets)) {
                p.cancel('Setup cancelled.');
                process.exit(0);
            }

            const targets = detected.filter(t => (selectedTargets as string[]).includes(t.name));

            // 3. Ask scope per target (only when it supports both)
            const targetScopes: Map<string, 'global' | 'local'> = new Map();

            for (const target of targets) {
                if (target.method === 'cli' && target.supportsLocal) {
                    // Claude Code: user (global) / project (local)
                    const scope = await p.select({
                        message: `${target.name} — Installation scope:`,
                        options: [
                            { value: 'global', label: 'Global', hint: '--scope user (all projects)' },
                            { value: 'local', label: 'Local', hint: '--scope project (current workspace)' },
                        ],
                        initialValue: 'global',
                    });

                    if (p.isCancel(scope)) {
                        p.cancel('Setup cancelled.');
                        process.exit(0);
                    }

                    targetScopes.set(target.name, scope as 'global' | 'local');
                } else if (target.supportsLocal) {
                    // JSON-patched targets with both scopes
                    const scope = await p.select({
                        message: `${target.name} — Installation scope:`,
                        options: [
                            { value: 'global', label: 'Global', hint: target.globalPath?.() || '' },
                            { value: 'local', label: 'Local', hint: `${path.basename(target.localPath?.() || '')} (current workspace)` },
                        ],
                        initialValue: 'global',
                    });

                    if (p.isCancel(scope)) {
                        p.cancel('Setup cancelled.');
                        process.exit(0);
                    }

                    targetScopes.set(target.name, scope as 'global' | 'local');
                } else {
                    // Global-only targets (Claude Desktop)
                    targetScopes.set(target.name, 'global');
                }
            }

            // 4. Execute configuration
            const results: Array<{ name: string; success: boolean; detail: string }> = [];

            for (const target of targets) {
                const scope = targetScopes.get(target.name) || 'global';
                const spinner = p.spinner();
                spinner.start(`Configuring ${target.name}...`);

                if (target.method === 'json') {
                    const filePath = scope === 'local'
                        ? target.localPath?.()
                        : target.globalPath?.();

                    if (!filePath) {
                        spinner.stop(`${target.name}: no path available for scope '${scope}'`);
                        results.push({ name: target.name, success: false, detail: 'No config path available' });
                        continue;
                    }

                    try {
                        const result = patchMcpConfig(filePath);
                        const relativePath = filePath.startsWith(os.homedir())
                            ? '~' + filePath.slice(os.homedir().length)
                            : path.relative(process.cwd(), filePath);

                        if (result.action === 'skipped') {
                            spinner.stop(`${target.name}: already configured in ${relativePath}`);
                            results.push({ name: target.name, success: true, detail: `Already configured (${relativePath})` });
                        } else {
                            spinner.stop(`${target.name}: wrote ${relativePath}`);
                            results.push({ name: target.name, success: true, detail: `Wrote ${relativePath}` });
                        }
                    } catch (err) {
                        spinner.stop(`${target.name}: failed`);
                        results.push({ name: target.name, success: false, detail: (err as Error).message });
                    }
                } else if (target.method === 'cli') {
                    // Claude Code
                    const cliScope = scope === 'local' ? 'project' : 'user';
                    const result = configureClaudeCode(cliScope);

                    if (result.success) {
                        spinner.stop(`${target.name}: configured (--scope ${cliScope})`);
                        results.push({ name: target.name, success: true, detail: `Ran: ${result.command}` });
                    } else {
                        spinner.stop(`${target.name}: failed`);
                        results.push({ name: target.name, success: false, detail: result.error || 'Unknown error' });
                    }
                }
            }

            // 5. Summary
            const allSucceeded = results.every(r => r.success);
            const summary = results.map(r => {
                const icon = r.success ? chalk.green('ok') : chalk.red('x');
                return `${icon} ${r.name}: ${r.detail}`;
            }).join('\n');

            if (!allSucceeded) {
                p.note(summary, 'Results');
                p.log.warn('Some targets failed. Check the errors above.');
            }

            p.outro(allSucceeded
                ? chalk.green('Done! Restart your IDE to activate CodeRadius.')
                : chalk.yellow('Completed with errors. Check the summary above.'));
        });
}
