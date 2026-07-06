import * as p from '@clack/prompts';
import chalk from 'chalk';
import { marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { getMastra } from '../ai/mastra/index.js';

// @types/marked-terminal@6 lags behind marked@17; runtime shape is correct
marked.use(markedTerminal({
    firstHeading: chalk.cyan.bold,
    heading: chalk.cyan.bold,
    codespan: chalk.yellow,
    blockquote: chalk.gray.italic,
    strong: chalk.bold,
    tableOptions: { style: { head: ['cyan'] } },
}) as unknown as MarkedExtension);

export async function startChat(): Promise<void> {
    p.intro(chalk.bgCyan.black(' CodeRadius.ai — Architect Sage '));
    p.log.info(
        chalk.dim(
            'Ask questions about your codebase architecture, dependencies, and blast radius.\nType "exit" or press Ctrl+C to quit.',
        ),
    );

    const conversationHistory: string[] = [];

    while (true) {
        const input = await p.text({
            message: chalk.green('You'),
            placeholder: 'e.g. "Which services are impacted if I modify the premium calculation?"',
        });

        if (p.isCancel(input) || input === 'exit') {
            p.outro('bye.');
            break;
        }

        if (!input.trim()) continue;

        // Build context from conversation history
        const contextWindow = conversationHistory.slice(-10).join('\n');
        const fullPrompt = contextWindow
            ? `Previous conversation context:\n${contextWindow}\n\nNew question: ${input}`
            : input;

        const spinner = p.spinner();
        spinner.start('Thinking...');

        const startMs = Date.now();
        try {
            const agent = getMastra().getAgent('architectAgent');
            const response = await agent.generate(fullPrompt, {
                maxSteps: 25,
            });
            const elapsedMs = Date.now() - startMs;

            const usage = (response.usage || { promptTokens: 0, completionTokens: 0 }) as any;
            const timeStr = chalk.dim(`${(elapsedMs / 1000).toFixed(1)}s`);
            const tokenStr = chalk.dim(`${usage.promptTokens || usage.inputTokens || 0} in (${usage.cachedInputTokens || usage.cachedTokens || 0} cached) / ${usage.completionTokens || usage.outputTokens || 0} out tokens`);

            spinner.stop(`${chalk.cyan('Response ready')} • ${timeStr} • ${tokenStr}`);

            let text = response.text;
            if (!text || text.trim() === '') {
                text = `*Warning: The agent returned an empty response.* \n\n<details><summary>Debug Info</summary>\n\n\`\`\`json\n${JSON.stringify({ usage: response.usage, finishReason: response.finishReason, steps: response.steps?.length }, null, 2)}\n\`\`\`\n</details>`;
            }

            conversationHistory.push(`User: ${input}`);
            conversationHistory.push(`Assistant: ${text}`);

            console.log(`\n${chalk.cyan.bold('CodeRadius Architect')}`);
            console.log(marked(text.trim()));
            console.log(chalk.dim('─'.repeat(process.stdout.columns || 40)));
        } catch (err: any) {
            spinner.stop(chalk.red('Error'));

            // Graceful handling for missing AI SDK settings (like GOOGLE_VERTEX_LOCATION)
            if (err.name === 'LoadSettingError' || err.message?.includes('Google Vertex location setting is missing')) {
                console.error(chalk.red(`\nError: Missing required credential 'GOOGLE_VERTEX_LOCATION'.`));
                console.error(chalk.yellow(`Add it to your ~/.coderadius/config/credentials.json file or set it as an environment variable.`));
                process.exit(1);
            }

            p.log.error(`Agent error: ${err.message}`);
        }
    }
}
