/**
 * Data Lineage Query Service
 *
 * Traces the semantic journey of a specific DataField (e.g. "email")
 * across the microservice ecosystem.  Both the CLI and the MCP server can delegate to this module.
 *
 * Key difference from Blast Analysis:
 *   - Impact = single-hop topological blast radius from an infrastructure resource.
 *   - Lineage = multi-hop semantic traversal following a field NAME across services.
 */

import { getMemgraphSession } from '../neo4j.js';
import { CR_SCHEME } from '../urn.js';
import {
    ResolvedDataFieldSchema,
    LineageAnalysisResultSchema,
    type ResolvedDataField,
    type LineageAnalysisResult,
    type LineageStep,
} from '../types.js';

// ─── Relationship constants ──────────────────────────────────────────────────

/** Relationships linking a Function to a DataStructure */
const SCHEMA_RELS = ['PRODUCES', 'CONSUMES'];

/** Infrastructure relationships from Function to infra nodes */
const INFRA_RELS = [
    'PUBLISHES_TO', 'LISTENS_TO',   // MessageChannel
    'READS', 'WRITES',               // DataContainer
    'CALLS', 'IMPLEMENTS_ENDPOINT',  // APIEndpoint / Function
    'SPAWNS',                         // SystemProcess
];

// ─── DataField Resolution ────────────────────────────────────────────────────

/**
 * Resolve a DataField by name or URN using a 3-tier strategy:
 *   1. Exact URN match (if input starts with 'cr:')
 *   2. Exact name match (case-insensitive)
 *   3. Fuzzy CONTAINS fallback (partial name match)
 *
 * Returns enriched results with owning DataStructure and Service context.
 */
export async function resolveDataField(nameOrUrn: string): Promise<ResolvedDataField[]> {
    const session = getMemgraphSession();
    try {
        // Use WITH DISTINCT to collapse cartesian products from OPTIONAL MATCH
        const baseQuery = (andClause: string, limit?: string) => `
            MATCH (ds:DataStructure)-[r_has:HAS_FIELD]->(df:DataField) WHERE ds.valid_to_commit IS NULL AND df.valid_to_commit IS NULL AND r_has.valid_to_commit IS NULL
            ${andClause}
            OPTIONAL MATCH (f:Function)-[r_io:PRODUCES|CONSUMES]->(ds) WHERE f.valid_to_commit IS NULL AND r_io.valid_to_commit IS NULL
            OPTIONAL MATCH (s:Service)-[r_cont:CONTAINS]->(f) WHERE s.valid_to_commit IS NULL AND r_cont.valid_to_commit IS NULL
            WITH DISTINCT df.id AS urn, df.name AS name,
                 ds.name AS structureName, ds.id AS structureUrn,
                 collect(DISTINCT s.name) AS serviceNames
            RETURN urn, name, structureName, structureUrn,
                   CASE WHEN size(serviceNames) > 0 THEN serviceNames[0] ELSE null END AS serviceName
            ${limit ?? ''}`;

        // Tier 1: Exact URN match
        if (nameOrUrn.startsWith(CR_SCHEME)) {
            const result = await session.run(
                baseQuery('AND df.id = $param'),
                { param: nameOrUrn },
            );
            return parseFieldRecords(result.records);
        }

        // Tier 2: Exact name match (case-insensitive)
        const exactResult = await session.run(
            baseQuery('AND toLower(df.name) = toLower($param)'),
            { param: nameOrUrn },
        );

        if (exactResult.records.length > 0) {
            return parseFieldRecords(exactResult.records);
        }

        // Tier 3: Fuzzy CONTAINS fallback
        const fuzzyResult = await session.run(
            baseQuery('AND toLower(df.name) CONTAINS toLower($param)', 'LIMIT 20'),
            { param: nameOrUrn },
        );

        return parseFieldRecords(fuzzyResult.records);
    } finally {
        await session.close();
    }
}

/**
 * Parse resolution result records into ResolvedDataField objects.
 * Deduplication is handled at the Cypher level via WITH DISTINCT.
 */
function parseFieldRecords(records: any[]): ResolvedDataField[] {
    return records.map(r =>
        ResolvedDataFieldSchema.parse({
            urn: r.get('urn'),
            name: r.get('name'),
            structureName: r.get('structureName'),
            structureUrn: r.get('structureUrn'),
            serviceName: r.get('serviceName'),
        })
    );
}

// ─── Lineage Traversal ──────────────────────────────────────────────────────

