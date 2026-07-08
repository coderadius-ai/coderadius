/**
 * CLI command: cr doctor
 *
 * Diagnoses what the analysis could not infer on its own and prescribes the
 * coderadius.yaml declaration that fixes it. Two sections:
 *
 *   1. Shared databases — cross-repo DataContainers the welder cannot merge
 *      without a physical fingerprint, corroborated by identical endpoint
 *      dbNames. Prescription: `databases[]` with `shared: true`.
 *   2. Pending review — every inferred node flagged `needsReview = true`,
 *      with the reason and (where unambiguous) a paste-ready yaml fragment.
 *
 * The operator chooses to apply or ignore; nothing here mutates the graph.
 * Applied declarations become `declared/exact` grounding on the next
 * `cr analyze code` run.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import type { SharedDbSuggestion } from '../../graph/queries/doctor.js';

/** Commander accumulator for repeatable --source flags (e.g. `--source ast --source llm`). */
function collectSource(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

/**
 * Map known extractor tags to a human-readable reason, a concrete suggestion
 * for what the reviewer should DO, and — where the mapping is unambiguous —
 * a paste-ready coderadius.yaml fragment parameterized on the entity name.
 * The reviewer should not need to grep the codebase to understand why a node
 * is here.
 *
 * Tag schema: `<source-extractor>@<version>`. Tags not in this map fall back
 * to a generic "Untagged" reason.
 */
export interface ReviewReason {
    label: string;
    suggestion: string;
    /** Paste-ready coderadius.yaml fragment; omit when the fix is not a single yaml block. */
    yaml?: (name: string) => string;
}

const brokerYaml = (name: string): string =>
    `messageBrokers:
  - id: ${name}
    provider: rabbitmq  # confirm: rabbitmq|kafka|pubsub|sqs|sns|nats|...`;

const classRouteYaml = (name: string): string =>
    `message_channels:
  class_routes:
    - class: ${name}
      routing_key: <the.routing.key.it.dispatches.to>`;

const aliasYaml = (name: string): string =>
    `message_channels:
  aliases:
    - from: ${name}
      name: <physical-channel-name>
      channelKind: queue  # topic|subscription|queue|exchange`;

export const REVIEW_REASONS: Record<string, ReviewReason> = {
    'broker-candidate@v1': {
        label: 'Connection target looks like a broker but could not be grounded',
        suggestion: 'Found in an env-var / config connection string but never confirmed as a message broker. If it IS one, declare it in `coderadius.yaml.messageBrokers`; otherwise leave it — it stays in the ledger and is never welded into the graph (many candidates here are SMTP/FTP/HTTP false positives).',
        yaml: brokerYaml,
    },
    'broker-candidate-convergence@v1': {
        label: 'Broker inferred from multiple services, provider still a guess',
        suggestion: 'Several services point at this host, but no contract or scheme confirmed the provider. Pin it in `coderadius.yaml.messageBrokers` to promote it past review.',
        yaml: brokerYaml,
    },
    'broker-candidate-declared@v1': {
        label: 'Broker provider is declared, but the host value is uncorroborated',
        suggestion: 'A contract names the provider, yet the host came from a name-classified config key. Confirm the host (or pin it in `coderadius.yaml.messageBrokers`) before relying on cross-service welds.',
        yaml: brokerYaml,
    },
    'channel-autopromoter-low-evidence@v1': {
        label: 'No routing-table entry matches this channel name',
        suggestion: 'Inferred from call sites only. If this is a CQRS class placeholder, declare it in `coderadius.yaml.message_channels.class_routes`. If opaque SDK, add a decorator rule.',
        yaml: classRouteYaml,
    },
    'channel-autopromoter-ambiguous@v1': {
        label: 'Multiple brokers bind to the same channel',
        suggestion: 'Pin the intended broker in `coderadius.yaml.messageBrokers`.',
        yaml: brokerYaml,
    },
    'channel-autopromoter-schema-anchor@v1': {
        label: 'Schema anchor (DataContract bound)',
        suggestion: 'Logical channel preserved because a contract describes it. Review the contract scope.',
    },
    'channel-routing-pattern-ambiguous@v1': {
        label: 'Routing key matches multiple infra bindings',
        suggestion: 'Pick one queue and pin the mapping in `coderadius.yaml.message_channels.aliases`, then re-run `cr analyze code` (aliases are applied during code ingestion, not in reconcile).',
        yaml: aliasYaml,
    },
    'symfony-messenger-dynamic-routing@v1': {
        label: 'Routing table assembled at runtime',
        suggestion: 'Declare the entries statically in `coderadius.yaml.message_channels.class_routes`.',
        yaml: classRouteYaml,
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

/** Render a `databases[]` fragment for one shared-database suggestion. */
export function renderSharedDbYaml(s: SharedDbSuggestion): string {
    const tables = s.tables.map(t => `"${t}"`).join(', ');
    return `databases:
  - id: ${s.id}
    technology: ${s.technology ?? '<technology>'}
    shared: true
    tables: [${tables}]`;
}

function indent(text: string, pad: string): string {
    return text.split('\n').map(l => pad + l).join('\n');
}

function renderSharedDbSection(suggestions: SharedDbSuggestion[]): void {
    console.log(`${chalk.bold('Shared databases')} (${suggestions.length})\n`);
    console.log(chalk.dim('  Same tables, different repos, same database name on the endpoints —'));
    console.log(chalk.dim('  the welder cannot merge these without a declaration.\n'));
    for (const s of suggestions) {
        const tech = s.technology ? ` (${s.technology})` : '';
        console.log(`  ${chalk.cyan(s.id)}${tech}`);
        console.log(`    ${chalk.dim('tables:')} ${s.tables.join(', ')}`);
        console.log(`    ${chalk.yellow('→')} add to the coderadius.yaml of ${chalk.bold(s.repos.join(', '))}:\n`);
        console.log(indent(renderSharedDbYaml(s), '      '));
        console.log('');
    }
}

export function registerDoctorCommand(parent: Command): void {
    parent
        .command('doctor')
        .description('Diagnose analysis gaps and prescribe coderadius.yaml fixes')
        .option('--label <label>', 'Restrict the pending-review list to a single inferred label (e.g. MessageChannel)')
        .option('--quality-at-least <tier>', 'Only include entities whose quality is at least the given tier (exact|high|medium|low|speculative)')
        .option('--source <source>', 'Only include entities whose grounding source matches (ast|heuristic|llm|composite|declared|infra|runtime); repeat the flag for multiple sources', collectSource, [] as string[])
        .option('--json', 'Machine-readable output')
        .action(async (opts: { label?: string; qualityAtLeast?: string; source?: string[]; json?: boolean }) => {
            const { closeNeo4j } = await import('../../graph/neo4j.js');
            const { listNeedsReview, NEEDS_REVIEW_LABELS } = await import('../../graph/queries/grounding.js');
            const { findSharedDbCandidates, groupSharedDbSuggestions } = await import('../../graph/queries/doctor.js');
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
                const suggestions = groupSharedDbSuggestions(await findSharedDbCandidates());
                const items = await listNeedsReview({
                    label: opts.label as any,
                    qualityAtLeast: opts.qualityAtLeast as any,
                    sourceIn: sources.length > 0 ? (sources as any) : undefined,
                });

                if (opts.json) {
                    console.log(JSON.stringify({ sharedDatabases: suggestions, pending: items }, null, 2));
                    return;
                }

                if (suggestions.length === 0 && items.length === 0) {
                    console.log(chalk.green('\n  No gaps — every inferred entity is grounded and nothing needs your input.\n'));
                    return;
                }

                console.log('');
                if (suggestions.length > 0) {
                    renderSharedDbSection(suggestions);
                }

                if (items.length > 0) {
                    const byLabel = new Map<string, typeof items>();
                    for (const item of items) {
                        const list = byLabel.get(item.label) ?? [];
                        list.push(item);
                        byLabel.set(item.label, list);
                    }
                    console.log(`${chalk.bold('Pending review')} (${items.length})\n`);
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
                                if (r.yaml) {
                                    console.log(indent(r.yaml(item.name), '      '));
                                }
                            }
                            if (item.fallbacksApplied.length > 0) {
                                console.log(`    ${chalk.dim('fallbacks:')} ${item.fallbacksApplied.join(', ')}`);
                            }
                        }
                        console.log('');
                    }
                }

                console.log(chalk.dim('  Apply the fragments you agree with, then re-run `cr analyze code` — declared entries become exact grounding.\n'));
            } catch (err) {
                console.error(`\nDoctor failed: ${(err as Error).message}`);
                process.exit(1);
            } finally {
                await closeNeo4j();
            }
        });
}
