import type { Command } from 'commander';

export function registerChatCommand(program: Command): void {
    program
        .command('ask')
        .description('Ask questions about your architecture')
        .action(async () => {
            const { startChat } = await import('../../chat.js');
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            try {
                await startChat();
            } catch (err) {
                console.error('Chat error:', (err as Error).message);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
