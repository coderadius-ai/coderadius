// ═══════════════════════════════════════════════════════════════════════════════
// Crossplane PubSub Plugin — Structural Extraction of Helm CRD Claims
//
// Extracts MessageChannel topology from Crossplane/Helm chart templates.
// Detects Crossplane claim CRDs, resolves Go template references against
// values.yaml, and emits:
//   - MessageChannel nodes (topic + subscription)
//   - ROUTES_TO edges (subscription → topic)
//
// Claim kinds are configurable: the plugin ships neutral defaults
// (AcmePubSubTopicClaim / AcmePubSubTopicSubscriptionClaim) and merges the
// repo's coderadius.yaml `crossplane.crds` declarations over them — a
// configured entry with the same `kind` as a default overrides that default.
// Everything else is generic infrastructure.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import yaml from 'js-yaml';
import type { StructuralPlugin, PluginContext, StructuralExtractionResult, StructuralEntity } from '../../types.js';
import {
    stripGoTemplates,
    findValuesFile,
    resolvePlaceholders,
} from './helm-template-resolver.js';
import { logger } from '../../../../utils/logger.js';
import { buildMessageChannelUrn } from '../../../../graph/mutations/data-contracts.js';
import { getCrossplaneCrds, loadRepoHints, type CrossplaneCrd } from '../../../../config/repo-hints.js';

// ─── CRD Handler Registry ───────────────────────────────────────────────────
// Each entry maps a Crossplane claim CRD kind to the MessageChannel semantics
// it provisions. The shape is the `crossplane.crds` repo-hint entry, so
// customer declarations and shipped defaults are interchangeable.

type CrdHandler = CrossplaneCrd;

const DEFAULT_CRD_HANDLERS: CrdHandler[] = [
    {
        kind: 'AcmePubSubTopicClaim',
        channelKind: 'topic',
        nameField: 'spec.topicId',
        technology: 'pubsub',
    },
    {
        kind: 'AcmePubSubTopicSubscriptionClaim',
        channelKind: 'subscription',
        nameField: 'spec.topicId',
        topicField: 'spec.topicId',
        technology: 'pubsub',
    },
];

/**
 * Derive the repo root from the plugin context. The plugin manager builds
 * `absolutePath` as `<repoRoot>/<relativePath>`, so stripping the relative
 * suffix recovers the root where coderadius.yaml lives.
 */
function repoRootOf(context: PluginContext): string | null {
    const { absolutePath, relativePath } = context;
    if (!relativePath || !absolutePath.endsWith(relativePath)) return null;
    const root = absolutePath
        .slice(0, absolutePath.length - relativePath.length)
        .replace(/[/\\]+$/, '');
    return root || null;
}

/**
 * Merge configured claim kinds (coderadius.yaml `crossplane.crds`) over the
 * neutral defaults. A configured entry with the same `kind` as a default
 * overrides that default. `loadRepoHints` is memoized per repo root, so this
 * costs one map merge per file — no repeated disk reads.
 */
function resolveCrdHandlers(context: PluginContext): CrdHandler[] {
    const handlers = new Map(DEFAULT_CRD_HANDLERS.map(h => [h.kind, h]));
    const repoRoot = repoRootOf(context);
    if (repoRoot) {
        for (const crd of getCrossplaneCrds(loadRepoHints(repoRoot))) {
            handlers.set(crd.kind, crd);
        }
    }
    return [...handlers.values()];
}

// ─── URN Helpers ─────────────────────────────────────────────────────────────
// Uses the canonical buildMessageChannelUrn() from the graph core to ensure
// idempotent MERGE with nodes created by the LLM code pipeline.
// Previously this was a local reimplementation that lowercased the name,
// causing a case mismatch (structural: lowercase URN vs code pipeline: original case).

// ─── Value Resolution ────────────────────────────────────────────────────────

/**
 * Resolve a field value from a parsed YAML document.
 * Handles both raw values and __CR_VAL__ placeholders.
 */
