/**
 * Gravity & SPOF Analysis — Application Service
 *
 * Orchestrates the global architecture gravity scan.
 * UI-agnostic: both CLI and MCP delegate to this module.
 */

import { analyzeDataGravity, analyzeServiceBottlenecks } from '../queries/gravity.js';
import { GravityAnalysisResultSchema, type GravityAnalysisResult } from '../types.js';

export interface GravityOptions {
    limit?: number;
}

/**
 * Full orchestration pipeline:
 *   1. Run Data Gravity and Service Bottleneck queries in parallel
 *   2. Assemble and validate the result via Zod
 */
export async function analyzeGravity(options?: GravityOptions): Promise<GravityAnalysisResult> {
    const limit = options?.limit ?? 10;

    const [dataMonoliths, serviceBottlenecks] = await Promise.all([
        analyzeDataGravity(limit),
        analyzeServiceBottlenecks(limit),
    ]);

    return GravityAnalysisResultSchema.parse({
        dataMonoliths,
        serviceBottlenecks,
        summary: {
            analyzedAt: new Date().toISOString(),
            totalNodesScanned: dataMonoliths.length + serviceBottlenecks.length,
        },
    });
}
