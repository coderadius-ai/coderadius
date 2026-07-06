/**
 * CLI command: cr review pending
 *
 * Lists every inferred node (MessageChannel, DataContainer, APIEndpoint, …)
 * flagged `needsReview = true`, with a compact summary of its grounding so
 * a human can triage the extraction. The operator chooses to keep or override
 * the result; nothing here mutates the graph.
 *
 * Naming: `pending` rather than `queue`. AMQP terminology already uses
 * "queue" for a transport primitive in this codebase, and a CLI subcommand
 * named `queue` would read ambiguously next to MessageChannel work.
 */
import { Command } from 'commander';
import chalk from 'chalk';

/** Commander accumulator for repeatable --source flags (e.g. `--source ast --source llm`). */
function collectSource(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

/**
 * Map known extractor tags to a human-readable reason + a concrete suggestion
 * for what the reviewer should DO. The reviewer should not need to grep the
 * codebase to understand why a node is here.
 *
 * Tag schema: `<source-extractor>@<version>`. Tags not in this map fall back
 * to a generic "Untagged" reason.
 */
export interface ReviewReason {
    label: string;
    suggestion: string;
}
export const REVIEW_REASONS: Record<string, ReviewReason> = {
    'broker-candidate@v1': {
        label: 'Connection target looks like a broker but could not be grounded',
        suggestion: 'Found in an env-var / config connection string but never confirmed as a message broker. If it IS one, declare it in `coderadius.yaml.messageBrokers`; otherwise leave it — it stays in the ledger and is never welded into the graph (many candidates here are SMTP/FTP/HTTP false positives).',
    },
    'broker-candidate-convergence@v1': {
        label: 'Broker inferred from multiple services, provider still a guess',
        suggestion: 'Several services point at this host, but no contract or scheme confirmed the provider. Pin it in `coderadius.yaml.messageBrokers` to promote it past review.',
    },
    'broker-candidate-declared@v1': {
        label: 'Broker provider is declared, but the host value is uncorroborated',
        suggestion: 'A contract names the provider, yet the host came from a name-classified config key. Confirm the host (or pin it in `coderadius.yaml.messageBrokers`) before relying on cross-service welds.',
    },
    'channel-autopromoter-low-evidence@v1': {
        label: 'No routing-table entry matches this channel name',
        suggestion: 'Inferred from call sites only. If this is a CQRS class placeholder, declare it in `coderadius.yaml.message_channels.class_routes`. If opaque SDK, add a decorator rule.',
    },
    'channel-autopromoter-ambiguous@v1': {
        label: 'Multiple brokers bind to the same channel',
        suggestion: 'Pin the intended broker in `coderadius.yaml.messageBrokers`.',
    },
    'channel-autopromoter-schema-anchor@v1': {
        label: 'Schema anchor (DataContract bound)',
        suggestion: 'Logical channel preserved because a contract describes it. Review the contract scope.',
    },
    'channel-routing-pattern-ambiguous@v1': {
        label: 'Routing key matches multiple infra bindings',
        suggestion: 'Pick one queue and pin the mapping in `coderadius.yaml.message_channels.aliases`, then re-run `cr analyze code` (aliases are applied during code ingestion, not in reconcile).',
    },
    'symfony-messenger-dynamic-routing@v1': {
        label: 'Routing table assembled at runtime',
        suggestion: 'Declare the entries statically in `coderadius.yaml.message_channels.class_routes`.',
    },
    'untagged@v1': {
        label: 'Recorded without an extractor identity',
        suggestion: 'An internal tagging gap, not a data problem — safe to keep. Please report it so the producing step can be given an identity.',
    },
};

export function formatReasons(extractors: ReadonlyArray<string>): ReviewReason[] {
    const found: ReviewReason[] = [];
    for (const tag of extractors) {
        const r = REVIEW_REASONS[tag];
        if (r) found.push(r);
    }
    return found;
}

/**
 * Operator-safe copy for an entity whose extractor tags are not (yet) in
 * `REVIEW_REASONS`. This is the triage queue the operator reads, so it must
 * never instruct them to grep the codebase or edit internal symbols — it
 * states the situation plainly and surfaces the raw tag only as a support
 * reference.
 */
export function unmappedReason(extractors: ReadonlyArray<string>): ReviewReason {
    return {
        label: 'Flagged for review (low confidence)',
        suggestion: `Inferred with low confidence and no specific guidance is available yet. Keep it if it looks right, or override it. Reference: ${extractors.join(', ')}`,
    };
}

export function registerReviewCommand(parent: Command): void {
    const cmd = parent
        .command('review')
        .description('Triage inferred entities flagged for human review');

    cmd.command('pending')
        .description('List entities with needsReview=true, grouped by label')
        .option('--label <label>', 'Restrict to a single inferred label (e.g. MessageChannel)')
        .option('--quality-at-least <tier>', 'Only include entities whose quality is at least the given tier (exact|high|medium|low|speculative)')
        .option('--source <source>', 'Only include entities whose grounding source matches (ast|heuristic|llm|composite|declared|infra|runtime); repeat the flag for multiple sources', collectSource, [] as string[])
        .action(async (opts: { label?: string; qualityAtLeast?: string; source?: string[] }) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { listNeedsReview, NEEDS_REVIEW_LABELS } = await import('../../graph/queries/grounding.js');
            const { QUALITY_VALUES, SOURCE_VALUES } = await import('../../graph/grounding.js');
            try {
                if (opts.label && !(NEEDS_REVIEW_LABELS as readonly string[]).includes(opts.label)) {
                    console.error(`\nUnknown label "${opts.label}". Pick one of: ${NEEDS_REVIEW_LABELS.join(', ')}\n`);
                    process.exit(1);
                }
                if (opts.qualityAtLeast && !(QUALITY_VALUES as readonly string[]).includes(opts.qualityAtLeast)) {
                    console.error(`\nUnknown quality tier "${opts.qualityAtLeast}". Pick one of: ${QUALITY_VALUES.join(', ')}\n`);
                    process.exit(1);
                }
                const sources = opts.source ?? [];
                for (const s of sources) {
                    if (!(SOURCE_VALUES as readonly string[]).includes(s)) {
                        console.error(`\nUnknown source "${s}". Pick one of: ${SOURCE_VALUES.join(', ')}\n`);
                        process.exit(1);
                    }
                }
                const items = await listNeedsReview({
                    label: opts.label as any,
                    qualityAtLeast: opts.qualityAtLeast as any,
                    sourceIn: sources.length > 0 ? (sources as any) : undefined,
                });
                if (items.length === 0) {
                    console.log(chalk.green('\n  No entities pending review.\n'));
                    return;
                }

                const byLabel = new Map<string, typeof items>();
                for (const item of items) {
                    const list = byLabel.get(item.label) ?? [];
                    list.push(item);
                    byLabel.set(item.label, list);
                }

                console.log(`\n${chalk.bold('Entities pending review')}\n`);
                console.log(chalk.dim('  Each item carries one or more reasons (derived from extractor tags) explaining why the reviewer must look.\n'));
                for (const [label, group] of byLabel) {
                    console.log(`${chalk.cyan(label)} (${group.length})`);
                    for (const item of group) {
                        const line = `  ${chalk.bold(item.name.padEnd(50))}  ${chalk.dim(`${item.source}/${item.quality}`)}`;
                        console.log(line);
                        const mapped = formatReasons(item.extractors);
                        const reasons = mapped.length > 0
                            ? mapped
                            : item.extractors.length > 0
                                ? [unmappedReason(item.extractors)]
                                : [];
                        for (const r of reasons) {
                            console.log(`    ${chalk.yellow('→')} ${chalk.bold(r.label)}`);
                            console.log(`      ${chalk.dim(r.suggestion)}`);
                        }
                        if (item.fallbacksApplied.length > 0) {
                            console.log(`    ${chalk.dim('fallbacks:')} ${item.fallbacksApplied.join(', ')}`);
                        }
                    }
                    console.log('');
                }
            } catch (err) {
                console.error(`\nFailed to list pending review items: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