function resolveField(
    doc: Record<string, unknown>,
    dotPath: string,
    values: Record<string, unknown> | null,
): string | undefined {
    const segments = dotPath.split('.');
    let current: unknown = doc;

    for (const segment of segments) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }

    if (current === null || current === undefined) return undefined;
    let raw = String(current);

    // If the value contains unresolved placeholders, try to resolve them
    if (values && raw.includes('__CR_VAL_')) {
        raw = resolvePlaceholders(raw, values);
    }

    // Strip any remaining placeholders (e.g. Release.Name leftovers)
    raw = raw.replace(/__CR_[A-Z_]+__/g, '').replace(/^-+|-+$/g, '').trim();

    return raw || undefined;
}

/**
 * Extract the subscription name from the metadata.name field.
 * Strips Helm Release.Name prefix (which becomes empty string after template stripping).
 */
function resolveSubscriptionName(
    doc: Record<string, unknown>,
    values: Record<string, unknown> | null,
): string | undefined {
    const metadata = doc.metadata as Record<string, unknown> | undefined;
    if (!metadata) return undefined;
    let name = String(metadata.name ?? '');

    // Resolve any placeholders in the name
    if (values && name.includes('__CR_VAL_')) {
        name = resolvePlaceholders(name, values);
    }

    // Clean up Release.Name artifacts (leading hyphens, empty segments)
    name = name.replace(/__CR_[A-Z_]+__/g, '').replace(/^-+/, '').trim();

    return name || undefined;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const crossplanePubsubPlugin: StructuralPlugin = {
    name: 'crossplane-pubsub',
    label: 'Crossplane PubSub',
    managedLabels: [], // We do NOT manage MessageChannel reconciliation — see safety note below

    // Configured claim kinds are unknown at signature time (per-repo config),
    // so the fast-fail gate keys on the Crossplane claim naming convention:
    // claim kinds end in "Claim". Literal-heavy and linear-time (no ReDoS).
    // Non-messaging claims (e.g. PersistentVolumeClaim) pass the gate but
    // no-op in extract() when no handler matches their kind.
    contentSignatures: [
        /kind:\s*[A-Za-z0-9]+Claim\b/,
    ],

    matchFile(relativePath: string, basename: string): boolean {
        return basename.endsWith('.yaml') || basename.endsWith('.yml');
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        const empty: StructuralExtractionResult = { entities: [], summary: '' };

        // ── 1. Load values.yaml ──────────────────────────────────────────
        const valuesPath = findValuesFile(context.absolutePath);
        let values: Record<string, unknown> | null = null;

        if (valuesPath) {
            try {
                const valuesContent = fs.readFileSync(valuesPath, 'utf-8');
                // values.yaml itself may contain Go templates (e.g., {{ $.Release.Name }})
                // but the configuration keys are usually plain literals
                values = yaml.load(stripGoTemplates(valuesContent)) as Record<string, unknown>;
            } catch (err) {
                logger.debug(`[crossplane-pubsub] Failed to parse values.yaml at ${valuesPath}: ${(err as Error).message}`);
            }
        }

        // ── 2. Strip Go templates and parse ──────────────────────────────
        const docs: Record<string, unknown>[] = [];
        const stripped = stripGoTemplates(content);
        // Split multi-document YAML explicitly to isolate failures
        const chunks = stripped.split(/^---$/m);

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            try {
                const doc = yaml.load(chunk);
                if (doc && typeof doc === 'object') {
                    docs.push(doc as Record<string, unknown>);
                }
            } catch (err) {
                logger.debug(`[crossplane-pubsub] Failed to parse a document chunk in ${context.relativePath}: ${(err as Error).message}`);
            }
        }

        if (docs.length === 0) return empty;

        const entities: StructuralEntity[] = [];
        const summaries: string[] = [];
        const crdHandlers = resolveCrdHandlers(context);

        // ── 3. Match CRD kind against handlers ──────────────────────────
        for (const doc of docs) {
            const kind = String(doc.kind ?? '');
            const handler = crdHandlers.find(h => h.kind === kind);
            if (!handler) continue;

            // ── 4. Extract channel name ──────────────────────────────────────
            if (handler.channelKind === 'topic') {
                // Topic claim: emit a single MessageChannel
                const topicName = resolveField(doc, handler.nameField, values);
                if (!topicName) {
                    logger.debug(`[crossplane-pubsub] Could not resolve topic name from ${handler.nameField} in ${context.relativePath}`);
                    continue;
                }

                const topicUrn = buildMessageChannelUrn(topicName, 'topic');
                const serviceUrn = context.ownerService
                    ? `cr:service:${context.repoName}:${context.ownerService}`
                    : null;

                const topicEntity: StructuralEntity = {
                    id: topicUrn,
                    labels: ['MessageChannel'],
                    properties: {
                        name: topicName,
                        channelKind: 'topic',
                        technology: handler.technology,
                        discoverySource: 'crossplane',
                    },
                    relationshipType: 'DEFINES',
                };

                // Add governance edge: Service → PROVISIONS → Topic
                if (serviceUrn) {
                    topicEntity.edges = [{
                        sourceUrn: serviceUrn,
                        targetUrn: topicUrn,
                        type: 'PROVISIONS',
                    }];
                }

                entities.push(topicEntity);
                summaries.push(`Topic: ${topicName}`);
            } else if (handler.channelKind === 'subscription') {
                // Subscription claim: emit subscription + topic + ROUTES_TO edge
                const subscriptionName = resolveSubscriptionName(doc, values);
                if (!subscriptionName) {
                    logger.debug(`[crossplane-pubsub] Could not resolve subscription name from metadata.name in ${context.relativePath}`);
                    continue;
                }

                const subUrn = buildMessageChannelUrn(subscriptionName, 'subscription');
                const subEntity: StructuralEntity = {
                    id: subUrn,
                    labels: ['MessageChannel'],
                    properties: {
                        name: subscriptionName,
                        channelKind: 'subscription',
                        technology: handler.technology,
                        discoverySource: 'crossplane',
                    },
                    relationshipType: 'DEFINES',
                };

                // Resolve the linked topic
                if (handler.topicField) {
                    const topicName = resolveField(doc, handler.topicField, values);
                    if (topicName) {
                        const topicUrn = buildMessageChannelUrn(topicName, 'topic');

                        // Emit the topic node too (may already exist from another template)
                        entities.push({
                            id: topicUrn,
                            labels: ['MessageChannel'],
                            properties: {
                                name: topicName,
                                channelKind: 'topic',
                                technology: handler.technology,
                                discoverySource: 'crossplane',
                            },
                            relationshipType: 'DEFINES',
                        });

                        const serviceUrn = context.ownerService
                            ? `cr:service:${context.repoName}:${context.ownerService}`
                            : null;

                        const subEdges: Array<{ sourceUrn: string; targetUrn: string; type: string }> = [
                            {
                                sourceUrn: subUrn,
                                targetUrn: topicUrn,
                                type: 'ROUTES_TO',
                            },
                        ];
                        if (serviceUrn) {
                            subEdges.push({
                                sourceUrn: serviceUrn,
                                targetUrn: subUrn,
                                type: 'PROVISIONS',
                            });
                        }
                        subEntity.edges = subEdges;
                        entities.push(subEntity);
                        summaries.push(`Subscription: ${subscriptionName} → Topic: ${topicName}`);
                    } else {
                        logger.debug(`[crossplane-pubsub] Could not resolve linked topic from ${handler.topicField} in ${context.relativePath}`);
                        entities.push(subEntity);
                        summaries.push(`Subscription: ${subscriptionName}`);
                    }
                } else {
                    // No topic linkage — just emit the subscription
                    entities.push(subEntity);
                    summaries.push(`Subscription: ${subscriptionName}`);
                }
            }
        }

        if (entities.length === 0) return empty;

        return {
            entities,
            summary: summaries.join(', '),
        };
    },
};
