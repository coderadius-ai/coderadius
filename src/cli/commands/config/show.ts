import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import chalk from 'chalk';
import { printHeader } from '../../ui/logo.js';
import { configManager, type ActionContext } from '../../../config/index.js';

export function registerConfigShowCommand(configCmd: Command): void {
    configCmd
        .command('show')
        .description('Display current resolved configuration')
        .option('--json', 'Output as raw JSON')
        .action(async (opts: { json?: boolean }) => {
            configManager.reload();

            if (opts.json) {
                console.log(JSON.stringify(configManager.getRawConfig(), null, 2));
                return;
            }

            const configPath = configManager.getConfigPath();
            const credentialsPath = path.join(path.dirname(configPath), 'credentials.json');

            printHeader('CodeRadius', 'Configuration Settings');

            console.log(`  ${chalk.dim('Config File')}  : ${fs.existsSync(configPath) ? chalk.green(configPath) : chalk.red('Not found')}`);
            console.log(`  ${chalk.dim('Credentials')}  : ${fs.existsSync(credentialsPath) ? chalk.green(credentialsPath) : chalk.yellow('Not found')}`);
            console.log();

            // Resolved config per action context
            const actions: (ActionContext | undefined)[] = [undefined, 'ingest', 'chat', 'doc', 'mcp'];
            const labels = ['default', 'ingest', 'chat', 'doc', 'mcp'];

            console.log(`  ${chalk.dim('Context'.padEnd(10))} ${chalk.dim('Provider'.padEnd(14))} ${chalk.dim('Model'.padEnd(35))} ${chalk.dim('From')}`);
            console.log(`  ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(35)} ${'─'.repeat(16)}`);

            for (let i = 0; i < actions.length; i++) {
                const { config: resolved, sources } = configManager.resolveAiConfig(actions[i]);
                const label = labels[i].padEnd(10);
                const provider = resolved.provider.padEnd(14);
                const model = resolved.model.padEnd(35);
                const from = sources.model ?? '';
                console.log(`  ${chalk.cyan(label)} ${provider} ${model} ${chalk.dim(from)}`);
            }
            console.log();

            // Embedding info
            const defaultConfig = configManager.getAiConfig('ingest');
            const embProvider = defaultConfig.embeddingProvider || defaultConfig.provider;
            console.log(`  ${chalk.dim('Embeddings')}   : ${embProvider} / ${defaultConfig.embeddingModel}`);

            // Provider-specific details
            if (defaultConfig.provider === 'vertex' || embProvider === 'vertex') {
                const raw = configManager.getRawConfig();
                const vp = raw.ai?.providers?.vertex;
                console.log(`  ${chalk.dim('Vertex')}       : ${vp?.project || defaultConfig.project || chalk.yellow('not set')} @ ${vp?.location || defaultConfig.location || 'global'}`);
                const credsFile = vp?.credentialsFile;
                const hasADC = fs.existsSync(path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));
                if (credsFile) {
                    console.log(`  ${chalk.dim('Auth')}         : Service Account (${credsFile})`);
                } else if (hasADC) {
                    console.log(`  ${chalk.dim('Auth')}         : ADC (gcloud) ${chalk.green('ok')}`);
                } else {
                    console.log(`  ${chalk.dim('Auth')}         : ${chalk.yellow('No credentials configured')}`);
                }
            }

            if (defaultConfig.provider === 'bedrock') {
                const raw = configManager.getRawConfig();
                const bp = raw.ai?.providers?.bedrock;
                const region = bp?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || chalk.yellow('not set');
                console.log(`  ${chalk.dim('Bedrock')}      : region ${region}`);
                const hasAwsKey = !!process.env.AWS_ACCESS_KEY_ID;
                const hasAwsFile = fs.existsSync(path.join(os.homedir(), '.aws', 'credentials'));
                if (hasAwsKey) {
                    console.log(`  ${chalk.dim('Auth')}         : AWS env vars ${chalk.green('ok')}`);
                } else if (hasAwsFile) {
                    console.log(`  ${chalk.dim('Auth')}         : ~/.aws/credentials ${chalk.green('ok')}`);
                } else {
                    console.log(`  ${chalk.dim('Auth')}         : ${chalk.yellow('No AWS credentials found')}`);
                }
            }

            // Credentials status
            const envKeys = [
                { key: 'GOOGLE_GENERATIVE_AI_API_KEY', label: 'Google GenAI' },
                { key: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
                { key: 'OPENAI_API_KEY', label: 'OpenAI' },
            ];
            const setKeys = envKeys.filter(e => process.env[e.key]);
            if (setKeys.length > 0) {
                console.log(`  ${chalk.dim('API Keys')}     : ${setKeys.map(e => `${e.label} ${chalk.green('ok')}`).join(', ')}`);
            }

            console.log();
        });
}
