import { run, runDDL } from './mutations/_run.js';
import { logger } from '../utils/logger.js';

// ─── Index Names (shared constant — used in queries too) ─────────────────────

export const VECTOR_INDEX = {
    FUNCTION: 'function_embedding_idx',
    ENDPOINT: 'endpoint_embedding_idx',
    AGENTIC_CONFIG: 'agentic_config_embedding_idx',
} as const;

// ─── Index Definitions ───────────────────────────────────────────────────────

interface VectorIndexDef {
    name: string;
    label: string;
    property: string;
    capacity: number;
}

const INDEX_DEFINITIONS: VectorIndexDef[] = [
    { name: VECTOR_INDEX.FUNCTION, label: 'Function', property: 'embedding', capacity: 50000 },
    { name: VECTOR_INDEX.ENDPOINT, label: 'APIEndpoint', property: 'embedding', capacity: 20000 },
    { name: VECTOR_INDEX.AGENTIC_CONFIG, label: 'AgenticConfig', property: 'embedding', capacity: 10000 },
];

// ─── Public API ──────────────────────────────────────────────────────────────

let _indexesInitialized = false;
let _vectorUnsupported = false;

/**
 * Ensure all vector indexes exist with the correct dimension.
 *
 * If an existing index has a different dimension (e.g., model switch from
 * Gemini 768-dim to Bedrock 1024-dim), the old index is dropped, recreated,
 * and stale embedding properties are wiped from affected nodes.
 */
export async function ensureVectorIndexes(dimension: number): Promise<void> {
    if (_indexesInitialized) return;

    const existingIndexes = await showVectorIndexInfo();
    const existingByName = new Map(existingIndexes.map(i => [i.indexName, i]));

    for (const def of INDEX_DEFINITIONS) {
        const existing = existingByName.get(def.name);
        const existingDim = existing ? Number(existing.dimension) : undefined;

        if (existingDim === dimension) {
            logger.debug(`[VectorIndex] Index already exists with correct dimension (skipping): ${def.name}`);
            continue;
        }

        if (existing && existingDim !== dimension) {
            logger.warn(
                `[VectorIndex] Dimension mismatch for ${def.name}: ` +
                `existing=${existingDim}, required=${dimension}. Recreating index.`,
            );
            try {
                await runDDL(`DROP VECTOR INDEX ${def.name}`);
            } catch (err) {
                logger.warn(`[VectorIndex] Failed to drop ${def.name}: ${(err as Error).message}`);
            }
            try {
                await run(
                    `MATCH (n:${def.label}) WHERE n.${def.property} IS NOT NULL REMOVE n.${def.property}`,
                );
                logger.warn(`[VectorIndex] Cleared stale ${def.property} on :${def.label} nodes.`);
            } catch (err) {
                logger.warn(`[VectorIndex] Failed to clear stale embeddings: ${(err as Error).message}`);
            }
        }

        try {
            await runDDL(
                `CREATE VECTOR INDEX ${def.name} ON :${def.label}(${def.property})
                 WITH CONFIG {
                   "dimension": ${dimension},
                   "capacity": ${def.capacity},
                   "metric": "cos",
                   "scalar_kind": "f16"
                 }`,
            );
            logger.debug(`[VectorIndex] Created index: ${def.name} ON :${def.label}(${def.property}) [dim=${dimension}]`);
        } catch (err) {
            const msg = (err as Error).message;

            if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('exist')) {
                logger.debug(`[VectorIndex] Index already exists (skipping): ${def.name}`);
                continue;
            }

            if (msg.includes('mismatched input') || msg.includes('no viable alternative') || msg.includes('expecting')) {
                if (!_vectorUnsupported) {
                    _vectorUnsupported = true;
                    logger.warn(
                        `[VectorIndex] Memgraph instance does not support CREATE VECTOR INDEX DDL. ` +
                        `Upgrade the container to memgraph/memgraph-mage:latest to enable semantic search. ` +
                        `Embeddings will still be stored; vector indexes will not be created.`,
                    );
                } else {
                    logger.debug(`[VectorIndex] Skipping ${def.name} (vector DDL unsupported)`);
                }
                continue;
            }

            logger.warn(`[VectorIndex] Failed to create index ${def.name}: ${msg}`);
        }
    }

    _indexesInitialized = true;
}

export function resetVectorIndexState(): void {
    _indexesInitialized = false;
    _vectorUnsupported = false;
}

export async function showVectorIndexInfo(): Promise<Array<{
    indexName: string;
    label: string;
    property: string;
    dimension: number;
    capacity: number;
    size: number;
    metric: string;
}>> {
    try {
        const result = await runDDL(`SHOW VECTOR INDEX INFO`);
        return result.records.map((r: { get: (key: string) => unknown }) => ({
            indexName: r.get('index_name') as string,
            label: r.get('label') as string,
            property: r.get('property') as string,
            dimension: r.get('dimension') as number,
            capacity: r.get('capacity') as number,
            size: r.get('size') as number,
            metric: r.get('metric') as string,
        }));
    } catch {
        return [];
    }
}
