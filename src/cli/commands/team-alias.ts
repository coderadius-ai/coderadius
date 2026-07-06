/**
 * CLI Command: cr config team-alias
 *
 * Manage AI-proposed team identity aliases.
 *   - list:    Show all proposals (pending, approved, rejected)
 *   - approve: Accept a proposal and materialize ownership edges
 *   - reject:  Dismiss a proposal
 */
import { Command } from 'commander';

export function registerTeamAliasCommand(parentCmd: Command): void {
    const cmd = parentCmd
        .command('team-alias')
        .description('Manage AI-proposed team identity aliases');

    // ── List ──────────────────────────────────────────────────────────────────

    cmd.command('list')
        .description('List all team alias proposals')
        .option('--pending', 'Show only pending proposals')
        .action(async (opts: { pending?: boolean }) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { queryTeamAliasProposals } = await import('../../graph/mutations/team-alias.js');
            try {
                let proposals = await queryTeamAliasProposals();

                if (opts.pending) {
                    proposals = proposals.filter(p => p.status === 'pending');
                }

                if (proposals.length === 0) {
                    console.log('\n  No team alias proposals found.');
                    console.log('  Run `cr analyze code --depth structure` to detect phantom teams.\n');
                    return;
                }

                const statusLabel = (s: string) =>
                    s === 'pending' ? 'PENDING' : s === 'approved' ? 'APPROVED' : 'REJECTED';

                console.log('\n  Team Alias Proposals\n');

                // Simple table output
                const header = '  Phantom'.padEnd(28) +
                    'Canonical Team'.padEnd(30) +
                    'Conf.'.padEnd(8) +
                    'Status'.padEnd(12) +
                    'Repos';
                console.log(header);
                console.log('  ' + '─'.repeat(header.length - 2));

                for (const p of proposals) {
                    const line = `  ${statusLabel(p.status)} ${p.phantomName}`.padEnd(28) +
                        p.canonicalTeam.padEnd(30) +
                        `${Math.round(p.confidence * 100)}%`.padEnd(8) +
                        p.status.padEnd(12) +
                        String(p.affectedRepos);
                    console.log(line);
                }

                const pending = proposals.filter(p => p.status === 'pending');
                if (pending.length > 0) {
                    console.log(`\n  ${pending.length} pending proposal(s). Use:`);
                    console.log('  cr config team-alias approve <phantom>');
                    console.log('  cr config team-alias reject <phantom>\n');
                } else {
                    console.log('');
                }
            } catch (err) {
                console.error(`\nFailed to list proposals: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });

    // ── Approve ───────────────────────────────────────────────────────────────

    cmd.command('approve <phantomName>')
        .description('Approve a team alias and materialize ownership edges')
        .action(async (phantomName: string) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { approveTeamAlias } = await import('../../graph/mutations/team-alias.js');
            try {
                const result = await approveTeamAlias(phantomName);
                console.log(`\nApproved alias '${phantomName}'`);
                console.log(`   Linked ${result.reposLinked} repository(ies) and ${result.servicesLinked} service(s) to the canonical team.`);
                console.log('   Run `cr ui` to see the consolidated view.\n');
            } catch (err) {
                console.error(`\nFailed to approve alias: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });

    // ── Reject ────────────────────────────────────────────────────────────────

    cmd.command('reject <phantomName>')
        .description('Reject a team alias proposal')
        .action(async (phantomName: string) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { rejectTeamAlias } = await import('../../graph/mutations/team-alias.js');
            try {
                await rejectTeamAlias(phantomName);
                console.log(`\nRejected alias '${phantomName}'. It will not appear in future proposals.\n`);
            } catch (err) {
                console.error(`\nFailed to reject alias: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
