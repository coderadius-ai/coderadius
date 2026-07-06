// ═══════════════════════════════════════════════════════════════════════════════
// Data Entity Post-Processor — Dynamic Table Prefix Expansion
//
// Post-ingestion step, analogous to ingestMatchmaking.
// Runs AFTER the full code pipeline has written all nodes to Memgraph.
//
// Problem: PHP/legacy SQL uses dynamic table names via string concatenation
// e.g. 'booking_slot_' . $type  → LLM emits "booking_slot_{type}" or "booking_slot_"
// The sanitizer preserves these as wildcard stubs (isDynamicTableStub = true).
//
// This step:
//  Pass 1a: Clone READS edges from Functions to all matching concrete DataContainers
//  Pass 1b: Clone WRITES edges from Functions to all matching concrete DataContainers
//  Pass 2:  Delete all wildcard stub nodes (DETACH DELETE — safe after cloning)
//
// Prefix extraction:
//  "booking_slot_{type}" → split on '{' → prefix = "booking_slot_"
//  "booking_slot_"       → name already ends with '_' → prefix = "booking_slot_"
//
// The prefix is then used with STARTS WITH to find concrete tables.
// Stubs without any concrete match are also deleted (no phantom nodes persist).
// ═══════════════════════════════════════════════════════════════════════════════

import { getMemgraphSession } from '../../graph/neo4j.js';
import { logger } from '../../utils/logger.js';

/**
 * Run the dynamic DataContainer prefix expansion step.
 * Call this after ingestMatchmaking() in the ingestion pipeline.
 */
export async function runDataEntityPostProcessor(task?: { report?: (msg: string) => void; setPhase?: (phase: string) => void }): Promise<{
    stubsExpanded: number;
    edgesCloned: number;
    stubsDeleted: number;
}> {
    if (task?.setPhase) task.setPhase('Resolving dynamic DataContainer references...');
    if (task?.report) task.report('[DataEntityPostProcessor] Starting dynamic table prefix expansion...');

    let edgesCloned = 0;
    let stubsDeleted = 0;

    const session = getMemgraphSession();
    try {
        // ── Pass 1a: Clone READS edges to concrete tables ────────────────────
        // split(stub.name, '{')[0] on "booking_slot_{type}" → "booking_slot_"
        // For trailing-underscore stubs the CASE falls to ELSE → prefix = stub.name
        const readsResult = await session.run(`
            MATCH (f:Function)-[:READS]->(stub:DataContainer)
            WHERE stub.name ENDS WITH '_' OR stub.name CONTAINS '{'
            WITH DISTINCT f, stub,
                 CASE
                     WHEN stub.name CONTAINS '{' THEN split(stub.name, '{')[0]
                     ELSE stub.name
                 END AS prefix
            WHERE size(prefix) > 0
            MATCH (concrete:DataContainer)
            WHERE concrete.name STARTS WITH prefix
              AND concrete.name <> stub.name
              AND NOT concrete.name ENDS WITH '_'
              AND NOT concrete.name CONTAINS '{'
            MERGE (f)-[:READS]->(concrete)
            RETURN count(concrete) AS cloned
        `);
        edgesCloned += Number(readsResult.records[0]?.get('cloned') ?? 0);

        // ── Pass 1b: Clone WRITES edges to concrete tables ───────────────────
        const writesResult = await session.run(`
            MATCH (f:Function)-[:WRITES]->(stub:DataContainer)
            WHERE stub.name ENDS WITH '_' OR stub.name CONTAINS '{'
            WITH DISTINCT f, stub,
                 CASE
                     WHEN stub.name CONTAINS '{' THEN split(stub.name, '{')[0]
                     ELSE stub.name
                 END AS prefix
            WHERE size(prefix) > 0
            MATCH (concrete:DataContainer)
            WHERE concrete.name STARTS WITH prefix
              AND concrete.name <> stub.name
              AND NOT concrete.name ENDS WITH '_'
              AND NOT concrete.name CONTAINS '{'
            MERGE (f)-[:WRITES]->(concrete)
            RETURN count(concrete) AS cloned
        `);
        edgesCloned += Number(writesResult.records[0]?.get('cloned') ?? 0);

        // ── Pass 2: Delete all stubs (with or without concrete matches) ──────
        // Separate query avoids lock contention. Stubs without any concrete match
        // are also deleted here — no phantom nodes persist in the graph.
        const deleteResult = await session.run(`
            MATCH (stub:DataContainer)
            WHERE stub.name ENDS WITH '_' OR stub.name CONTAINS '{'
            WITH DISTINCT stub
            DETACH DELETE stub
            RETURN count(stub) AS deleted
        `);
        stubsDeleted = Number(deleteResult.records[0]?.get('deleted') ?? 0);

        logger.info(
            `[DataEntityPostProcessor] Complete: ${edgesCloned} edge(s) cloned, ${stubsDeleted} stub(s) removed.`
        );

        return { stubsExpanded: stubsDeleted, edgesCloned, stubsDeleted };
    } finally {
        await session.close();
    }
}
