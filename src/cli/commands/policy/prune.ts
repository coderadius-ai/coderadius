import { Command } from 'commander';

// ═══════════════════════════════════════════════════════════════════════════════
// `cr policy prune` Command
//
// Explicit, operator-driven removal of PolicyRule catalog nodes (and their
// PolicyEvaluation results) from the graph. There is no automatic orphan GC:
// tags are many-to-one, so they cannot identify a pack scope without risking
// deletion of unrelated packs. Pruning is therefore deliberate and dry-run by
// default.
//
// Two modes:
//   cr policy prune <ruleId…>          surgical: delete exactly the named rules
//   cr policy prune --rules-path <path> reap rules absent from a loaded pack,
//                                       scoped to that pack's tags
// ═══════════════════════════════════════════════════════════════════════════════

interface PolicyPruneOptions {
    rulesPath?: string;
    force?: boolean;
}

/**
 * Pure scoping: which persisted rule ids are orphans of the loaded pack.
 *
 * A candidate is a persisted rule that (a) shares at least one tag with the
 * loaded pack and (b) is no longer in the loaded id set. An empty `runTags`
 * yields no candidates, so an untagged pack can never reap anything.
 */
export function computePruneCandidates(
    persisted: { id: string; tags: string[] }[],
    currentIds: string[],
    runTags: string[],
): string[] {
    if (runTags.length === 0) return [];
    const keep = new Set(currentIds);
    return persisted
        .filter(r => !keep.has(r.id) && r.tags.some(t => runTags.includes(t)))
        .map(r => r.id);
}

async function resolveTargets(ruleIds: string[], opts: PolicyPruneOptions): Promise<string[]> {
    if (ruleIds.length > 0) return ruleIds;

    const { loadPolicies } = await import('../../../policy-runner/loader.js');
    const { listPersistedPolicyRules } = await import('../../../policy-runner/reporter.js');
    const rules = await loadPolicies({ rulesPath: opts.rulesPath! });
    const currentIds = rules.map(r => r.id);
    const runTags = [...new Set(rules.flatMap(r => r.tags ?? []))];
    const persisted = await listPersistedPolicyRules();
    return computePruneCandidates(persisted, currentIds, runTags);
}

function printPlan(targets: string[], counts: Record<string, number>, force: boolean): void {
    console.log(`\n${force ? 'Pruning:' : 'Would prune (dry-run):'}`);
    for (const id of targets) {
        console.log(`  ${id}  (${counts[id] ?? 0} validation(s))`);
    }
    if (!force) console.log('\nRe-run with --force to delete.');
}

export function registerPolicyPruneCommand(parentCmd: Command): void {
    parentCmd
        .command('prune [ruleIds...]')
        .description('Remove policies and their validations from the graph')
        .option('--rules-path <path>', 'Reap rules absent from this pack/path, within its tag scope')
        .option('--force', 'Actually delete (default is a dry-run preview)')
        .action(async (ruleIds: string[], opts: PolicyPruneOptions) => {
            const { closeNeo4j } = await import('../../../graph/neo4j.js');
            const { countEvaluationsForRules, deletePolicyRulesAndEvaluations } =
                await import('../../../policy-runner/reporter.js');

            try {
                if (ruleIds.length === 0 && !opts.rulesPath) {
                    console.error('\nSpecify rule ids, or --rules-path <path> to reap a pack\'s orphans.');
                    process.exit(1);
                }

                const targets = await resolveTargets(ruleIds, opts);
                if (targets.length === 0) {
                    console.log('\nNothing to prune.');
                    return;
                }

                const counts = await countEvaluationsForRules(targets);
                printPlan(targets, counts, opts.force ?? false);
                if (!opts.force) return;

                const { rules, evaluations } = await deletePolicyRulesAndEvaluations(targets);
                console.log(`\nPruned ${rules} rule(s) and ${evaluations} validation(s) from the graph.`);
            } catch (err) {
                console.error(`\nPolicy prune failed: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
