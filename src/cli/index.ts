#!/usr/bin/env node

// ─── Global Crash Guard ──────────────────────────────────────────────────────
// Catch unhandled rejections and uncaught exceptions with memory diagnostics.
// Bun can silently OOM-kill on large scans (300+ repos); this ensures the
// user sees a diagnostic message instead of a bare crash.
process.on('uncaughtException', (err) => {
    const rss = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    console.error(`\nFatal error (RSS: ${rss}MB): ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const rss = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`\nUnhandled rejection (RSS: ${rss}MB): ${msg}`);
    if (reason instanceof Error) console.error(reason.stack);
    process.exit(1);
});
import dotenv from 'dotenv';
import { Command } from 'commander';

// Load global credentials first (fallback)
import { loadCredentials } from '../config/credentials.js';
loadCredentials();

// Then override with local configuration
(dotenv.config as any)({ quiet: true });

// Bridge structured settings.json values to process.env for external SDKs
import { configManager } from '../config/index.js';
configManager.bridgeSettingsToEnv();

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// Install SIGINT/SIGTERM handlers so Ctrl+C aborts the AbortSignal that's
// propagated through the ingestion pipeline (LLM backoff sleeps, AIMD queue
// waiters, file batches). 1st signal = graceful, 2nd = force exit. Idempotent.
import { getRootShutdownController } from '../utils/shutdown.js';
getRootShutdownController().install(1000);

// ─── Imports ─────────────────────────────────────────────────────────────────
const program = new Command();

import pkg from '../../package.json';
import { checkAndNotifyUpdate, runBackgroundUpdater } from '../utils/updater.js';

const isCompletionRequest = process.argv.some(arg => arg.startsWith('--comp'));

if (process.env.CR_PARSE_WORKER === '1') {
    // Re-exec'd by ProcessParsePool as a parse worker (compiled binary only):
    // serve per-file tree-sitter work over IPC. Neutralize commander so the CLI
    // never runs; the IPC 'message' listener keeps the process alive until the
    // pool sends `shutdown`. See process-parse-pool.ts / parse-worker-process.ts.
    const { runParseWorkerProcess } = await import('../ingestion/processors/code-pipeline/parse-worker-process.js');
    runParseWorkerProcess();
    program.parse = () => program;
    program.parseAsync = async () => program;
} else if (process.argv[2] === 'internal-update-fetch') {
    runBackgroundUpdater();
    // Prevent the rest of the script from executing commander args
    program.parse = () => program;
    program.parseAsync = async () => program;
} else if (!isCompletionRequest) {
    checkAndNotifyUpdate(pkg.version);
}
import chalk from 'chalk';

program
    .name('cr')
    .description('CodeRadius — Architecture Intelligence for Software Teams')
    .version(pkg.version)
    .configureHelp({ showGlobalOptions: false })
    .addHelpText('beforeAll', '')
    .helpOption('-h, --help', 'Display help for command');

// ─── Custom Help Rendering ───────────────────────────────────────────────────
// Override the default flat Commander output with a categorized, branded layout.

const CORE_COMMANDS    = ['analyze', 'doctor', 'blast', 'policy', 'drift', 'ask', 'ui', 'docs'];
const SETUP_COMMANDS   = ['init', 'up', 'down', 'mcp'];
const MAINT_COMMANDS   = ['validate', 'prune', 'state', 'config'];

program.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
});

// Only render the custom branded help for the root `cr` command
program.addHelpText('afterAll', function (context) {
    // Commander passes { command } in the context — only render for root
    if (context.command !== program) return '';

    const cmds = program.commands.filter(c => !(c as any)._hidden);

    const pad = 16; // column alignment

    const formatCmd = (name: string, desc: string) => {
        return `  ${chalk.white(name.padEnd(pad))} ${chalk.dim(desc)}`;
    };

    const lines: string[] = [];

    lines.push(chalk.cyan.bold(`  ⬢ CodeRadius`) + chalk.dim(` v${pkg.version}`));
    lines.push(chalk.dim('  Architecture Intelligence for Software Teams'));
    lines.push('');

    // Core
    lines.push(chalk.cyan.bold('  Commands'));
    for (const name of CORE_COMMANDS) {
        const cmd = cmds.find(c => c.name() === name);
        if (cmd) lines.push(formatCmd(cmd.name(), cmd.description()));
    }
    lines.push('');

    // Setup
    lines.push(chalk.green.bold('  Setup'));
    for (const name of SETUP_COMMANDS) {
        const cmd = cmds.find(c => c.name() === name);
        if (cmd) lines.push(formatCmd(cmd.name(), cmd.description()));
    }
    lines.push('');

    // Maintenance
    lines.push(chalk.yellow.bold('  Maintenance'));
    for (const name of MAINT_COMMANDS) {
        const cmd = cmds.find(c => c.name() === name);
        if (cmd) lines.push(formatCmd(cmd.name(), cmd.description()));
    }
    lines.push('');
    lines.push(chalk.dim(`  Run ${chalk.white('cr <command> --help')} for detailed usage`));
    lines.push('');

    return lines.join('\n');
});

// Suppress Commander's default command list for the root program ONLY.
// We render our own categorized list via addHelpText above.
// Subcommands retain their default help rendering.
const defaultFormatHelp = program.createHelp().formatHelp.bind(program.createHelp());
program.configureHelp({
    formatHelp: (cmd, helper) => {
        if (cmd === program) {
            // Root program: return empty — our addHelpText('afterAll') handles everything
            return '';
        }
        // Subcommands: use Commander's default formatting
        return defaultFormatHelp(cmd, helper);
    },
});

import { registerAnalyzeCodeCommand } from './commands/analyze/code.js';
import { registerAnalyzeInfraCommand } from './commands/analyze/infra.js';
import { registerAnalyzeTracesCommand } from './commands/analyze/traces.js';
import { registerAnalyzeVulnCommand } from './commands/analyze/vuln.js';
import { registerDocGenerateCommand } from './commands/doc/generate.js';
import { registerConfigShowCommand } from './commands/config/show.js';
import { registerConfigEnvCommand } from './commands/config/env.js';
import { registerMcpStartCommand } from './commands/mcp/mcp-start.js';
import { registerMcpConfigureCommand } from './commands/mcp/mcp-configure.js';
import { registerPruneCommand } from './commands/prune/index.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerEvaluateBlastCommand } from './commands/evaluate/blast.js';
import omelette from 'omelette';
import { registerInitCommand } from './commands/init.js';
import { registerStartCommand } from './commands/infra/start.js';
import { registerStopCommand } from './commands/infra/stop.js';
import { registerChatCommand } from './commands/chat/index.js';
import { registerUiCommand } from './commands/ui/index.js';
import { registerTeamAliasCommand } from './commands/team-alias.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDriftCommand } from './commands/drift.js';
import { registerPolicyVerifyCommand } from './commands/policy/verify.js';
import { registerPolicyPruneCommand } from './commands/policy/prune.js';
import { registerPolicyExportCommand } from './commands/policy/export.js';
import { registerStateExportCommand } from './commands/state/export.js';
import { registerStateImportCommand } from './commands/state/import.js';

// ─── Command Registration ────────────────────────────────────────────────────

// ── Core Commands (daily use) ─────────────────────────────────────────────────

// analyze: Analyze codebase and build the architecture graph
const analyzeCmd = program.command('analyze').description('Analyze codebase and build the architecture graph');
registerAnalyzeCodeCommand(analyzeCmd);
registerAnalyzeInfraCommand(analyzeCmd);
registerAnalyzeTracesCommand(analyzeCmd);
registerAnalyzeVulnCommand(analyzeCmd);

// blast (← eval blast): Predict blast radius of code changes
registerEvaluateBlastCommand(program);

// policy: governance rules — verify, prune, export
const policyCmd = program.command('policy').description('Verify, prune, and export governance policies');
registerPolicyVerifyCommand(policyCmd);
registerPolicyPruneCommand(policyCmd);
registerPolicyExportCommand(policyCmd);

// ask (← chat): Ask questions about your architecture
registerChatCommand(program);

// ui (← dashboard): Open the architecture dashboard
registerUiCommand(program);

// doctor: Diagnose analysis gaps (grounding.needsReview + shared-DB candidates) and prescribe coderadius.yaml fixes
registerDoctorCommand(program);

// drift: Compare catalog-declared truth vs code-extracted graph
registerDriftCommand(program);

// docs (← doc): Generate and manage living architecture documentation
const docsCmd = program.command('docs').description('Generate and manage living architecture documentation');
registerDocGenerateCommand(docsCmd);

// ── Setup ─────────────────────────────────────────────────────────────────────

// init (unchanged)
registerInitCommand(program);

// up (← start): Start infrastructure services
registerStartCommand(program);

// down (← stop): Stop infrastructure services
registerStopCommand(program);

// ── Maintenance ───────────────────────────────────────────────────────────────

// validate: declarative-config checks (coderadius.yaml), offline
registerValidateCommand(program);

// prune: Remove data, caches, or both
registerPruneCommand(program);

// state: Export and import architecture graph snapshots
const stateCmd = program.command('state').description('Export and import architecture graph snapshots');
registerStateExportCommand(stateCmd);
registerStateImportCommand(stateCmd);

// config (absorbs team-alias + completion)
const configCmd = program.command('config').description('Manage settings, team aliases, and shell completion');
registerConfigShowCommand(configCmd);
registerConfigEnvCommand(configCmd);
registerTeamAliasCommand(configCmd);

// mcp (unchanged)
const mcpCmd = program.command('mcp').description('Manage MCP server for IDE integration');
registerMcpStartCommand(mcpCmd);
registerMcpConfigureCommand(mcpCmd);

// ─── Legacy Aliases (hidden from --help) ──────────────────────────────────────
// Ensures existing CI pipelines, docs, and muscle-memory don't break.
// Each alias delegates to the new canonical command.

// sync → analyze (legacy alias)
const syncAlias = program.command('sync', { hidden: true }).description('');
registerAnalyzeCodeCommand(syncAlias);
registerAnalyzeTracesCommand(syncAlias);


// eval → blast (group with blast subcommand)
const evalAlias = program.command('eval', { hidden: true }).description('');
registerEvaluateBlastCommand(evalAlias);

// chat → ask
program.command('chat', { hidden: true }).description('')
    .action(async () => {
        await program.parseAsync(['node', 'cr', 'ask']);
    });

// start → up
program.command('start', { hidden: true }).description('')
    .action(async () => {
        await program.parseAsync(['node', 'cr', 'up']);
    });

// stop → down
program.command('stop', { hidden: true }).description('')
    .option('--clean', '')
    .action(async (opts) => {
        const args = ['down'];
        if (opts.clean) args.push('--clean');
        await program.parseAsync(['node', 'cr', ...args]);
    });


// team-alias → config team-alias
const teamAliasAlias = program.command('team-alias', { hidden: true }).description('');
registerTeamAliasCommand(teamAliasAlias);



// doc → docs
const docAlias = program.command('doc', { hidden: true }).description('');
registerDocGenerateCommand(docAlias);

// ─── Shell Autocomplete ──────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const completion = omelette('cr|radius <group> <subcommand> <arg1> <arg2> <arg3>');

function replyWithFiles(line: string, reply: (arr: string[]) => void) {
    try {
        const args = line.trimStart().split(/\s+/);
        const currentWord = line.endsWith(' ') ? '' : args[args.length - 1];
        
        const targetDir = currentWord ? path.dirname(currentWord) : '.';
        const prefix = currentWord ? path.basename(currentWord) : '';
        const resolvedDir = path.resolve(process.cwd(), targetDir);
        
        if (!fs.existsSync(resolvedDir)) {
            reply([]);
            return;
        }

        const files = fs.readdirSync(resolvedDir);
        let matches = files.filter(f => f.startsWith(prefix));
        
        matches = matches.map(f => {
            const fullPath = path.join(resolvedDir, f);
            try {
                if (fs.statSync(fullPath).isDirectory()) return f + '/';
            } catch {}
            return f;
        });

        const results = matches.map(f => {
            if (currentWord === prefix) return f;
            return path.join(targetDir, f);
        });
        
        reply(results);
    } catch {
        reply([]);
    }
}

// Dynamically generate root commands and groups via Commander's tree
completion.on('group', ({ reply }) => {
    // Collect all registered command names (sync, blast, ask, init, up, down, etc.)
    // Filter out hidden legacy aliases
    const commands = program.commands
        .filter(cmd => !(cmd as any)._hidden)
        .map(cmd => cmd.name());
    reply(commands);
});

// Generate subcommands dynamically if the user types a known group command
completion.on('subcommand', ({ before, line, reply }) => {
    const parentCmd = program.commands.find(cmd => cmd.name() === before);
    if (parentCmd && parentCmd.commands.length > 0) {
        reply(parentCmd.commands.map(sub => sub.name()));
    } else {
        // If the group command has no subcommands (e.g., `cr ask`), fallback to file paths
        replyWithFiles(line, reply);
    }
});

// For any arguments beyond subcommand, fallback to file paths
const argHandler = ({ line, reply }: { line: string, reply: (arr: string[]) => void }) => replyWithFiles(line, reply);
completion.on('arg1', argHandler);
completion.on('arg2', argHandler);
completion.on('arg3', argHandler);

completion.init();

if (isCompletionRequest) {
    process.exit(0);
}

// Completion is now under `config completion`
configCmd
    .command('completion')
    .description('Manage shell autocompletion integration')
    .option('--setup', 'Install shell autocompletion into .bashrc/.zshrc')
    .option('--cleanup', 'Remove shell autocompletion from .bashrc/.zshrc')
    .action((opts: { setup?: boolean; cleanup?: boolean }) => {
        if (opts.setup) {
            completion.setupShellInitFile();
            console.log('Autocomplete setup successful. Restart your terminal or run `source ~/.zshrc` (or `~/.bashrc`) to apply.');
        } else if (opts.cleanup) {
            completion.cleanupShellInitFile();
            console.log('Autocomplete cleanup successful. Removed from your shell configuration.');
        } else {
            console.log('Use `cr config completion --setup` to install shell autocompletion, or `--cleanup` to remove it.');
        }
    });

// Keep old `cr completion` as a hidden alias
program.command('completion', { hidden: true }).description('')
    .option('--setup', '')
    .option('--cleanup', '')
    .action((opts: { setup?: boolean; cleanup?: boolean }) => {
        if (opts.setup) {
            completion.setupShellInitFile();
            console.log('Autocomplete setup successful. Restart your terminal or run `source ~/.zshrc` (or `~/.bashrc`) to apply.');
        } else if (opts.cleanup) {
            completion.cleanupShellInitFile();
            console.log('Autocomplete cleanup successful. Removed from your shell configuration.');
        } else {
            console.log('Use `cr config completion --setup` to install shell autocompletion, or `--cleanup` to remove it.');
        }
    });

// ─── Global Database Preflight Hook ──────────────────────────────────────────

program.hook('preAction', async (thisCommand, actionCommand) => {
    const commandPath = [];
    let curr: any = actionCommand;
    while (curr && curr.name() !== 'cr') {
        commandPath.unshift(curr.name());
        if (!curr.parent) break;
        curr = curr.parent;
    }
    const fullCommand = commandPath.join(' ');

    const offlineCommands = [
        'init', 'up', 'down', 'start', 'stop', 'completion', 'validate',
        'config show', 'config completion', 'config team-alias',
        'mcp configure', 'prune cache',
    ];

    const isOffline = offlineCommands.some(cmd => fullCommand === cmd || fullCommand.startsWith(cmd + ' '));

    if (!isOffline) {
        const { assertDbConnection } = await import('../graph/neo4j.js');
        const chalk = (await import('chalk')).default;
        try {
            await assertDbConnection();
        } catch (e: any) {
            console.error(chalk.red(`\n${e.message}\n`));
            process.exit(1);
        }
    }
});

// ─── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync();
