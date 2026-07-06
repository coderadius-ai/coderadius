/**
 * Data Contract Query Service
 *
 * Single source of truth for data contract / schema retrieval queries.
 * Both the CLI and the MCP server delegate to this module.
 */

import { getMemgraphSession } from '../neo4j.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SchemaField {
    source: 'schema';
    name: string;
    type: string;
    required: boolean;
}

export interface EndpointContractField {
    name: string;
    type: string;
    required: boolean;
}

export interface EndpointContract {
    source: 'endpoint';
    path: string;
    method: string;
    summary: string | null;
    apiTitle: string | null;
    fields: EndpointContractField[];
}

export interface DataContractResult {
    /** Set when the query resolves to a single DataStructure (URN or name+scope). */
    structureUrn?: string;
    /** Scope key for emergent message_payload (e.g. `acme:orders`); null otherwise. */
    scopeKey?: string | null;
    schemaFields: SchemaField[];
    endpointContracts: EndpointContract[];
}

/**
 * Input for `getDataContract`. After Phase 1A scoping, the same `schemaName`
 * can map to multiple `DataStructure` nodes (different `scopeKey`s). Callers
 * SHOULD pass `structureUrn` for precision, OR `schemaName` + `scopeKey` for
 * scoped lookup. `schemaName` alone is the legacy ambiguous path: it returns
 * a single best-effort result with `structureUrn`/`scopeKey` set on the
 * returned object so the caller can disambiguate downstream.
 */
export interface GetDataContractInput {
    structureUrn?: string;
    schemaName?: string;
    scopeKey?: string;
}

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Retrieve the data contract (field names, types, and constraints) for a
 * schema, data table, or API endpoint. Accepts an input object so URN-aware
 * callers can disambiguate scoped DataStructures (Phase 3 fix for the v1A
 * URN-scoping ambiguity).
 *
 * Backward-compat: a bare string is wrapped as `{ schemaName: input }`.
 */
export async function getDataContract(
    input: GetDataContractInput | string,
): Promise<DataContractResult> {
    const opts: GetDataContractInput = typeof input === 'string' ? { schemaName: input } : input;
    if (opts.structureUrn == null && opts.schemaName == null) {
        throw new Error('getDataContract requires structureUrn or schemaName');
    }

    const session = getMemgraphSession();
    try {
        let resolvedUrn: string | null = null;
        let resolvedScopeKey: string | null = null;
        let resolvedName: string | undefined = opts.schemaName;

        if (opts.structureUrn) {
            const meta = await session.run(
                `MATCH (ds:DataStructure {id: $urn})
                 WHERE ds.valid_to_commit IS NULL
                 RETURN ds.id AS id, ds.name AS name, ds.scopeKey AS scopeKey
                 LIMIT 1`,
                { urn: opts.structureUrn },
            );
            if (meta.records.length === 0) {
                return { schemaFields: [], endpointContracts: [] };
            }
            resolvedUrn = meta.records[0].get('id') as string;
            resolvedName = meta.records[0].get('name') as string;
            resolvedScopeKey = meta.records[0].get('scopeKey') as string | null;
        } else if (opts.schemaName && opts.scopeKey) {
            const meta = await session.run(
                `MATCH (ds:DataStructure {name: $name, scopeKey: $scopeKey})
                 WHERE ds.valid_to_commit IS NULL
                 RETURN ds.id AS id, ds.scopeKey AS scopeKey
                 LIMIT 1`,
                { name: opts.schemaName, scopeKey: opts.scopeKey },
            );
            if (meta.records.length > 0) {
                resolvedUrn = meta.records[0].get('id') as string;
                resolvedScopeKey = meta.records[0].get('scopeKey') as string | null;
            }
        } else if (opts.schemaName) {
            // Legacy ambiguous lookup: pick the most recently-touched live DS
            // matching this name, expose the resolved URN/scopeKey so the
            // caller can request precision.
            const meta = await session.run(
                `MATCH (ds:DataStructure {name: $name})
                 WHERE ds.valid_to_commit IS NULL
                 RETURN ds.id AS id, ds.scopeKey AS scopeKey
                 ORDER BY ds.createdAt DESC
                 LIMIT 1`,
                { name: opts.schemaName },
            );
            if (meta.records.length > 0) {
                resolvedUrn = meta.records[0].get('id') as string;
                resolvedScopeKey = meta.records[0].get('scopeKey') as string | null;
            }
        }

        const schemaResult = resolvedUrn
            ? await session.run(
                `MATCH (ds:DataStructure {id: $urn})-[hf:HAS_FIELD]->(df:DataField)
                 WHERE ds.valid_to_commit IS NULL
                   AND hf.valid_to_commit IS NULL
                   AND df.valid_to_commit IS NULL
                 RETURN df.name AS name, df.type AS type, df.required AS required`,
                { urn: resolvedUrn },
            )
            : await session.run(
                `MATCH (ds {name: $schemaName})-[hf:HAS_FIELD]->(df:DataField)
                 WHERE (ds:DataStructure OR ds:DataContainer)
                 RETURN df.name AS name, df.type AS type, df.required AS required`,
                { schemaName: resolvedName ?? '' },
            );

        const endpointResult = await session.run(
            `MATCH (ep:APIEndpoint)
             WHERE ep.path = $schemaName OR ep.name = $schemaName
             OPTIONAL MATCH (api:APIInterface)-[:HAS_ENDPOINT]->(ep)
             OPTIONAL MATCH (ep)-[:HAS_FIELD]->(df:DataField)
             RETURN 'endpoint' AS source, ep.path AS endpointPath, ep.method AS method,
                    ep.summary AS summary, api.title AS apiTitle,
                    collect(CASE WHEN df IS NOT NULL
                            THEN {name: df.name, type: df.type, required: df.required}
                            ELSE null END) AS fields
             LIMIT 5`,
            { schemaName: resolvedName ?? '' },
        );

        const schemaFields: SchemaField[] = schemaResult.records.map((r: any) => ({
            source: 'schema' as const,
            name: r.get('name'),
            type: r.get('type'),
            required: r.get('required'),
        }));

        const endpointContracts: EndpointContract[] = endpointResult.records
            .filter((r: any) => r.get('endpointPath') != null)
            .map((r: any) => ({
                source: 'endpoint' as const,
                path: r.get('endpointPath'),
                method: r.get('method'),
                summary: r.get('summary'),
                apiTitle: r.get('apiTitle'),
                fields: (r.get('fields') || []).filter((f: any) => f != null),
            }));

        return {
            structureUrn: resolvedUrn ?? undefined,
            scopeKey: resolvedScopeKey,
            schemaFields,
            endpointContracts,
        };
    } finally {
        await session.close();
    }
}
