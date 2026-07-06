import type { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { paths } from '../../config/paths.js';
import { slugifyTenant } from '../../config/tenant.js';

import { scanRepositoryTree, formatTreeAsCsv } from '../../utils/tree-scanner.js';

import omelette from 'omelette';


export function registerInitCommand(program: Command): void {
    program
        .command('init')
        .description('Initialize the CodeRadius workspace configuration')
        .action(async () => {
            const { configManager } = await import('../../config/index.js');
            const { getMastra } = await import('../../ai/mastra/index.js');
            const { printHeader } = await import('../ui/logo.js');
            printHeader('CODERADIUS WORKSPACE SETUP', 'Initializing your semantic infrastructure');

            try {
                const configPath = paths.config.settings;
                const configDir = paths.config.dir;
                const credentialsPath = paths.config.credentials;

                p.note(
                    `Config : ${configDir}\nTarget : ${process.cwd()}`,
                    'Environment'
                );

                // 1. Create directory structure
                let isFirstRun = false;
                const credsSpinner = p.spinner();
                credsSpinner.start('Checking credentials configuration');

                for (const dir of [paths.config.dir, paths.cache.dir, paths.logs.dir]) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                if (!fs.existsSync(credentialsPath)) {
                    const defaultCredentials = {
                        "OPENAI_API_KEY": "",
                        "ANTHROPIC_API_KEY": ""
                    };
                    fs.writeFileSync(credentialsPath, JSON.stringify(defaultCredentials, null, 4), { encoding: 'utf-8', mode: 0o600 });
                    credsSpinner.stop('Created credentials.json (chmod 600)');
                    isFirstRun = true;
                } else {
                    credsSpinner.stop('Credentials verified');
                }

                // 2. Settings Interactive Setup
                let settings: any = {};
                const configExists = fs.existsSync(configPath);
                let providerName = 'AI';

                if (configExists) {
                    p.log.info('Configuration already exists in ~/.coderadius/config/settings.json. Skipping setup.');
                    try {
                        settings = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        providerName = settings?.ai?.fast?.split('/')[0] || 'AI';
                    } catch { }
                } else {
                    const provider = await p.select({
                        message: 'Which LLM provider would you like to use?',
                        options: [
                            { value: 'google-genai', label: 'Google AI Studio (API key, simplest)' },
                            { value: 'anthropic', label: 'Anthropic Claude' },
                            { value: 'openai', label: 'OpenAI' },
                            { value: 'ollama', label: 'Ollama (local, no API key needed)' },
                            { value: 'vertex', label: 'Google Vertex AI (GCP project required)' },
                            { value: 'bedrock', label: 'AWS Bedrock (uses AWS CLI credentials)' },
                        ],
                        initialValue: 'google-genai'
                    });

                    if (p.isCancel(provider)) {
                        p.cancel('Setup cancelled.');
                        process.exit(0);
                    }

                    providerName = provider as string;

                    const aiConfig: any = { fast: { provider } };
                    const providerConfig: any = {};
                    const credentials: Record<string, string> = {};

                    // ── Provider-specific setup ──────────────────────────────────

                    if (provider === 'vertex') {
                        let project = await p.text({
                            message: 'Google Cloud Project ID:',
                            placeholder: 'my-gcp-project',
                            validate: (value) => {
                                if (!value) return 'Project ID is required for Vertex AI.';
                            }
                        }) as string;
                        if (p.isCancel(project)) process.exit(0);
                        project = project.trim();

                        let location = await p.text({
                            message: 'Google Cloud Location:',
                            placeholder: 'global',
                            defaultValue: 'global'
                        }) as string;
                        if (p.isCancel(location)) process.exit(0);
                        location = location.trim() || 'global';

                        const authType = await p.select({
                            message: 'How would you like to authenticate with Google Cloud?',
                            options: [
                                { value: 'adc', label: 'Application Default Credentials (ADC) — gcloud auth application-default login' },
                                { value: 'sa', label: 'Service Account JSON file' }
                            ]
                        });
                        if (p.isCancel(authType)) process.exit(0);

                        let credentialsFile = '';
                        if (authType === 'sa') {
                            let ans = await p.text({
                                message: 'Path to Service Account JSON file:',
                                placeholder: '~/.coderadius/config/gcp-service-account.json',
                                defaultValue: '~/.coderadius/config/gcp-service-account.json'
                            }) as string;
                            if (p.isCancel(ans)) process.exit(0);
                            let rawPath = ans.trim() || '~/.coderadius/config/gcp-service-account.json';
                            credentialsFile = rawPath;
                            let resolvedPath = rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : path.resolve(rawPath);
                            if (!fs.existsSync(resolvedPath)) {
                                p.log.warn(`Service Account file not found at ${resolvedPath}.\nPlease place your JSON key there before running ingestion.`);
                            }
                        }

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'gemini-3.1-flash-lite',
                            defaultValue: 'gemini-3.1-flash-lite'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'gemini-3.1-flash-lite';

                        aiConfig.fast.model = model;
                        providerConfig.vertex = { project, location, credentialsFile: authType === 'sa' ? credentialsFile : '' };

                    } else if (provider === 'google-genai') {
                        let apiKey = await p.text({
                            message: 'Google AI Studio API key (leave empty to set GOOGLE_GENERATIVE_AI_API_KEY later):',
                            placeholder: 'AIza...',
                            defaultValue: ''
                        }) as string;
                        if (p.isCancel(apiKey)) process.exit(0);
                        apiKey = apiKey.trim();

                        if (apiKey) {
                            credentials.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
                        }

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'gemini-2.5-flash',
                            defaultValue: 'gemini-2.5-flash'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'gemini-2.5-flash';

                        aiConfig.fast.model = model;

                    } else if (provider === 'anthropic') {
                        let apiKey = await p.text({
                            message: 'Anthropic API key (leave empty to set ANTHROPIC_API_KEY later):',
                            placeholder: 'sk-ant-...',
                            defaultValue: ''
                        }) as string;
                        if (p.isCancel(apiKey)) process.exit(0);
                        apiKey = apiKey.trim();

                        if (apiKey) {
                            credentials.ANTHROPIC_API_KEY = apiKey;
                        }

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'claude-sonnet-4-20250514',
                            defaultValue: 'claude-sonnet-4-20250514'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'claude-sonnet-4-20250514';

                        aiConfig.fast.model = model;

                        // Anthropic doesn't support embeddings — ask for embedding provider
                        p.log.info('Anthropic does not provide an embedding API. Choose a provider for embeddings:');
                        const embProvider = await p.select({
                            message: 'Embedding provider:',
                            options: [
                                { value: 'google-genai', label: 'Google AI Studio (API key)' },
                                { value: 'openai', label: 'OpenAI' },
                                { value: 'ollama', label: 'Ollama (local)' },
                                { value: 'skip', label: 'Skip — disable vector search' },
                            ]
                        });
                        if (p.isCancel(embProvider)) process.exit(0);

                        if (embProvider !== 'skip') {
                            aiConfig.fast.embeddingProvider = embProvider;
                            if (embProvider === 'google-genai') {
                                if (!credentials.GOOGLE_GENERATIVE_AI_API_KEY) {
                                    let gKey = await p.text({ message: 'Google AI Studio API key for embeddings:', placeholder: 'AIza...', defaultValue: '' }) as string;
                                    if (p.isCancel(gKey)) process.exit(0);
                                    gKey = gKey.trim();
                                    if (gKey) credentials.GOOGLE_GENERATIVE_AI_API_KEY = gKey;
                                }
                                aiConfig.fast.embeddingModel = 'gemini-embedding-001';
                            } else if (embProvider === 'openai') {
                                if (!credentials.OPENAI_API_KEY) {
                                    let oKey = await p.text({ message: 'OpenAI API key for embeddings:', placeholder: 'sk-...', defaultValue: '' }) as string;
                                    if (p.isCancel(oKey)) process.exit(0);
                                    oKey = oKey.trim();
                                    if (oKey) credentials.OPENAI_API_KEY = oKey;
                                }
                                aiConfig.fast.embeddingModel = 'text-embedding-3-small';
                            }
                        }

                    } else if (provider === 'openai') {
                        let apiKey = await p.text({
                            message: 'OpenAI API key (leave empty to set OPENAI_API_KEY later):',
                            placeholder: 'sk-...',
                            defaultValue: ''
                        }) as string;
                        if (p.isCancel(apiKey)) process.exit(0);
                        apiKey = apiKey.trim();

                        if (apiKey) {
                            credentials.OPENAI_API_KEY = apiKey;
                        }

                        let baseURL = await p.text({
                            message: 'Custom API base URL (leave empty for api.openai.com):',
                            placeholder: 'https://your-proxy.com/v1',
                            defaultValue: ''
                        }) as string;
                        if (p.isCancel(baseURL)) process.exit(0);
                        baseURL = baseURL.trim();

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'gpt-4.1-mini',
                            defaultValue: 'gpt-4.1-mini'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'gpt-4.1-mini';

                        aiConfig.fast.model = model;
                        if (baseURL) {
                            providerConfig.openai = { baseURL };
                        }

                    } else if (provider === 'ollama') {
                        let baseURL = await p.text({
                            message: 'Ollama base URL:',
                            placeholder: 'http://localhost:11434',
                            defaultValue: 'http://localhost:11434'
                        }) as string;
                        if (p.isCancel(baseURL)) process.exit(0);
                        baseURL = baseURL.trim() || 'http://localhost:11434';

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'qwen3.5',
                            defaultValue: 'qwen3.5'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'qwen3.5';

                        aiConfig.fast.model = model;
                        if (baseURL !== 'http://localhost:11434') {
                            providerConfig.ollama = { baseURL };
                        }

                    } else if (provider === 'bedrock') {
                        let region = await p.text({
                            message: 'AWS Region:',
                            placeholder: 'us-east-1',
                            defaultValue: 'us-east-1'
                        }) as string;
                        if (p.isCancel(region)) process.exit(0);
                        region = region.trim() || 'us-east-1';

                        let model = await p.text({
                            message: 'Fast model (bulk code analysis):',
                            placeholder: 'anthropic.claude-sonnet-4-20250514-v1:0',
                            defaultValue: 'anthropic.claude-sonnet-4-20250514-v1:0'
                        }) as string;
                        if (p.isCancel(model)) process.exit(0);
                        model = model.trim() || 'anthropic.claude-sonnet-4-20250514-v1:0';

                        aiConfig.fast.model = model;
                        providerConfig.bedrock = { region };

                        p.log.info('Bedrock does not provide a built-in embedding API. Choose a provider for embeddings:');
                        const embProvider = await p.select({
                            message: 'Embedding provider:',
                            options: [
                                { value: 'bedrock', label: 'AWS Bedrock (Titan Embed)' },
                                { value: 'openai', label: 'OpenAI' },
                                { value: 'google-genai', label: 'Google AI Studio (API key)' },
                                { value: 'ollama', label: 'Ollama (local)' },
                                { value: 'skip', label: 'Skip — disable vector search' },
                            ]
                        });
                        if (p.isCancel(embProvider)) process.exit(0);

                        if (embProvider !== 'skip') {
                            aiConfig.fast.embeddingProvider = embProvider;
                            if (embProvider === 'bedrock') {
                                aiConfig.fast.embeddingModel = 'amazon.titan-embed-text-v2:0';
                            } else if (embProvider === 'openai') {
                                if (!credentials.OPENAI_API_KEY) {
                                    let oKey = await p.text({ message: 'OpenAI API key for embeddings:', placeholder: 'sk-...', defaultValue: '' }) as string;
                                    if (p.isCancel(oKey)) process.exit(0);
                                    oKey = oKey.trim();
                                    if (oKey) credentials.OPENAI_API_KEY = oKey;
                                }
                                aiConfig.fast.embeddingModel = 'text-embedding-3-small';
                            } else if (embProvider === 'google-genai') {
                                if (!credentials.GOOGLE_GENERATIVE_AI_API_KEY) {
                                    let gKey = await p.text({ message: 'Google AI Studio API key for embeddings:', placeholder: 'AIza...', defaultValue: '' }) as string;
                                    if (p.isCancel(gKey)) process.exit(0);
                                    gKey = gKey.trim();
                                    if (gKey) credentials.GOOGLE_GENERATIVE_AI_API_KEY = gKey;
                                }
                                aiConfig.fast.embeddingModel = 'gemini-embedding-001';
                            }
                        }
                    }

                    // ── Build and save settings ──────────────────────────────────

                    // Smart tier (chat/doc quality work): provider-specific default,
                    // falls back to the fast model for local/unknown providers.
                    const SMART_MODEL_BY_PROVIDER: Record<string, string> = {
                        vertex: 'gemini-3.1-pro',
                        'google-genai': 'gemini-3.1-pro',
                        anthropic: 'claude-sonnet-4-20250514',
                        openai: 'gpt-4.1',
                    };
                    const smartModel = SMART_MODEL_BY_PROVIDER[provider as string] ?? aiConfig.fast.model;

                    const newSettings: any = {
                        ai: {
                            fast: `${provider}/${aiConfig.fast.model}`,
                            smart: `${provider}/${smartModel}`,
                            ...(Object.keys(providerConfig).length > 0 ? { providers: providerConfig } : {})
                        }
                    };

                    if (aiConfig.fast.embeddingProvider && aiConfig.fast.embeddingModel) {
                        newSettings.ai.embedding = `${aiConfig.fast.embeddingProvider}/${aiConfig.fast.embeddingModel}`;
                    }

                    fs.writeFileSync(configPath, JSON.stringify(newSettings, null, 4), 'utf-8');
                    p.log.success('Configuration saved to ~/.coderadius/config/settings.json');

                    // Merge API keys into credentials.json (append, don't overwrite)
                    if (Object.keys(credentials).length > 0) {
                        let existingCreds: Record<string, string> = {};
                        if (fs.existsSync(credentialsPath)) {
                            try { existingCreds = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')); } catch { }
                        }
                        const mergedCreds = { ...existingCreds, ...credentials };
                        fs.writeFileSync(credentialsPath, JSON.stringify(mergedCreds, null, 4), { encoding: 'utf-8', mode: 0o600 });
                        p.log.success(`API keys saved to ~/.coderadius/config/credentials.json (chmod 600)`);
                    }
                }

                // ── Workspace identity (tenant) ──────────────────────────────
                // The tenant is the enterprise / workspace identity, shown as the
                // catalog name. Provisioned here at onboarding (the seam an
                // account-creation flow plugs into later); it materialises as a
                // Tenant node on the next `cr analyze` (reconcile reads config.tenant).
                // Only prompt when it isn't set yet, so re-running init is idempotent.
                let currentSettings: any = {};
                try { currentSettings = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { }
                if (!currentSettings?.tenant?.name) {
                    const workspaceName = await p.text({
                        message: 'Workspace name, your enterprise or tenant, shown as the catalog name:',
                        placeholder: 'Acme Inc',
                    });
                    if (p.isCancel(workspaceName)) process.exit(0);
                    const tenantName = (workspaceName as string).trim();
                    if (tenantName) {
                        const tenantSlug = slugifyTenant(tenantName);
                        currentSettings.tenant = { name: tenantName, slug: tenantSlug };
                        fs.writeFileSync(configPath, JSON.stringify(currentSettings, null, 4), 'utf-8');
                        p.log.success(`Workspace set: ${tenantName} (${tenantSlug})`);
                    }
                }

                // Reload configuration manager so it picks up the new files immediately!
                configManager.reload();

                // --- AI .crignore Generation ---
                const rootDir = process.cwd();
                const crignorePath = path.join(rootDir, '.crignore');

                let runCrignore = true;
                if (fs.existsSync(crignorePath)) {
                    const overwrite = await p.confirm({
                        message: '.crignore already exists. Do you want to re-generate it using the new AI settings to test them?',
                        initialValue: false
                    });
                    if (p.isCancel(overwrite)) process.exit(0);
                    runCrignore = overwrite as boolean;
                } else {
                    const generateTask = await p.confirm({
                        message: 'Do you want to run the AI now to generate a `.crignore` file specifically for this repository?',
                        initialValue: true
                    });
                    if (p.isCancel(generateTask)) process.exit(0);
                    runCrignore = generateTask as boolean;
                }

                if (runCrignore) {
                    const aiSpinner = p.spinner();
                    aiSpinner.start('Analyzing repository structure (AI)');

                    aiSpinner.message('Scanning directory tree...');
                    const fileTree = scanRepositoryTree(rootDir);
                    const csvString = formatTreeAsCsv(fileTree);

                    aiSpinner.message(`Requesting topological filtering rules for ${fileTree.length} files via ${providerName}...`);

                    try {
                        // Update bridge env if they switched to vertex immediately
                        configManager.bridgeSettingsToEnv();
                        const agent = await getMastra().getAgent('crignoreAgent');
                        const response = await agent.generate(csvString, {
                            modelSettings: {
                                maxRetries: 3,
                                temperature: 0,
                            }
                        });

                        let crignoreContent = response.text || '';
                        if (crignoreContent.startsWith('```')) {
                            const lines = crignoreContent.split('\n');
                            if (lines.length > 1 && lines[0].startsWith('```') && lines[lines.length - 1].startsWith('```')) {
                                lines.shift();
                                lines.pop();
                                crignoreContent = lines.join('\n');
                            }
                        }

                        fs.writeFileSync(crignorePath, crignoreContent.trim() + '\n', 'utf-8');
                        aiSpinner.stop('Generated target-specific .crignore');
                        p.log.success('Frontend UI and test noise excluded from topological mapping.');
                    } catch (aiErr) {
                        aiSpinner.stop('AI Generation Failed');
                        p.log.warn(`Could not generate .crignore automatically: ${(aiErr as Error).message}`);
                        p.log.info(`You can create it manually, or run 'radius init' again later.`);
                    }
                }

                // --- Shell Autocomplete ---
                const setupAutocomplete = await p.confirm({
                    message: 'Do you want to install shell autocompletion for radius (bash/zsh)?',
                    initialValue: true
                });

                if (!p.isCancel(setupAutocomplete) && setupAutocomplete) {
                    try {
                        const completion = omelette('cr <group> <subcommand>');
                        completion.setupShellInitFile();
                        p.log.success('Autocomplete setup successful! Restart your terminal to apply.');
                    } catch (e) {
                        p.log.warn('Could not setup autocompletion automatically. Try `cr completion --setup`');
                    }
                }

                p.outro(chalk.green('Workspace initialized successfully.'));

                p.note(
                    `${chalk.cyan('1. cr up')}                   — Start the graph database (Docker)\n` +
                    `${chalk.cyan('2. cr analyze code')}         — Analyze your codebase architecture\n` +
                    `${chalk.cyan('3. cr ui')}                   — Generate the architecture dashboard`,
                    'Next Steps'
                );

            } catch (err) {
                p.log.error(`Initialization failed: ${(err as Error).message}`);
                process.exit(1);
            }
        });
}
