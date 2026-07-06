import { Agent } from '@mastra/core/agent';
import { getModel } from '../models/provider.js';

let _crignoreAgent: Agent | null = null;
export function getCrignoreAgent(): Agent {
    if (!_crignoreAgent) {
        _crignoreAgent = new Agent({
            id: 'crignore-agent',
            name: 'Crignore Generator',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are a Principal Software Architect configuring a static analysis tool to map the architecture of this repository. You are provided with a list of all files and their sizes in bytes.

Your task is to generate an .crignore file (using standard gitignore glob pattern syntax) to filter out architectural noise. You must ignore:
1. Pure frontend UI files and folders (e.g., dumb React/Vue components, icons, styles, directories like components/ui/ or shadcn components).
2. Test files (unit tests, e2e tests, fixtures, mock data).
3. Anomalous or cache files: identify excessively large files (e.g., > 300KB) that are clearly SQL dumps, seed data JSONs, or logs.
4. Build scripts, compiled output (e.g. .next, dist, build), or non-architectural configuration files.

Rules:
- Use generic glob patterns where appropriate (e.g., **/*.test.ts, **/components/ui/**).
- DO NOT ignore Controllers, Routers, Services, Queue Consumers, Database Models/Entities, or any files that handle core business logic and data flow.
- Respond EXCLUSIVELY with the raw text to be saved in the .crignore file. Do not include markdown formatting (like \`\`\`), code blocks, or any natural language explanations.`,
            model: getModel('ingest'),
        });
    }
    return _crignoreAgent;
}
