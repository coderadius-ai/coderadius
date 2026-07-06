/**
 * Standalone-file infra ingest.
 *
 * Fast-path for `cr analyze infra <file>`: read a single file from disk,
 * route it directly to whichever structural plugin recognises it (matchFile
 * + contentSignatures), persist its extracted entities. Bypasses governance
 * scan, source resolver, and per-repo discovery entirely.
 *
 * Persistence writes extracted entities directly. It deliberately does NOT
 * create a synthetic Repository/StructuralFile chain: single-file infra inputs
 * are operator snapshots, and storing their absolute paths leaks local machine
 * details into the graph.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as structQueries from './queries.js';
import { FILE_PLUGINS } from './plugin-manager.js';
import { ScopeManager } from '../core/scope-manager.js';
import { logger } from '../../utils/logger.js';
import type { PluginContext, StructuralPlugin } from './types.js';

const STANDALONE_REPO_NAME = 'standalone-infra';
const STANDALONE_REPO_URN = 'cr:repository:standalone-infra';

export interface StandaloneIngestResult {
    filePath: string;
    pluginName: string | null;
    entitiesPersisted: number;
    edgesPersisted: number;
}

function matchPlugin(absolutePath: string, basename: string, content: string): StructuralPlugin | null {
    for (const plugin of FILE_PLUGINS) {
        if (!plugin.matchFile(absolutePath, basename)) continue;
        if (plugin.contentSignatures && plugin.contentSignatures.length > 0) {
            const ok = plugin.contentSignatures.some(re => re.test(content));
            if (!ok) continue;
        }
        return plugin;
    }
    return null;
}

export async function ingestStandaloneInfraFile(absolutePath: string): Promise<StandaloneIngestResult> {
    const result: StandaloneIngestResult = { filePath: absolutePath, pluginName: null, entitiesPersisted: 0, edgesPersisted: 0 };

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return result;
    }
    const basename = path.basename(absolutePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');

    const plugin = matchPlugin(absolutePath, basename, content);
    if (!plugin) {
        logger.warn(`[standalone-infra] No structural plugin recognises ${basename}`);
        return result;
    }
    result.pluginName = plugin.name;

    const scopeManager = new ScopeManager(path.dirname(absolutePath));
    const ctx: PluginContext = {
        relativePath: basename,
        absolutePath,
        repoName: STANDALONE_REPO_NAME,
        repoUrn: STANDALONE_REPO_URN,
        scopeManager,
    };

    let entities;
    try {
        const out = plugin.extract(content, ctx);
        entities = out.entities;
    } catch (err) {
        logger.error(`[standalone-infra] Plugin ${plugin.name} failed on ${basename}: ${(err as Error).message}`);
        return result;
    }

    for (const entity of entities) {
        try {
            await structQueries.mergeStandaloneStructuralEntity(entity);
            result.entitiesPersisted++;
        } catch (err) {
            logger.warn(`[standalone-infra] Failed to merge ${entity.id}: ${(err as Error).message}`);
        }
    }
    for (const entity of entities) {
        if (!entity.edges) continue;
        for (const edge of entity.edges) {
            try {
                await structQueries.mergeStructuralEdge(edge.sourceUrn, edge.targetUrn, edge.type, edge.properties);
                result.edgesPersisted++;
            } catch (err) {
                logger.warn(`[standalone-infra] Failed to create edge ${edge.type}: ${(err as Error).message}`);
            }
        }
    }
    return result;
}