/**
 * Analyze the semantic lineage of a resolved DataField.
 *
 * Algorithm (BFS with semantic gate):
 *   1. Start at the target DataField → walk to its parent DataStructure
 *   2. Find Functions that PRODUCES/CONSUMES this DataStructure
 *   3. For each Function, find its owning Service and connected infrastructure
 *   4. From each infrastructure node, find other Functions in DIFFERENT services
 *   5. SEMANTIC GATE: check if the next Function's DataStructures contain
 *      a DataField with the SAME name as our target
 *   6. If yes → record the hop and continue BFS from the new DataStructure
 *   7. If no → dead end, stop this branch
 */
export async function analyzeLineage(fieldUrn: string): Promise<LineageAnalysisResult> {
    const session = getMemgraphSession();
    try {
        // 1. Resolve target metadata (Phase 2 seed validity: df.valid_to_commit IS NULL
        // prevents BFS from starting at a tombstoned DataField).
        const targetResult = await session.run(
            `MATCH (ds:DataStructure)-[r_has:HAS_FIELD]->(df:DataField {id: $fieldUrn})
             WHERE ds.valid_to_commit IS NULL
               AND r_has.valid_to_commit IS NULL
               AND df.valid_to_commit IS NULL
             RETURN df.name AS fieldName, ds.name AS structureName, ds.id AS structureUrn`,
            { fieldUrn },
        );

        if (targetResult.records.length === 0) {
            throw new Error(`DataField with URN ${fieldUrn} not found.`);
        }

        const fieldName = targetResult.records[0].get('fieldName') as string;
        const startStructureName = targetResult.records[0].get('structureName') as string;
        const startStructureUrn = targetResult.records[0].get('structureUrn') as string;

        // 2. BFS traversal with semantic gate
        const journey: LineageStep[] = [];
        const visitedFunctions = new Set<string>();
        const visitedStructures = new Set<string>();

        // Seed: DataStructures containing our field with the matching name
        const structureQueue: string[] = [startStructureUrn];
        visitedStructures.add(startStructureUrn);

        while (structureQueue.length > 0) {
            const currentStructureUrn = structureQueue.shift()!;

            // Find all Functions that PRODUCES or CONSUMES this DataStructure
            // (Phase 2 validity additive: ds.valid_to_commit IS NULL — even though
            // we seeded from a live structure, subsequent BFS iterations may
            // resolve URNs that were tombstoned between the gate match and now).
            const functionsResult = await session.run(
                `MATCH (f:Function)-[rel:PRODUCES|CONSUMES]->(ds:DataStructure {id: $dsUrn})
                 WHERE f.valid_to_commit IS NULL
                   AND rel.valid_to_commit IS NULL
                   AND ds.valid_to_commit IS NULL
                 OPTIONAL MATCH (s:Service)-[r_cont:CONTAINS]->(f) WHERE s.valid_to_commit IS NULL AND r_cont.valid_to_commit IS NULL
                 OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                 OPTIONAL MATCH (s)-[r_stored:STORED_IN]->(repo:Repository) WHERE r_stored.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL
                 RETURN f.id AS functionId, f.name AS functionName,
                        type(rel) AS action, s.name AS serviceName,
                        s.id AS serviceUrn, t.name AS teamOwner,
                        ds.name AS structureName,
                        repo.name AS repoName, repo.url AS repoUrl`,
                { dsUrn: currentStructureUrn },
            );

            for (const fRec of functionsResult.records) {
                const functionId = fRec.get('functionId') as string;
                if (visitedFunctions.has(functionId)) continue;
                visitedFunctions.add(functionId);

                const functionName = fRec.get('functionName') as string;
                const serviceName = fRec.get('serviceName') as string | null;
                const serviceUrn = fRec.get('serviceUrn') as string | null;
                const teamOwner = fRec.get('teamOwner') as string | null;
                const action = fRec.get('action') as string;
                const structureName = fRec.get('structureName') as string;
                const repoName = fRec.get('repoName') as string | null;
                const repoUrl = fRec.get('repoUrl') as string | null;

                // Find infrastructure connected to this Function (BFS validity additive: Phase 2).
                // Filter tombstoned edges and tombstoned target nodes; the gate alone is not
                // enough since this walk seeds the journey before the gate runs.
                const infraResult = await session.run(
                    `MATCH (f:Function {id: $fId})-[rel]->(infra)
                     WHERE type(rel) IN $infraRels
                       AND rel.valid_to_commit IS NULL
                       AND infra.valid_to_commit IS NULL
                       AND (infra:DataContainer OR infra:MessageChannel OR infra:APIEndpoint
                            OR infra:SystemProcess OR infra:Function)
                     RETURN type(rel) AS relType, infra.name AS infraName,
                            infra.id AS infraId,
                            CASE
                              WHEN infra:DataContainer THEN 'DataContainer'
                              WHEN infra:MessageChannel THEN 'MessageChannel'
                              WHEN infra:APIEndpoint THEN 'APIEndpoint'
                              WHEN infra:SystemProcess THEN 'SystemProcess'
                              WHEN infra:Function THEN 'Function'
                            END AS infraType`,
                    { fId: functionId, infraRels: INFRA_RELS },
                );

                // Select the bridge resource — the infra node connecting to the next service
                // Priority: MessageChannel/APIEndpoint > DataContainer writes > first available
                let bridgeResource: { name: string; type: string } | null = null;
                const infraNodes: Array<{ id: string; type: string; name: string; relType: string }> = [];

                if (infraResult.records.length > 0) {
                    for (const iRec of infraResult.records) {
                        const iName = iRec.get('infraName') as string;
                        const iType = iRec.get('infraType') as string;
                        const iId = iRec.get('infraId') as string;
                        const iRel = iRec.get('relType') as string;
                        infraNodes.push({ id: iId, type: iType, name: iName, relType: iRel });
                    }

                    // 1st priority: MessageChannel or APIEndpoint the function publishes/calls to
                    const crossServiceBridge = infraNodes.find(n =>
                        (n.type === 'MessageChannel' || n.type === 'APIEndpoint') &&
                        (n.relType === 'PUBLISHES_TO' || n.relType === 'CALLS' || n.relType === 'LISTENS_TO')
                    );
                    // 2nd priority: DataContainer the function writes to
                    const writeBridge = infraNodes.find(n =>
                        n.type === 'DataContainer' && n.relType === 'WRITES'
                    );
                    // 3rd priority: any MessageChannel or APIEndpoint
                    const anyBridge = infraNodes.find(n =>
                        n.type === 'MessageChannel' || n.type === 'APIEndpoint'
                    );

                    const selected = crossServiceBridge ?? writeBridge ?? anyBridge ?? infraNodes[0];
                    if (selected) {
                        bridgeResource = { name: selected.name, type: selected.type };
                    }
                }

                // Record this step in the journey
                journey.push({
                    serviceName: serviceName ?? 'unknown',
                    serviceUrn: serviceUrn ?? null,
                    teamOwner: teamOwner ?? null,
                    functionId,
                    functionName,
                    action,
                    bridgeResource,
                    structureName,
                    repository: repoName ? { name: repoName, url: repoUrl ?? null } : null,
                });

                // Now follow the semantic gate: from each infra node,
                // find Functions in OTHER services that interact with it,
                // then check if they PRODUCE/CONSUME a DataStructure with
                // a DataField of the same name
                for (const infra of infraNodes) {
                    const nextFunctionsResult = await session.run(
                        `MATCH (f2:Function)-[rel2]->(infra {id: $infraId})
                         WHERE type(rel2) IN $infraRels
                           AND rel2.valid_to_commit IS NULL
                           AND f2.valid_to_commit IS NULL
                           AND f2.id <> $currentFId
                           AND NOT f2.id IN $visited
                         OPTIONAL MATCH (s2:Service)-[:CONTAINS]->(f2)
                         WHERE s2.name <> $currentService OR $currentService IS NULL
                         RETURN f2.id AS f2Id, f2.name AS f2Name,
                                type(rel2) AS f2Action, s2.name AS f2Service`,
                        {
                            infraId: infra.id,
                            infraRels: INFRA_RELS,
                            currentFId: functionId,
                            visited: Array.from(visitedFunctions),
                            currentService: serviceName,
                        },
                    );

                    for (const nRec of nextFunctionsResult.records) {
                        const nextFId = nRec.get('f2Id') as string;
                        if (visitedFunctions.has(nextFId)) continue;

                        // SEMANTIC GATE (Phase 2): cap-aware, per-(Function, DataStructure).
                        //
                        // Path 1: function has a field-edge (PRODUCES_FIELD / CONSUMES_FIELD)
                        //         to a DataField named $fieldName, attached to a DS it
                        //         produces/consumes. Direct, precise.
                        //
                        // Path 2 (fallback): function has NO field-edge to this DS, OR the
                        //         PRODUCES/CONSUMES marker `fieldsCapped=true` indicates the
                        //         field-edge slice is incomplete (target field may be beyond
                        //         the cap). Walk HAS_FIELD on the DS itself.
                        //
                        // All temporal predicates filter `valid_to_commit IS NULL` (Phase 2 fix).
                        // Per-(Function, DS) scope prevents false negatives in multi-payload
                        // scenarios: if f produces ds1 and ds2, missing field-edge on ds1
                        // should NOT block fallback on ds2.
                        const semanticCheck = await session.run(
                            `MATCH (f2:Function {id: $nextFId})-[pc:PRODUCES|CONSUMES]->(ds:DataStructure)
                             WHERE pc.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL

                             OPTIONAL MATCH (f2)-[fe:PRODUCES_FIELD|CONSUMES_FIELD]->(df1:DataField)<-[hf1:HAS_FIELD]-(ds)
                               WHERE fe.valid_to_commit IS NULL
                                 AND hf1.valid_to_commit IS NULL
                                 AND df1.valid_to_commit IS NULL
                                 AND (toLower(df1.name) = toLower($fieldName) OR df1.name ENDS WITH ('.' + $fieldName))

                             OPTIONAL MATCH (ds)-[hf2:HAS_FIELD]->(df2:DataField)
                               WHERE df1 IS NULL
                                 AND hf2.valid_to_commit IS NULL
                                 AND df2.valid_to_commit IS NULL
                                 AND (toLower(df2.name) = toLower($fieldName) OR df2.name ENDS WITH ('.' + $fieldName))

                             OPTIONAL MATCH (f2)-[feCheck:PRODUCES_FIELD|CONSUMES_FIELD]->(:DataField)<-[hfCheck:HAS_FIELD]-(ds)
                               WHERE feCheck.valid_to_commit IS NULL AND hfCheck.valid_to_commit IS NULL

                             WITH ds, df1, df2, pc, count(feCheck) AS hasFieldEdgesForDs
                             WHERE df1 IS NOT NULL
                                OR (df2 IS NOT NULL AND (pc.fieldsCapped = true OR hasFieldEdgesForDs = 0))

                             RETURN ds.id AS dsUrn, ds.name AS dsName,
                                    coalesce(df1.id, df2.id) AS dfUrn
                             LIMIT 1`,
                            { nextFId, fieldName },
                        );

                        if (semanticCheck.records.length > 0) {
                            const nextDsUrn = semanticCheck.records[0].get('dsUrn') as string;
                            if (!visitedStructures.has(nextDsUrn)) {
                                visitedStructures.add(nextDsUrn);
                                structureQueue.push(nextDsUrn);
                            }
                        }
                        // If semantic check fails, this branch is a dead end — do nothing
                    }
                }
            }
        }

        // ── Batched contractFields (Phase 2/3): one round-trip for the whole journey ──
        // Avoids N+1 queries per step. Filters valid_to_commit IS NULL on both
        // PRODUCES_FIELD/CONSUMES_FIELD edges AND target DataField nodes.
        if (journey.length > 0) {
            const fieldAccessResult = await session.run(
                `UNWIND $functionIds AS fId
                 MATCH (f:Function {id: fId})-[r:PRODUCES_FIELD|CONSUMES_FIELD]->(df:DataField)
                 WHERE r.valid_to_commit IS NULL AND df.valid_to_commit IS NULL
                 RETURN fId AS functionId, df.name AS fieldName, type(r) AS participation`,
                { functionIds: journey.map(s => s.functionId) },
            );
            const byFn = new Map<string, Array<{ fieldName: string; participation: 'PRODUCES_FIELD' | 'CONSUMES_FIELD' }>>();
            for (const rec of fieldAccessResult.records) {
                const fId = rec.get('functionId') as string;
                if (!byFn.has(fId)) byFn.set(fId, []);
                byFn.get(fId)!.push({
                    fieldName: rec.get('fieldName') as string,
                    participation: rec.get('participation') as 'PRODUCES_FIELD' | 'CONSUMES_FIELD',
                });
            }
            for (const step of journey) {
                const access = byFn.get(step.functionId);
                if (access && access.length > 0) step.contractFields = access;
            }
        }

        // 3. Build summary
        const uniqueServices = new Set(journey.map(j => j.serviceName).filter(s => s !== 'unknown'));

        return LineageAnalysisResultSchema.parse({
            targetField: { urn: fieldUrn, name: fieldName, structure: startStructureName },
            journey,
            summary: {
                servicesTraversed: uniqueServices.size,
                totalHops: journey.length,
                requiresDeepScan: journey.length === 0,
            },
        });
    } finally {
        await session.close();
    }
}
