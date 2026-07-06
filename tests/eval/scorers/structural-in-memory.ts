// ═══════════════════════════════════════════════════════════════════════════════
// Structural plugins, in-memory — DB-free analog of ingestStructural
//
// The extraction harness scores the ephemeral topology (language-plugin
// static infra + LLM semantics), but CONFIG-declared infrastructure lives in
// the structural FILE_PLUGINS (messenger.yaml → MessageChannel, Doctrine
// migrations → DataContainer, rabbitmq-definitions.json → broker + channels).
// Those plugins never run through the ephemeral extractor.
//
// This module runs the REAL FILE_PLUGINS array against in-memory file contents
// — no database, no ingestStructural, no graph writer — and maps every emitted
// StructuralEntity into the GraphNodeSnapshot / GraphEdgeSnapshot shape the
// eval-scorer already consumes. The extraction LOGIC is untouched: we call
// `plugin.extract()` exactly as the plugin manager does (same matchFile +
// contentSignatures gate, same per-plugin error isolation), so the coverage
// snapshot sees precisely what production would persist.
//
// Node-name mapping: every structural entity carries its human name in
// `properties.name` (MessageChannel channel/transport name, DataContainer table
// name). MessageBroker entities have no `name` (they are keyed by provider +
// fingerprint), so they map to an empty name — harmless, since no golden scores
// the MessageBroker label. Edges reference nodes by URN; we resolve URN → name
// via the emitted entities so node-edge assertions (e.g. logical channel
// -[MANIFESTS_AS]-> transport) score by human name like the live scorer.
// ═══════════════════════════════════════════════════════════════════════════════

import { FILE_PLUGINS } from '../../../src/ingestion/structural/plugin-manager.js';
import { ScopeManager } from '../../../src/ingestion/core/scope-manager.js';
import { buildUrn } from '../../../src/graph/urn.js';
import path from 'node:path';
import type { PluginContext, StructuralEntity } from '../../../src/ingestion/structural/types.js';
import type { GraphNodeSnapshot, GraphEdgeSnapshot } from '../../../src/eval/types.js';

export interface StructuralInMemoryResult {
    nodes: GraphNodeSnapshot[];
    edges: GraphEdgeSnapshot[];
}

/** Human name for an entity — every structural entity stores it at `properties.name`. */
function entityName(entity: StructuralEntity): string {
    const name = entity.properties.name;
    return typeof name === 'string' ? name : '';
}

/**
 * Run every FILE_PLUGIN whose `matchFile` (then `contentSignatures`) accepts a
 * file, exactly as the plugin manager does, and translate the emitted entities
 * into the eval-scorer snapshot shape. Pure: no DB, no filesystem writes, zero
 * LLM calls (structural plugins are deterministic).
 */
export function runStructuralPluginsInMemory(
    files: Array<{ path: string; content: string }>,
    repoName: string,
): StructuralInMemoryResult {
    const repoUrn = buildUrn('repository', repoName);
    // Structural plugins that consult the ScopeManager only read .gitignore /
    // .crignore; none of the messaging/migration plugins use it, but the
    // PluginContext type requires an instance. A cwd-rooted manager is inert here.
    const scopeManager = new ScopeManager('.');

    const entities: StructuralEntity[] = [];
    for (const file of files) {
        const relativePath = file.path;
        const basename = path.basename(relativePath);
        const matching = FILE_PLUGINS.filter(p => p.matchFile(relativePath, basename));
        if (matching.length === 0) continue;

        // Duck-typing gate: mirror the plugin manager's contentSignatures
        // pre-filter so plugins that match a broad glob (e.g. rabbitmq-config
        // on any .json) never see files that fail their content signature.
        const valid = matching.filter(p =>
            !p.contentSignatures || p.contentSignatures.length === 0
                ? true
                : p.contentSignatures.some(re => re.test(file.content)),
        );
        if (valid.length === 0) continue;

        const context: PluginContext = {
            relativePath,
            absolutePath: relativePath,
            repoName,
            repoUrn,
            scopeManager,
        };

        for (const plugin of valid) {
            try {
                // Per-plugin isolation, matching the plugin manager: a plugin
                // that throws on a stubbed context contributes nothing rather
                // than failing the whole pass.
                entities.push(...plugin.extract(file.content, context).entities);
            } catch {
                /* swallow — mirrors PluginManager's per-plugin try/catch */
            }
        }
    }

    // URN → (name, label) so edges can be scored by human name like the live scorer.
    const nameByUrn = new Map<string, string>();
    const labelByUrn = new Map<string, string>();
    for (const e of entities) {
        nameByUrn.set(e.id, entityName(e));
        labelByUrn.set(e.id, e.labels[0] ?? '');
    }

    // Dedup nodes by URN (entities are idempotent across files).
    const nodesById = new Map<string, GraphNodeSnapshot>();
    const edges: GraphEdgeSnapshot[] = [];
    for (const e of entities) {
        if (!nodesById.has(e.id)) {
            nodesById.set(e.id, {
                id: e.id,
                type: e.labels[0] ?? '',
                name: entityName(e),
                sourceFile: (e.properties._sourcePath as string) ?? '',
            });
        }
        for (const edge of e.edges ?? []) {
            edges.push({
                sourceId: edge.sourceUrn,
                sourceName: nameByUrn.get(edge.sourceUrn) ?? edge.sourceUrn,
                targetId: edge.targetUrn,
                targetName: nameByUrn.get(edge.targetUrn) ?? edge.targetUrn,
                relType: edge.type,
                sourceFile: (e.properties._sourcePath as string) ?? '',
                targetType: labelByUrn.get(edge.targetUrn) ?? '',
            });
        }
    }

    return { nodes: [...nodesById.values()], edges };
}
