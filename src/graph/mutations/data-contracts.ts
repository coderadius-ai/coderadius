/**
 * Data Contracts — Emergent Schemas, 3-Level Ontology, Data Relationships
 *
 * DataStructure, DataField, DataContainer, Datastore, MessageChannel, SystemProcess.
 */
import { run, groundingParams, groundingWriteClause } from './_run.js';
import { areUrnsTransparent } from '../../utils/urn-transparency.js';
import { normalizeHost } from '../../ingestion/processors/physical-fingerprint.js';
import { buildUrn, assertScopeSegment } from '../urn.js';
import type { GroundingFields } from '../grounding.js';
import {
    ALL_KIND_FAMILIES,
    ALL_KNOWN_TECHS,
    familyForTechnology,
    type KindFamily,
} from '../../ingestion/processors/db-scope-resolver.js';
import { getPluginForExtension } from '../../ingestion/core/languages/registry.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Emergent Schema (Data Contracts)
// ═══════════════════════════════════════════════════════════════════════════════

export interface MergeEmergentSchemaOpts {
    /** Qualified repo name (e.g. `acme/orders`). Required for SourceFile URN cross-repo safety. */
    qualifiedRepoName: string;
    /** Relative path inside the repo (becomes sf.path). */
    filepath: string;
    /** Basename for sf.name; defaults to the last path segment. */
    fileName?: string;
    schemaName: string;
    schemaType: 'database_table' | 'message_payload';
    fields: Array<{
        name: string;
        type: string;
        required?: boolean;
        logicalType?: string;
        enumSymbols?: string[];
        isArray?: boolean;
        isMap?: boolean;
        doc?: string;
        defaultValue?: string;
    }>;
    hasDynamicKeys?: boolean;
    commitHash: string;
    namespace?: string;
    doc?: string;
    schemaFormat?: string;
    /**
     * Bounded-context scope for emergent message_payload (LLM-inferred, no schemaFormat).
     * Form `{repoSeg}:{serviceSeg}` (e.g. `acme:orders`). Ignored for deterministic
     * schemas (schemaFormat set) and for database_table.
     */
    scopeKey?: string;
    grounding?: GroundingFields;
}

export interface MergeEmergentSchemaResult {
    /** Final DataStructure URN, scoped if shouldScope. */
    schemaUrn: string;
    /** DataField URNs in the same order as opts.fields. */
    fieldUrns: string[];
}

export async function mergeEmergentSchema(opts: MergeEmergentSchemaOpts): Promise<MergeEmergentSchemaResult> {
    const {
        qualifiedRepoName,
        filepath,
        fileName,
        schemaName,
        schemaType,
        fields,
        hasDynamicKeys,
        commitHash,
        namespace,
        doc,
        schemaFormat,
        scopeKey,
        grounding,
    } = opts;

    // Normalise schema name for database_table (SQL identifiers are case-insensitive).
    // Message payload names are code-derived (class/struct names) → preserve case.
    const normalisedName = schemaType === 'database_table' ? schemaName.toLowerCase() : schemaName;

    // Scoping rule: only emergent message_payload (LLM-inferred, no schemaFormat).
    // Deterministic message_payload (Avro/Protobuf/JSON Schema) keeps global URN
    // so producer/consumer cross-repo convergence is preserved.
    // database_table keeps global URN; scoping lives at the DataContainer level.
    const shouldScope = schemaType === 'message_payload' && schemaFormat == null && scopeKey != null;
    const scopeSegments = shouldScope
        ? scopeKey!.split(':').map(s => assertScopeSegment(s, 'mergeEmergentSchema.scopeKey'))
        : [];
    const schemaUrn = buildUrn('schema', schemaType, ...scopeSegments, normalisedName);
    const fieldUrns = fields.map(f =>
        buildUrn('schema', schemaType, ...scopeSegments, normalisedName, 'field', f.name),
    );
    const sourceFileUrn = buildUrn('sourcefile', qualifiedRepoName, filepath);
    const resolvedFileName = fileName ?? filepath.split('/').pop() ?? filepath;

    // Merge DataStructure + URN-keyed SourceFile + DEFINES_SCHEMA edge.
    // ON CREATE/ON MATCH set scopeKey via CASE so a flip from shouldScope=true
    // to shouldScope=false on re-merge cleans the stale property (no coalesce).
    await run(
        `MERGE (d:DataStructure {id: $schemaUrn})
     ON CREATE SET d.valid_from_commit = $commitHash, d.valid_to_commit = null, d.name = $schemaName, d.type = $schemaType, d.hasDynamicKeys = $hasDynamicKeys, d.namespace = $namespace, d.doc = $doc, d.schemaFormat = $schemaFormat,
                   d.scopeKey = CASE WHEN $shouldScope THEN $scopeKeyValue ELSE null END,
                   d.createdAt = timestamp()
     ON MATCH SET d.valid_from_commit = coalesce(d.valid_from_commit, $commitHash), d.valid_to_commit = null, d.type = $schemaType, d.hasDynamicKeys = coalesce($hasDynamicKeys, d.hasDynamicKeys, false), d.namespace = coalesce($namespace, d.namespace), d.doc = coalesce($doc, d.doc), d.schemaFormat = coalesce($schemaFormat, d.schemaFormat),
                  d.scopeKey = CASE WHEN $shouldScope THEN $scopeKeyValue ELSE null END
     ${groundingWriteClause('d')}
     WITH d
     MERGE (sf:SourceFile {id: $sourceFileUrn})
     ON CREATE SET sf.path = $filepath, sf.name = $fileName, sf.valid_from_commit = $commitHash, sf.valid_to_commit = null
     ON MATCH SET sf.path = coalesce(sf.path, $filepath), sf.name = coalesce(sf.name, $fileName), sf.valid_to_commit = null
     MERGE (sf)-[rel:DEFINES_SCHEMA]->(d)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
     ON MATCH SET rel.valid_to_commit = null`,
        {
            schemaUrn, schemaName, schemaType,
            sourceFileUrn, filepath, fileName: resolvedFileName,
            hasDynamicKeys: hasDynamicKeys ?? false, commitHash,
            namespace: namespace ?? null, doc: doc ?? null, schemaFormat: schemaFormat ?? null,
            shouldScope, scopeKeyValue: shouldScope ? scopeKey : null,
            ...groundingParams(grounding, commitHash),
        },
    );

    // Merge DataField nodes and link via HAS_FIELD (with explicit temporal props).
    // DataField inherits the parent DataStructure's grounding (same extraction context).
    // HAS_FIELD temporal props are set explicitly (was missing): the lineage semantic
    // gate filters `hf.valid_to_commit IS NULL`, defense-in-depth against future sweeps.
    if (fields.length > 0) {
        const fieldParams = fields.map((f, idx) => ({
            fieldUrn: fieldUrns[idx],
            fieldName: f.name,
            fieldType: f.type,
            fieldRequired: f.required ?? true,
            fieldLogicalType: f.logicalType ?? null,
            fieldEnumSymbols: f.enumSymbols ?? null,
            fieldIsArray: f.isArray ?? null,
            fieldIsMap: f.isMap ?? null,
            fieldDoc: f.doc ?? null,
            fieldDefaultValue: f.defaultValue ?? null,
        }));

        // Known limitation: coalesce() retains stale metadata when a field changes type
        // (e.g. enum→string: old enumSymbols survives because new value is null).
        // Schema versioning would allow a direct-overwrite SET instead of coalesce.
        await run(
        `UNWIND $fields AS field
         MERGE (f:DataField {id: field.fieldUrn})
         ON CREATE SET f.valid_from_commit = $commitHash, f.valid_to_commit = null, f.name = field.fieldName, f.type = field.fieldType, f.required = field.fieldRequired, f.logicalType = field.fieldLogicalType, f.enumSymbols = field.fieldEnumSymbols, f.isArray = field.fieldIsArray, f.isMap = field.fieldIsMap, f.doc = field.fieldDoc, f.defaultValue = field.fieldDefaultValue, f.createdAt = timestamp(),
                       f.source = $ground_source, f.quality = $ground_quality, f.evidence_extractors = $ground_extractors,
                       f.evidence_llmCalls = $ground_llmCalls, f.evidence_fallbacksApplied = $ground_fallbacksApplied,
                       f.evidence_mergedFrom = $ground_mergedFrom, f.needsReview = $ground_needsReview,
                       f.lastSeenCommit = $ground_lastSeenCommit
         ON MATCH SET f.valid_from_commit = coalesce(f.valid_from_commit, $commitHash), f.valid_to_commit = null, f.name = field.fieldName, f.type = field.fieldType, f.required = field.fieldRequired, f.logicalType = coalesce(field.fieldLogicalType, f.logicalType), f.enumSymbols = coalesce(field.fieldEnumSymbols, f.enumSymbols), f.isArray = coalesce(field.fieldIsArray, f.isArray), f.isMap = coalesce(field.fieldIsMap, f.isMap), f.doc = coalesce(field.fieldDoc, f.doc), f.defaultValue = coalesce(field.fieldDefaultValue, f.defaultValue)
         WITH f, field
         MATCH (d:DataStructure {id: $schemaUrn})
         MERGE (d)-[rel:HAS_FIELD]->(f)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null
         ON MATCH SET rel.valid_to_commit = null`,
        { fields: fieldParams, schemaUrn , commitHash, ...groundingParams(grounding, commitHash) },
    );
    }

    return { schemaUrn, fieldUrns };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3-Level Ontology: Datastore, DataContainer, MessageChannel, SystemProcess
// ═══════════════════════════════════════════════════════════════════════════════


/**
 * Build the URN for a `:DatabaseEndpoint` — physical identity scoped by
 * environment.
 *
 * URN: `cr:dbendpoint:{endpointKey}:{environment}` where
 * `endpointKey = sha256_trunc8(host:port/dbName)` (see `computeEndpointKey`).
 *
 * The endpointKey is the stable physical fingerprint (cross-repo convergence
 * within one environment); the explicit `environment` segment keeps the same
 * physical endpoint observed in two environments as two distinct nodes,
 * preventing dev↔prod collision.
 */
export function buildDatabaseEndpointUrn(endpointKey: string, environment: string): string {
    return buildUrn('dbendpoint', endpointKey, environment);
}




export async function deleteOrphanDatastores(): Promise<void> {
    await run(
        `MATCH (ds:Datastore)
         WHERE ds.valid_to_commit IS NULL
         OPTIONAL MATCH (f:Function)-[r1:CONNECTS_TO]->(ds)
           WHERE r1.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
         OPTIONAL MATCH (dt:DataContainer)-[r2:STORED_IN]->(ds)
           WHERE r2.valid_to_commit IS NULL AND dt.valid_to_commit IS NULL
         WITH ds, count(DISTINCT f) + count(DISTINCT dt) AS refs
         WHERE refs = 0
         DETACH DELETE ds`,
        {},
    );
}

export async function deleteOrphanDatabaseEndpoints(): Promise<void> {
    await run(
        `MATCH (ep:DatabaseEndpoint)
         WHERE ep.valid_to_commit IS NULL
         OPTIONAL MATCH (ds:Datastore)-[r:SERVED_BY]->(ep)
           WHERE r.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL
         WITH ep, count(DISTINCT ds) AS refs
         WHERE refs = 0
         DETACH DELETE ep`,
        {},
    );
}

export async function deleteOrphanMessageChannels(commitHash: string): Promise<void> {
    await run(
        `MATCH (ch:MessageChannel)
         WHERE ch.valid_to_commit IS NULL
         OPTIONAL MATCH path = (:Function)-[:PUBLISHES_TO|LISTENS_TO]->(:MessageChannel)-[:ROUTES_TO*0..]->(ch)
           WHERE all(rel IN relationships(path) WHERE rel.valid_to_commit IS NULL)
           AND all(node IN nodes(path) WHERE node.valid_to_commit IS NULL)
         OPTIONAL MATCH (stf:StructuralFile)-[:DEFINES]->(ch)
         WITH ch, count(path) AS activePaths, count(stf) AS declaredBy
         WHERE activePaths = 0 AND declaredBy = 0
         SET ch.valid_to_commit = $commitHash`,
        { commitHash },
    );
}

/**
 * Remove DataContainer nodes that have no active incoming edges.
 *
 * A DataContainer is orphaned when:
 *   - No active Function READS, WRITES, or MAPS_TO it
 *   - No active outgoing STORED_IN edge to a Datastore
 *   - No active structural DEFINES edge exists
 *
 * This catches "zombie" nodes left behind after entity renames,
 * where the structural layer swept the old node but the code
 * pipeline's READS/WRITES/MAPS_TO edges were cached.
 *
 * NOTE: ORM static extractors (Doctrine `@ORM\Table`, Laravel Eloquent
 * `$table`, TypeORM `@Entity`) emit `MAPS_TO` exclusively — at first ingest
 * a freshly-discovered entity has only this edge plus an outgoing STORED_IN
 * to its Datastore. Both must count as live references; otherwise
 * `deleteOrphanDataContainers` reaps the entity right after merge.
 *
 * The Datastore edge is on the OUTGOING side of the DataContainer
 * (DataContainer-[:STORED_IN]->Datastore, see linkDataContainerStoredIn).
 */
export async function deleteOrphanDataContainers(): Promise<void> {
    await run(
        `MATCH (dt:DataContainer)
         WHERE dt.valid_to_commit IS NULL
         OPTIONAL MATCH (f:Function)-[rw:READS|WRITES|MAPS_TO]->(dt)
           WHERE rw.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
         OPTIONAL MATCH (sf:SourceFile)-[def:DEFINES]->(dt)
           WHERE def.valid_to_commit IS NULL AND sf.valid_to_commit IS NULL
         OPTIONAL MATCH (stf:StructuralFile)-[:DEFINES]->(dt)
         WITH dt,
              count(DISTINCT f) + count(DISTINCT sf) + count(DISTINCT stf) AS refs
         WHERE refs = 0
         DETACH DELETE dt`,
        {},
    );
}

/**
 * Tombstone stale edges left behind when an ORM entity's table name changes
 * (e.g. `@ORM\Table(name="old")` → `@ORM\Table(name="new")`).
 *
 * The `__class_metadata` function gets re-processed and its MAPS_TO edge is
 * tombstoned → revived to the new DataContainer. But other functions whose
 * files didn't change are Merkle-cached: their READS/WRITES edges still
 * point to the old DataContainer, and STORED_IN edges from the old DC to
 * its Datastore are never tombstoned by `tombstoneFunctionRelationships`
 * (which only handles Function → * edges).
 *
 * Detection: find `__class_metadata` functions that have a live MAPS_TO to
 * one DataContainer AND a tombstoned MAPS_TO to a different DataContainer.
 * The old DC's live edges are stale and must be retired.
 */
export async function reconcileRenamedEntityTables(commitHash: string): Promise<number> {
    const staleResult = await run(
        `MATCH (meta:Function)-[liveMap:MAPS_TO]->(newDC:DataContainer)
         WHERE meta.id CONTAINS '::__class_metadata'
           AND liveMap.valid_to_commit IS NULL
           AND meta.valid_to_commit IS NULL
         WITH meta, newDC
         MATCH (meta)-[oldMap:MAPS_TO]->(oldDC:DataContainer)
         WHERE oldMap.valid_to_commit IS NOT NULL
           AND oldDC.id <> newDC.id
           AND oldDC.valid_to_commit IS NULL
         RETURN collect(DISTINCT oldDC.id) AS staleDCIds`,
        {},
    );
    const staleDCIds: string[] = staleResult.records?.[0]?.get('staleDCIds') ?? [];
    if (staleDCIds.length === 0) return 0;

    const inbound = await run(
        `UNWIND $staleDCIds AS dcId
         MATCH ()-[edge]->(dc:DataContainer {id: dcId})
         WHERE edge.valid_to_commit IS NULL
         SET edge.valid_to_commit = $commitHash
         RETURN count(edge) AS cnt`,
        { staleDCIds, commitHash },
    );
    const outbound = await run(
        `UNWIND $staleDCIds AS dcId
         MATCH (dc:DataContainer {id: dcId})-[edge]->()
         WHERE edge.valid_to_commit IS NULL
         SET edge.valid_to_commit = $commitHash
         RETURN count(edge) AS cnt`,
        { staleDCIds, commitHash },
    );
    return (inbound.records?.[0]?.get('cnt')?.toNumber?.() ?? inbound.records?.[0]?.get('cnt') ?? 0)
        + (outbound.records?.[0]?.get('cnt')?.toNumber?.() ?? outbound.records?.[0]?.get('cnt') ?? 0);
}

/**
 * Hard-delete DataStructure with zero active usage references, then cascade
 * to delete orphaned DataField nodes whose parent DataStructure was removed.
 *
 * Liveness model (Phase 1C):
 *   - PRODUCES/CONSUMES (Function), HAS_SCHEMA (MessageChannel OR DataContainer),
 *     CARRIED_BY (DS->MessageChannel), HAS_REQUEST_SCHEMA/HAS_RESPONSE_SCHEMA
 *     (APIEndpoint) ALWAYS count as live references.
 *   - DEFINES_SCHEMA (SourceFile) counts as live reference ONLY when the schema
 *     is authoritative:
 *       * ds.type = 'database_table' (SQL DDL is the source of truth), OR
 *       * ds.source IN ['ast','declared','infra','composite'] (deterministic
 *         AST extraction, customer-declared, infra-extracted, or welded), OR
 *       * ds.schemaFormat IS NOT NULL (Avro/Protobuf/JSON Schema file).
 *     For LLM-emergent schemas (source='llm', schemaFormat null, message_payload)
 *     DEFINES_SCHEMA is provenance, not liveness — keeping a 551-field LLM-
 *     inferred orphan alive because a SourceFile once mentioned it is the
 *     bug we're fixing.
 *
 * All edge/node checks filter `valid_to_commit IS NULL`.
 * Memgraph-safe: UNWIND over collected nodes (FOREACH DETACH DELETE is legacy).
 *
 * Returns { deletedStructures, deletedFields } for telemetry.
 */
export async function deleteOrphanDataStructures(): Promise<{
    deletedStructures: number;
    deletedFields: number;
}> {
    const sweep = await run(
        `MATCH (ds:DataStructure) WHERE ds.valid_to_commit IS NULL
         OPTIONAL MATCH (f:Function)-[pc:PRODUCES|CONSUMES]->(ds)
           WHERE pc.valid_to_commit IS NULL AND f.valid_to_commit IS NULL
         OPTIONAL MATCH (sf:SourceFile)-[def:DEFINES_SCHEMA]->(ds)
           WHERE def.valid_to_commit IS NULL
             AND (ds.type = 'database_table'
                  OR ds.source IN ['ast', 'declared', 'infra', 'composite']
                  OR ds.schemaFormat IS NOT NULL)
         OPTIONAL MATCH (ch:MessageChannel)-[hs:HAS_SCHEMA]->(ds)
           WHERE hs.valid_to_commit IS NULL AND ch.valid_to_commit IS NULL
         OPTIONAL MATCH (dc:DataContainer)-[dchs:HAS_SCHEMA]->(ds)
           WHERE dchs.valid_to_commit IS NULL AND dc.valid_to_commit IS NULL
         OPTIONAL MATCH (ds)-[cb:CARRIED_BY]->(ch2:MessageChannel)
           WHERE cb.valid_to_commit IS NULL AND ch2.valid_to_commit IS NULL
         OPTIONAL MATCH (ep:APIEndpoint)-[rs:HAS_REQUEST_SCHEMA|HAS_RESPONSE_SCHEMA]->(ds)
           WHERE rs.valid_to_commit IS NULL AND ep.valid_to_commit IS NULL
         WITH ds,
              count(DISTINCT pc) + count(DISTINCT def) + count(DISTINCT hs)
              + count(DISTINCT dchs) + count(DISTINCT cb) + count(DISTINCT rs) AS refs
         WHERE refs = 0
         WITH collect(ds) AS orphans, count(ds) AS cnt
         UNWIND orphans AS orphan
         DETACH DELETE orphan
         RETURN cnt AS deletedStructures`,
        {},
    );

    // Cascade: DataField nodes whose parent DataStructure was just removed.
    // DETACH DELETE on the parent removed the HAS_FIELD edge but not the
    // DataField node itself — it would remain orphaned without this sweep.
    const cascade = await run(
        `MATCH (df:DataField) WHERE df.valid_to_commit IS NULL
         OPTIONAL MATCH (ds:DataStructure)-[hf:HAS_FIELD]->(df)
           WHERE hf.valid_to_commit IS NULL AND ds.valid_to_commit IS NULL
         WITH df, count(hf) AS refs
         WHERE refs = 0
         WITH collect(df) AS orphans, count(df) AS cnt
         UNWIND orphans AS orphan
         DETACH DELETE orphan
         RETURN cnt AS deletedFields`,
        {},
    );

    const deletedStructures = Number((sweep as any)?.records?.[0]?.get?.('deletedStructures') ?? 0);
    const deletedFields = Number((cascade as any)?.records?.[0]?.get?.('deletedFields') ?? 0);
    return { deletedStructures, deletedFields };
}

/**
 * Merge a DataContainer node with two-level identity.
 *
 * URN scope priority:
 *   1. databaseContext (from coderadius.yaml database_scope override)
 *   2. qualifiedRepoName (safe default — no cross-repo false positives)
 *
 * databaseNameHint: when provided, is stored as dt.databaseName for governance
 * queries (e.g. "find tables with same name and same databaseName across repos").
 * It is NEVER used to change the URN — only for annotation.
 *
 * sourceRepo: set when a manual override is in effect, so the Governance UI
 * can show which repo declared ownership of a shared table.
 *
 * scope/scopeSource: written ON CREATE only (POC — no backfill complexity).
 * Fresh ingest required for URN changes.
 */
export interface DataContainerWeldingHints {
    /** 16-hex fingerprint produced by physical-fingerprint.ts. */
    physicalEndpointKey?: string;
    /** Postgres schema / Kafka cluster id / qualifier. */
    schemaOrNs?: string;
    /** Coarse family — required for welding. */
    kindFamily?: 'rdbms' | 'document' | 'kv' | 'broker' | 'queue' | 'object';
    /** Canonical technology name (mirror of the bound Datastore.technology). */
    technology?: string;
    /** URN of the bound Datastore (when known). */
    datastoreUrn?: string;
    /** Confidence of the fingerprint resolution; only `high` participates in welding. */
    physicalEndpointConfidence?: 'high' | 'medium' | 'low';
}


export type MessageChannelKind = 'topic' | 'subscription' | 'queue' | 'exchange' | 'transport';

export type MessageChannelScope = 'logical' | 'physical' | 'transport';

/**
 * Build the URN for a MessageChannel node.
 *
 * Backward-compatible: when `brokerFingerprint` is omitted, returns the legacy
 * format `cr:channel:{kind}:{name}`. When present, appends `@{brokerFp}` so
 * channels on different brokers stay distinct (strict broker isolation rule).
 */
export function buildMessageChannelUrn(
    name: string,
    channelKind: MessageChannelKind,
    brokerFingerprint?: string,
): string {
    let base: string;
    if (channelKind === 'topic') base = buildUrn('channel', 'topic', name);
    else if (channelKind === 'subscription') base = buildUrn('channel', 'sub', name);
    else base = buildUrn('channel', channelKind, name);
    return brokerFingerprint ? `${base}@${brokerFingerprint}` : base;
}

export interface MergeMessageChannelOptions {
    schemaPath?: string;
    schemaFormat?: string;
    tags?: string[];
    grounding?: GroundingFields;
    // Domain-model extensions (POC mode: in-place schema, no shim)
    scope?: MessageChannelScope;
    brokerUrn?: string;
    brokerFingerprint?: string;
    durable?: boolean;
    autoDelete?: boolean;
    ordered?: boolean;
    confidence?: number;
}

export async function mergeMessageChannelWithKind(
    name: string,
    channelKind: MessageChannelKind,
    technology: string | undefined,
    commitHash: string,
    opts: MergeMessageChannelOptions = {},
) {
    const urn = buildMessageChannelUrn(name, channelKind, opts.brokerFingerprint);
    const tagsValue = opts.tags && opts.tags.length > 0 ? opts.tags : null;
    await run(
        `MERGE (ch:MessageChannel {id: $urn})
         ON CREATE SET ch.valid_from_commit = $commitHash, ch.valid_to_commit = null,
                       ch.name = $name, ch.channelKind = $channelKind,
                       ch.technology = $technology, ch.schemaPath = $schemaPath,
                       ch.schemaFormat = $schemaFormat, ch.tags = $tags, ch.createdAt = timestamp(),
                       ch.scope = $scope, ch.brokerUrn = $brokerUrn,
                       ch.durable = $durable, ch.autoDelete = $autoDelete, ch.ordered = $ordered,
                       ch.confidence = $confidence
         ON MATCH SET ch.valid_from_commit = coalesce(ch.valid_from_commit, $commitHash),
                      ch.valid_to_commit = null,
                      ch.technology = coalesce($technology, ch.technology),
                      ch.channelKind = coalesce($channelKind, ch.channelKind),
                      ch.schemaPath = coalesce($schemaPath, ch.schemaPath),
                      ch.schemaFormat = coalesce($schemaFormat, ch.schemaFormat),
                      ch.tags = coalesce($tags, ch.tags),
                      ch.scope = coalesce($scope, ch.scope),
                      ch.brokerUrn = coalesce($brokerUrn, ch.brokerUrn),
                      ch.durable = coalesce($durable, ch.durable),
                      ch.autoDelete = coalesce($autoDelete, ch.autoDelete),
                      ch.ordered = coalesce($ordered, ch.ordered),
                      ch.confidence = coalesce($confidence, ch.confidence)
         ${groundingWriteClause('ch')}`,
        {
            urn,
            name,
            channelKind,
            technology: technology ?? null,
            schemaPath: opts.schemaPath ?? null,
            schemaFormat: opts.schemaFormat ?? null,
            tags: tagsValue,
            scope: opts.scope ?? null,
            brokerUrn: opts.brokerUrn ?? null,
            durable: opts.durable ?? null,
            autoDelete: opts.autoDelete ?? null,
            ordered: opts.ordered ?? null,
            confidence: opts.confidence ?? null,
            commitHash,
            ...groundingParams(opts.grounding, commitHash),
        },
    );
    return urn;
}





// ─── MessageBroker mutations ─────────────────────────────────────────────────

export type MessageBrokerProvider =
    | 'rabbitmq' | 'kafka' | 'pubsub' | 'sqs' | 'sns' | 'azure-service-bus'
    | 'nats' | 'pulsar' | 'redis-streams' | 'mqtt' | 'mosquitto' | 'zeromq'
    | 'symfony-messenger';

export interface MergeBrokerInput {
    urn: string;
    provider: MessageBrokerProvider;
    fingerprint: string;
    declaredVia: 'config' | 'crossplane' | 'backstage' | 'coderadius.yaml' | 'inferred';
    cluster?: string;
    host?: string;
    port?: number;
    vhost?: string;
    region?: string;
    env?: string;
    confidence?: number;
    grounding?: GroundingFields;
    /**
     * 'global' when fingerprint is stable cross-repo (FQDN hosts), 'repo'
     * when scoped to the originating repo (loopback / compose service names).
     */
    fingerprintScope?: 'global' | 'repo';
    /** When fingerprintScope='repo', the qualifiedRepoName that scoped this broker. */
    repoScope?: string;
    /**
     * Multi-env governance: other hosts observed across config files for the
     * same env-var key. The primary host (production-priority winner) is
     * `host`; alternates land here for audit without producing phantom nodes.
     */
    alternateHostsSeen?: string[];
    /**
     * Config-declared connections (s4 lane): the config-level connection name
     * and its declaring file (repo-relative). Join keys for the
     * channel-connection binding pass (same-file scope).
     */
    connectionName?: string;
    sourceFile?: string;
    /** Qualified repo name of the declaring config (cross-repo join guard). */
    sourceRepoUrn?: string;
}

export async function mergeMessageBroker(input: MergeBrokerInput, commitHash: string): Promise<string> {
    const altsValue = input.alternateHostsSeen && input.alternateHostsSeen.length > 0
        ? input.alternateHostsSeen
        : null;
    // Fix 10: displayHost/displayVhost are populated ONLY in transparent mode
    // (case-preserved original identifiers for UI/CLI debug). In opaque mode
    // they are explicitly removed from the node to prevent stale PII from a
    // previous transparent run (privacy-correct on reused graphs).
    const transparent = areUrnsTransparent();
    // Fix P2.6: `b.host` stores the NORMALIZED canonical form (lowercase, no
    // trailing dot, IPv6 brackets stripped) so it matches `fingerprint` input.
    // `b.displayHost` carries the case-preserved original for UI debug only.
    const normalizedHost = input.host ? normalizeHost(input.host) : null;
    const displayHost = transparent ? (input.host ?? null) : null;
    const displayVhost = transparent ? (input.vhost ?? null) : null;
    await run(
        `MERGE (b:MessageBroker {id: $urn})
         ON CREATE SET b.valid_from_commit = $commitHash, b.valid_to_commit = null,
                       b.provider = $provider, b.fingerprint = $fingerprint,
                       b.declaredVia = $declaredVia, b.cluster = $cluster,
                       b.host = $host, b.port = $port, b.vhost = $vhost,
                       b.region = $region, b.env = $env, b.confidence = $confidence,
                       b.fingerprintScope = $fingerprintScope, b.repoScope = $repoScope,
                       b.alternateHostsSeen = $alternateHostsSeen,
                       b.connectionName = $connectionName, b.sourceFile = $sourceFile,
                       b.sourceRepoUrn = $sourceRepoUrn,
                       b.createdAt = timestamp()
         ON MATCH SET b.valid_from_commit = coalesce(b.valid_from_commit, $commitHash),
                      b.valid_to_commit = null,
                      b.cluster = coalesce($cluster, b.cluster),
                      b.host = coalesce($host, b.host),
                      b.port = coalesce($port, b.port),
                      b.vhost = coalesce($vhost, b.vhost),
                      b.region = coalesce($region, b.region),
                      b.env = coalesce($env, b.env),
                      b.declaredVia = coalesce($declaredVia, b.declaredVia),
                      b.confidence = coalesce($confidence, b.confidence),
                      b.fingerprintScope = coalesce($fingerprintScope, b.fingerprintScope),
                      b.repoScope = coalesce($repoScope, b.repoScope),
                      b.alternateHostsSeen = coalesce($alternateHostsSeen, b.alternateHostsSeen),
                      b.connectionName = coalesce($connectionName, b.connectionName),
                      b.sourceFile = coalesce($sourceFile, b.sourceFile),
                      b.sourceRepoUrn = coalesce($sourceRepoUrn, b.sourceRepoUrn)
         ${groundingWriteClause('b')}`,
        {
            urn: input.urn,
            provider: input.provider,
            fingerprint: input.fingerprint,
            declaredVia: input.declaredVia,
            cluster: input.cluster ?? null,
            host: normalizedHost,
            port: input.port ?? null,
            vhost: input.vhost ?? null,
            region: input.region ?? null,
            env: input.env ?? null,
            confidence: input.confidence ?? null,
            fingerprintScope: input.fingerprintScope ?? null,
            repoScope: input.repoScope ?? null,
            alternateHostsSeen: altsValue,
            connectionName: input.connectionName ?? null,
            sourceFile: input.sourceFile ?? null,
            sourceRepoUrn: input.sourceRepoUrn ?? null,
            commitHash,
            ...groundingParams(input.grounding, commitHash),
        },
    );
    // Phase 2 transparent identity: set or unset displayHost/displayVhost.
    if (transparent) {
        await run(
            `MATCH (b:MessageBroker {id: $urn})
             SET b.displayHost = $displayHost, b.displayVhost = $displayVhost`,
            { urn: input.urn, displayHost, displayVhost },
        );
    } else {
        await run(
            `MATCH (b:MessageBroker {id: $urn})
             REMOVE b.displayHost, b.displayVhost`,
            { urn: input.urn },
        );
    }
    return input.urn;
}

/**
 * Fix 10: clear stale `displayHost`/`displayVhost` on ALL brokers (not just
 * those touched in the current run). Safe to call in opaque mode at CLI
 * startup; idempotent in transparent mode (no-op semantics).
 *
 * Use case: a user toggles `--transparent-urns` between runs. The opaque run
 * must sanitise any leftover display props from the previous transparent run.
 */
export async function cleanupTransparentArtifacts(): Promise<void> {
    await run(
        `MATCH (b:MessageBroker)
         REMOVE b.displayHost, b.displayVhost`,
    );
}

export interface LinkServiceConnectsToBrokerOptions {
    sourceType?: 'env-var' | 'channel-convergence' | 'config';
    via?: string;
    /**
     * Per-reconcile-run marker (NOT a commit hash — every reconcile caller
     * passes commitHash='SYSTEM', so commits cannot mark runs). Stamped as
     * `rel.lastSeenRun` (param wins when present); the env-var binding
     * reaper tombstones live env-var edges whose marker is stale.
     */
    runMarker?: string;
}

/**
 * `(Service)-[:CONNECTS_TO {source}]->(MessageBroker)` — service-level binding
 * to a broker. `source` is part of relationship identity so env-var discovery
 * and channel-convergence corroboration can coexist for the same service/broker.
 */
export async function linkServiceConnectsToBroker(
    serviceUrn: string,
    brokerUrn: string,
    sourceEnvKey: string | null,
    commitHash: string,
    opts: LinkServiceConnectsToBrokerOptions = {},
): Promise<void> {
    const sourceType = opts.sourceType ?? 'env-var';
    await run(
        `MATCH (s:Service {id: $serviceUrn}), (b:MessageBroker {id: $brokerUrn})
         OPTIONAL MATCH (s)-[legacy:CONNECTS_TO]->(b)
         WHERE legacy.source IS NULL AND $sourceType = 'env-var'
         SET legacy.source = $sourceType,
             legacy.valid_to_commit = null,
             legacy.sourceEnvKey = coalesce(legacy.sourceEnvKey, $sourceEnvKey),
             legacy.via = coalesce(legacy.via, $via)
         WITH s, b
         MERGE (s)-[rel:CONNECTS_TO {source: $sourceType}]->(b)
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                       rel.sourceEnvKey = $sourceEnvKey, rel.via = $via,
                       rel.lastSeenRun = $runMarker
         ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                      rel.valid_to_commit = null,
                      rel.sourceEnvKey = coalesce(rel.sourceEnvKey, $sourceEnvKey),
                      rel.via = coalesce(rel.via, $via),
                      rel.lastSeenRun = coalesce($runMarker, rel.lastSeenRun)`,
        { serviceUrn, brokerUrn, sourceEnvKey, sourceType, via: opts.via ?? null, runMarker: opts.runMarker ?? null, commitHash },
    );
}

export interface LinkFunctionToChannelOptions {
    routingKey?: string;
    partitionKey?: string;
    consumerGroup?: string;
    ackMode?: string;
    filterExpression?: string;
    headers?: Record<string, string>;
    grounding?: GroundingFields;
    brokerScopeConfidence?: 'declared' | 'auto-promoted' | 'inferred';
}

/**
 * `(Function)-[:PUBLISHES_TO]->(MessageChannel)` keyed by channel URN.
 * Carry-over of edge properties is the caller's responsibility.
 */
export async function linkFunctionPublishesTo(
    functionId: string,
    channelUrn: string,
    commitHash: string,
    opts: LinkFunctionToChannelOptions = {},
): Promise<void> {
    // Memgraph rejects `null` literals inside MERGE property patterns. Branch
    // the Cypher by whether routingKey is set so the edge identity stays
    // consistent (routingKey present → distinct edge per key; absent → single
    // edge) without sending NULL into the MERGE.
    const hasRoutingKey = opts.routingKey != null;
    const mergeClause = hasRoutingKey
        ? `MERGE (f)-[rel:PUBLISHES_TO {routingKey: $routingKey}]->(ch)`
        : `MERGE (f)-[rel:PUBLISHES_TO]->(ch)`;
    await run(
        `MATCH (f:Function {id: $functionId}), (ch:MessageChannel {id: $channelUrn})
         ${mergeClause}
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                       rel.partitionKey = $partitionKey, rel.headers = $headers,
                       rel.brokerScopeConfidence = $brokerScopeConfidence
         ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                      rel.valid_to_commit = null,
                      rel.partitionKey = coalesce($partitionKey, rel.partitionKey),
                      rel.headers = coalesce($headers, rel.headers),
                      rel.brokerScopeConfidence = coalesce($brokerScopeConfidence, rel.brokerScopeConfidence)`,
        {
            functionId, channelUrn, commitHash,
            routingKey: opts.routingKey ?? null,
            partitionKey: opts.partitionKey ?? null,
            headers: opts.headers ? JSON.stringify(opts.headers) : null,
            brokerScopeConfidence: opts.brokerScopeConfidence ?? null,
        },
    );
}

/**
 * `(Function)-[:LISTENS_TO]->(MessageChannel)` keyed by channel URN.
 */
export async function linkFunctionListensTo(
    functionId: string,
    channelUrn: string,
    commitHash: string,
    opts: LinkFunctionToChannelOptions = {},
): Promise<void> {
    const hasConsumerGroup = opts.consumerGroup != null;
    const mergeClause = hasConsumerGroup
        ? `MERGE (f)-[rel:LISTENS_TO {consumerGroup: $consumerGroup}]->(ch)`
        : `MERGE (f)-[rel:LISTENS_TO]->(ch)`;
    await run(
        `MATCH (f:Function {id: $functionId}), (ch:MessageChannel {id: $channelUrn})
         ${mergeClause}
         ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                       rel.ackMode = $ackMode, rel.filterExpression = $filterExpression,
                       rel.brokerScopeConfidence = $brokerScopeConfidence
         ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                      rel.valid_to_commit = null,
                      rel.ackMode = coalesce($ackMode, rel.ackMode),
                      rel.filterExpression = coalesce($filterExpression, rel.filterExpression),
                      rel.brokerScopeConfidence = coalesce($brokerScopeConfidence, rel.brokerScopeConfidence)`,
        {
            functionId, channelUrn, commitHash,
            consumerGroup: opts.consumerGroup ?? null,
            ackMode: opts.ackMode ?? null,
            filterExpression: opts.filterExpression ?? null,
            brokerScopeConfidence: opts.brokerScopeConfidence ?? null,
        },
    );
}

/**
 * Merge a physical `:MessageChannel` (scope='physical') hosted on a specific
 * broker. Thin wrapper around `mergeMessageChannelWithKind` that enforces:
 *   - scope: 'physical'
 *   - brokerFingerprint suffix on the URN
 *   - brokerUrn property + :HOSTED_ON edge
 *
 * Kept separate from the generic `mergeMessageChannelWithKind` to avoid
 * ambiguity for callers that handle logical channels (scope='logical') or
 * declarative-only ones (scope='transport').
 */
export async function mergePhysicalMessageChannel(
    name: string,
    channelKind: MessageChannelKind,
    technology: string,
    brokerFingerprint: string,
    brokerUrn: string,
    commitHash: string,
    opts: Omit<MergeMessageChannelOptions, 'scope' | 'brokerFingerprint' | 'brokerUrn'> = {},
): Promise<string> {
    const channelUrn = await mergeMessageChannelWithKind(
        name,
        channelKind,
        technology,
        commitHash,
        { ...opts, scope: 'physical', brokerFingerprint, brokerUrn },
    );
    await linkChannelHostedOn(channelUrn, brokerUrn, commitHash);
    return channelUrn;
}

/**
 * Attach a (scope='physical') MessageChannel to its MessageBroker host.
 */
export async function linkChannelHostedOn(channelUrn: string, brokerUrn: string, commitHash: string) {
    await run(
        `MATCH (ch:MessageChannel {id: $channelUrn})
         MATCH (b:MessageBroker {id: $brokerUrn})
         MERGE (ch)-[r:HOSTED_ON]->(b)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null`,
        { channelUrn, brokerUrn, commitHash },
    );
}

/**
 * MANIFESTS_AS edge: a logical MessageChannel realizes through a physical one.
 *
 * One logical can manifest as N physicals (Shovel/Federation/MirrorMaker mirrors,
 * env splits, fan-out across regions). Strict-isolation rule: never created
 * heuristically when broker URNs differ unless the customer declared it in
 * `coderadius.yaml.channelAliases`.
 */
export async function manifestChannelAs(
    logicalUrn: string,
    physicalUrn: string,
    commitHash: string,
    declaredVia: 'coderadius.yaml' | 'inferred' | 'config',
    confidence: number,
) {
    await run(
        `MATCH (l:MessageChannel {id: $logicalUrn})
         MATCH (p:MessageChannel {id: $physicalUrn})
         MERGE (l)-[r:MANIFESTS_AS]->(p)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.declaredVia = $declaredVia, r.confidence = $confidence
         ON MATCH SET r.valid_to_commit = null,
                      r.declaredVia = $declaredVia,
                      r.confidence = $confidence`,
        { logicalUrn, physicalUrn, commitHash, declaredVia, confidence },
    );
}

/**
 * BACKED_BY edge: a transport-kind channel (Symfony Messenger) is implemented
 * by an underlying physical channel (an AMQP queue, Doctrine table, Redis stream).
 */
export async function linkChannelBackedBy(
    transportUrn: string,
    physicalUrn: string,
    commitHash: string,
    declaredVia: 'coderadius.yaml' | 'inferred' | 'config',
) {
    await run(
        `MATCH (t:MessageChannel {id: $transportUrn})
         MATCH (p:MessageChannel {id: $physicalUrn})
         MERGE (t)-[r:BACKED_BY]->(p)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.declaredVia = $declaredVia
         ON MATCH SET r.valid_to_commit = null,
                      r.declaredVia = $declaredVia`,
        { transportUrn, physicalUrn, commitHash, declaredVia },
    );
}

/**
 * DEAD_LETTERS_TO edge: messages rejected or expired on the source channel
 * are routed to the destination (DLQ). Captures second-order blast: a broken
 * consumer causes backlog on the DLQ even if the source channel still works.
 */
export async function linkChannelDeadLettersTo(
    sourceUrn: string,
    dlqUrn: string,
    commitHash: string,
    retryLimit?: number,
    ttl?: number,
) {
    await run(
        `MATCH (src:MessageChannel {id: $sourceUrn})
         MATCH (dlq:MessageChannel {id: $dlqUrn})
         MERGE (src)-[r:DEAD_LETTERS_TO]->(dlq)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.retryLimit = $retryLimit, r.ttl = $ttl
         ON MATCH SET r.valid_to_commit = null,
                      r.retryLimit = coalesce($retryLimit, r.retryLimit),
                      r.ttl = coalesce($ttl, r.ttl)`,
        { sourceUrn, dlqUrn, commitHash, retryLimit: retryLimit ?? null, ttl: ttl ?? null },
    );
}

/**
 * CARRIED_BY edge: a DataStructure (message contract) is transported on a channel.
 * Explicit inverse of HAS_SCHEMA, used for "which channels ship this contract?" lineage.
 */
export async function linkSchemaCarriedBy(
    schemaUrn: string,
    channelUrn: string,
    commitHash: string,
) {
    await run(
        `MATCH (ds:DataStructure {id: $schemaUrn})
         MATCH (ch:MessageChannel {id: $channelUrn})
         MERGE (ds)-[r:CARRIED_BY]->(ch)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null`,
        { schemaUrn, channelUrn, commitHash },
    );
}

/**
 * Direct `(APIEndpoint)-[:HAS_REQUEST_SCHEMA]->(DataStructure)` mutation.
 *
 * Used by the OpenAPI extractor where the request body is declared in the
 * spec itself (deterministic, no LLM, no need to go through the Function-
 * mediated welder). The grounding-quality is `ast/exact` because the OAS
 * file IS the contract.
 */
export async function linkApiEndpointHasRequestSchema(
    endpointUrn: string,
    schemaUrn: string,
    commitHash: string,
) {
    await run(
        `MATCH (ep:APIEndpoint {id: $endpointUrn})
         MATCH (ds:DataStructure {id: $schemaUrn})
         MERGE (ep)-[r:HAS_REQUEST_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.source = 'ast', r.declaredVia = 'openapi'
         ON MATCH SET r.valid_to_commit = null,
                      r.source = coalesce(r.source, 'ast'),
                      r.declaredVia = coalesce(r.declaredVia, 'openapi')`,
        { endpointUrn, schemaUrn, commitHash },
    );
}

/** Counterpart of `linkApiEndpointHasRequestSchema` for response bodies. */
export async function linkApiEndpointHasResponseSchema(
    endpointUrn: string,
    schemaUrn: string,
    commitHash: string,
) {
    await run(
        `MATCH (ep:APIEndpoint {id: $endpointUrn})
         MATCH (ds:DataStructure {id: $schemaUrn})
         MERGE (ep)-[r:HAS_RESPONSE_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.source = 'ast', r.declaredVia = 'openapi'
         ON MATCH SET r.valid_to_commit = null,
                      r.source = coalesce(r.source, 'ast'),
                      r.declaredVia = coalesce(r.declaredVia, 'openapi')`,
        { endpointUrn, schemaUrn, commitHash },
    );
}

export async function linkChannelToSchema(
    channelUrn: string,
    schemaUrn: string,
    commitHash: string,
) {
    await run(
        `MATCH (ch:MessageChannel {id: $channelUrn})
         MATCH (ds:DataStructure {id: $schemaUrn})
         MERGE (ch)-[r:HAS_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null`,
        { channelUrn, schemaUrn, commitHash },
    );
}

/**
 * Function-mediated welder (Scope A): derive `(MessageChannel)-[:HAS_SCHEMA]->(DataStructure)`
 * and its inverse `(DataStructure)-[:CARRIED_BY]->(MessageChannel)` from
 * shared-Function correlation.
 *
 * Two correlation patterns are exercised:
 *
 *   Producer:  (f)-[:PRODUCES]->(ds)   +  (f)-[:PUBLISHES_TO]->(ch)
 *   Consumer:  (f)-[:CONSUMES]->(ds)   +  (f)-[:LISTENS_TO]->(ch)
 *
 * Complements `inferAndLinkChannelSchemas`, which links via SourceFile-path
 * (Avro/Protobuf-file MATCH). That welder fires only when a deterministic
 * schema file is present in the repo; for codebases dominated by
 * LLM-emergent payloads (no `.avsc` file as ground truth) it produces zero
 * links. The Function bridge here covers exactly that gap.
 *
 * Cardinality / FP caveat: when a single Function publishes to N channels
 * AND produces M payloads, the welder creates the full N×M Cartesian
 * product of links. In practice publisher functions are 1-1 or 1-many;
 * pure N-many cases are rare. Documented as a known limitation of Scope A;
 * a future refinement could correlate by source-position proximity within
 * the function body (the `publish(...)` call and the `new Event(...)`
 * literal that precedes it).
 *
 * Idempotent. All temporal predicates filter `valid_to_commit IS NULL` on
 * source / target nodes AND on the source PUBLISHES_TO/LISTENS_TO and
 * PRODUCES/CONSUMES edges, so a tombstoned bridge cannot resurrect a
 * dead link.
 *
 * Returns counts for telemetry. The MERGE is idempotent so re-runs on a
 * saturated graph report the same numbers (representing the number of
 * (ch, ds) PAIRS produced by the correlation, not the number of newly
 * materialised edges).
 */
export async function weldChannelPayloadsByFunction(commitHash: string): Promise<{
    hasSchemaLinked: number;
    carriedByLinked: number;
}> {
    const WELDER = 'channel-payload-by-function';
    // Producer side.
    const producer = await run(
        `MATCH (f:Function)-[pub:PUBLISHES_TO]->(ch:MessageChannel)
         WHERE f.valid_to_commit IS NULL
           AND pub.valid_to_commit IS NULL
           AND ch.valid_to_commit IS NULL
         MATCH (f)-[prod:PRODUCES]->(ds:DataStructure)
         WHERE prod.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ch, ds
         MERGE (ch)-[h:HAS_SCHEMA]->(ds)
         ON CREATE SET h.valid_from_commit = $commitHash, h.valid_to_commit = null,
                       h.weldedBy = $welder, h.weldedAtCommit = $commitHash
         ON MATCH SET h.valid_to_commit = null,
                      h.weldedBy = $welder, h.weldedAtCommit = $commitHash
         MERGE (ds)-[c:CARRIED_BY]->(ch)
         ON CREATE SET c.valid_from_commit = $commitHash, c.valid_to_commit = null,
                       c.weldedBy = $welder, c.weldedAtCommit = $commitHash
         ON MATCH SET c.valid_to_commit = null,
                      c.weldedBy = $welder, c.weldedAtCommit = $commitHash
         RETURN count(DISTINCT h) AS hsCount, count(DISTINCT c) AS cbCount`,
        { commitHash, welder: WELDER },
    );

    // Consumer side.
    const consumer = await run(
        `MATCH (f:Function)-[lst:LISTENS_TO]->(ch:MessageChannel)
         WHERE f.valid_to_commit IS NULL
           AND lst.valid_to_commit IS NULL
           AND ch.valid_to_commit IS NULL
         MATCH (f)-[con:CONSUMES]->(ds:DataStructure)
         WHERE con.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ch, ds
         MERGE (ch)-[h:HAS_SCHEMA]->(ds)
         ON CREATE SET h.valid_from_commit = $commitHash, h.valid_to_commit = null,
                       h.weldedBy = $welder, h.weldedAtCommit = $commitHash
         ON MATCH SET h.valid_to_commit = null,
                      h.weldedBy = $welder, h.weldedAtCommit = $commitHash
         MERGE (ds)-[c:CARRIED_BY]->(ch)
         ON CREATE SET c.valid_from_commit = $commitHash, c.valid_to_commit = null,
                       c.weldedBy = $welder, c.weldedAtCommit = $commitHash
         ON MATCH SET c.valid_to_commit = null,
                      c.weldedBy = $welder, c.weldedAtCommit = $commitHash
         RETURN count(DISTINCT h) AS hsCount, count(DISTINCT c) AS cbCount`,
        { commitHash, welder: WELDER },
    );

    // Sweep phase: tombstone HAS_SCHEMA / CARRIED_BY edges we created in a
    // previous run but did NOT touch this run (correlation source disappeared).
    await run(
        `MATCH ()-[r:HAS_SCHEMA|CARRIED_BY]->()
         WHERE r.valid_to_commit IS NULL
           AND r.weldedBy = $welder
           AND r.weldedAtCommit <> $commitHash
         SET r.valid_to_commit = $commitHash`,
        { welder: WELDER, commitHash },
    );

    const pickNum = (rec: any, key: string): number => {
        const v = rec?.records?.[0]?.get?.(key);
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v.toNumber === 'function') return v.toNumber();
        return Number(v);
    };
    return {
        hasSchemaLinked: pickNum(producer, 'hsCount') + pickNum(consumer, 'hsCount'),
        carriedByLinked: pickNum(producer, 'cbCount') + pickNum(consumer, 'cbCount'),
    };
}

/**
 * Function-mediated welder (Scope B): derive
 * `(APIEndpoint)-[:HAS_REQUEST_SCHEMA]->(DataStructure)` and
 * `(APIEndpoint)-[:HAS_RESPONSE_SCHEMA]->(DataStructure)` from shared-Function
 * correlation.
 *
 * Four correlation patterns:
 *
 *   Client-side request   :  (f)-[:CALLS]->(ep)               + (f)-[:PRODUCES]->(ds)
 *                                          ⇒ HAS_REQUEST_SCHEMA(ep, ds)
 *
 *   Client-side response  :  (f)-[:CALLS]->(ep)               + (f)-[:CONSUMES]->(ds)
 *                                          ⇒ HAS_RESPONSE_SCHEMA(ep, ds)
 *
 *   Server-side request   :  (f)-[:IMPLEMENTS_ENDPOINT]->(ep) + (f)-[:CONSUMES]->(ds)
 *                                          ⇒ HAS_REQUEST_SCHEMA(ep, ds)
 *
 *   Server-side response  :  (f)-[:IMPLEMENTS_ENDPOINT]->(ep) + (f)-[:PRODUCES]->(ds)
 *                                          ⇒ HAS_RESPONSE_SCHEMA(ep, ds)
 *
 * The four patterns are required because the semantics of PRODUCES/CONSUMES
 * invert between client and server perspectives:
 *
 *   - On the CLIENT side (CALLS), the function sends the request body
 *     (PRODUCES) and receives the response body (CONSUMES).
 *   - On the SERVER side (IMPLEMENTS_ENDPOINT), the function receives the
 *     request body (CONSUMES) and emits the response body (PRODUCES).
 *
 * Today only the client-side request pattern fires on real repos (the LLM
 * extracts `payload_schema` only for OUTBOUND request bodies; INBOUND handler
 * body extraction is not implemented yet; response_schema extraction requires
 * a prompt extension). The other 3 patterns are scaffolding for when those
 * extraction gaps close.
 *
 * Same FP caveat as the channel welder: an N×M Cartesian within a single
 * Function is possible but rare in practice.
 *
 * Idempotent. All temporal predicates filter `valid_to_commit IS NULL` on
 * source / target nodes AND on the bridging edges.
 */
export async function weldApiEndpointSchemasByFunction(commitHash: string): Promise<{
    hasRequestSchemaLinked: number;
    hasResponseSchemaLinked: number;
}> {
    const WELDER = 'api-endpoint-schema-by-function';
    // Client-side request: CALLS + PRODUCES → HAS_REQUEST_SCHEMA
    const clientReq = await run(
        `MATCH (f:Function)-[c:CALLS]->(ep:APIEndpoint)
         WHERE f.valid_to_commit IS NULL
           AND c.valid_to_commit IS NULL
           AND ep.valid_to_commit IS NULL
         MATCH (f)-[p:PRODUCES]->(ds:DataStructure)
         WHERE p.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ep, ds
         MERGE (ep)-[r:HAS_REQUEST_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         ON MATCH SET r.valid_to_commit = null,
                      r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         RETURN count(DISTINCT r) AS cnt`,
        { commitHash, welder: WELDER },
    );

    // Client-side response: CALLS + CONSUMES → HAS_RESPONSE_SCHEMA
    const clientRes = await run(
        `MATCH (f:Function)-[c:CALLS]->(ep:APIEndpoint)
         WHERE f.valid_to_commit IS NULL
           AND c.valid_to_commit IS NULL
           AND ep.valid_to_commit IS NULL
         MATCH (f)-[con:CONSUMES]->(ds:DataStructure)
         WHERE con.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ep, ds
         MERGE (ep)-[r:HAS_RESPONSE_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         ON MATCH SET r.valid_to_commit = null,
                      r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         RETURN count(DISTINCT r) AS cnt`,
        { commitHash, welder: WELDER },
    );

    // Server-side request: IMPLEMENTS_ENDPOINT + CONSUMES → HAS_REQUEST_SCHEMA
    const serverReq = await run(
        `MATCH (f:Function)-[i:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
         WHERE f.valid_to_commit IS NULL
           AND i.valid_to_commit IS NULL
           AND ep.valid_to_commit IS NULL
         MATCH (f)-[con:CONSUMES]->(ds:DataStructure)
         WHERE con.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ep, ds
         MERGE (ep)-[r:HAS_REQUEST_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         ON MATCH SET r.valid_to_commit = null,
                      r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         RETURN count(DISTINCT r) AS cnt`,
        { commitHash, welder: WELDER },
    );

    // Server-side response: IMPLEMENTS_ENDPOINT + PRODUCES → HAS_RESPONSE_SCHEMA
    const serverRes = await run(
        `MATCH (f:Function)-[i:IMPLEMENTS_ENDPOINT]->(ep:APIEndpoint)
         WHERE f.valid_to_commit IS NULL
           AND i.valid_to_commit IS NULL
           AND ep.valid_to_commit IS NULL
         MATCH (f)-[p:PRODUCES]->(ds:DataStructure)
         WHERE p.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
         WITH DISTINCT ep, ds
         MERGE (ep)-[r:HAS_RESPONSE_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null,
                       r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         ON MATCH SET r.valid_to_commit = null,
                      r.weldedBy = $welder, r.weldedAtCommit = $commitHash
         RETURN count(DISTINCT r) AS cnt`,
        { commitHash, welder: WELDER },
    );

    // Sweep stale edges (from previous runs not refreshed this commit).
    await run(
        `MATCH ()-[r:HAS_REQUEST_SCHEMA|HAS_RESPONSE_SCHEMA]->()
         WHERE r.valid_to_commit IS NULL
           AND r.weldedBy = $welder
           AND r.weldedAtCommit <> $commitHash
         SET r.valid_to_commit = $commitHash`,
        { welder: WELDER, commitHash },
    );

    const pickNum = (rec: any, key: string): number => {
        const v = rec?.records?.[0]?.get?.(key);
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v.toNumber === 'function') return v.toNumber();
        return Number(v);
    };
    return {
        hasRequestSchemaLinked: pickNum(clientReq, 'cnt') + pickNum(serverReq, 'cnt'),
        hasResponseSchemaLinked: pickNum(clientRes, 'cnt') + pickNum(serverRes, 'cnt'),
    };
}

/**
 * Phase 3 (Fix #2) — REFERENCES_TYPE welder.
 *
 * Materialises `(DataField)-[:REFERENCES_TYPE]->(DataStructure)` edges by
 * parsing each DataField's `type` string with the appropriate language
 * plugin (PHP, TS, ...). Mark-and-sweep via `weldedBy='field-type-ref'`.
 *
 * Round-trips to Memgraph: 4 total (scan + catalog + UNWIND merge + sweep),
 * bounded regardless of corpus size. Scope priority: same-scope > global.
 */
export async function linkFieldsReferenceTypes(commitHash: string): Promise<{
    linked: number;
    swept: number;
}> {
    const WELDER = 'field-type-ref';

    const scanResult = await run(
        `MATCH (sf:SourceFile)-[:DEFINES_SCHEMA]->(ds:DataStructure)-[:HAS_FIELD]->(df:DataField)
         WHERE sf.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
           AND df.valid_to_commit IS NULL
           AND df.type IS NOT NULL
           AND df.type <> ''
         RETURN df.id AS dfId,
                df.type AS typeStr,
                ds.scope AS dsScope,
                sf.path AS sfPath`,
        {},
    );

    const dsResult = await run(
        `MATCH (ds:DataStructure)
         WHERE ds.valid_to_commit IS NULL
         RETURN ds.id AS id, ds.name AS name, ds.scope AS scope`,
        {},
    );

    const dsByName = new Map<string, Array<{ urn: string; scope: string | null }>>();
    for (const rec of dsResult.records) {
        const name = rec.get('name') as string;
        const urn = rec.get('id') as string;
        const scope = (rec.get('scope') as string | null) ?? null;
        if (!name || !urn) continue;
        const arr = dsByName.get(name) ?? [];
        arr.push({ urn, scope });
        dsByName.set(name, arr);
    }

    type Pair = {
        dfId: string;
        targetUrn: string;
        baseTypeName: string;
        confidence: 'same-scope' | 'global';
    };
    const pairs: Pair[] = [];
    const seenPair = new Set<string>();
    for (const rec of scanResult.records) {
        const dfId = rec.get('dfId') as string;
        const typeStr = rec.get('typeStr') as string;
        const dsScope = (rec.get('dsScope') as string | null) ?? null;
        const sfPath = (rec.get('sfPath') as string | null) ?? '';
        if (!dfId || !typeStr) continue;

        const lastDot = sfPath.lastIndexOf('.');
        const ext = lastDot >= 0 ? sfPath.slice(lastDot) : '';
        const plugin = getPluginForExtension(ext);
        if (!plugin?.extractBaseTypesFromString) continue;

        const baseNames = plugin.extractBaseTypesFromString(typeStr);
        if (baseNames.length === 0) continue;

        for (const baseName of baseNames) {
            const candidates = dsByName.get(baseName);
            if (!candidates || candidates.length === 0) continue;
            const sameScope = dsScope ? candidates.find(c => c.scope === dsScope) : undefined;
            const best = sameScope ?? candidates[0];
            const confidence: 'same-scope' | 'global' = sameScope ? 'same-scope' : 'global';
            const key = `${dfId} ${best.urn} ${baseName}`;
            if (seenPair.has(key)) continue;
            seenPair.add(key);
            pairs.push({ dfId, targetUrn: best.urn, baseTypeName: baseName, confidence });
        }
    }

    let linked = 0;
    if (pairs.length > 0) {
        const mergeResult = await run(
            `UNWIND $pairs AS pair
             MATCH (df:DataField {id: pair.dfId})
             MATCH (target:DataStructure {id: pair.targetUrn})
             MERGE (df)-[r:REFERENCES_TYPE {baseTypeName: pair.baseTypeName}]->(target)
             ON CREATE SET r.valid_from_commit = $commitHash,
                           r.valid_to_commit = null,
                           r.weldedBy = $welder,
                           r.weldedAtCommit = $commitHash,
                           r.source = 'ast',
                           r.confidence = pair.confidence
             ON MATCH SET r.valid_to_commit = null,
                          r.weldedBy = $welder,
                          r.weldedAtCommit = $commitHash,
                          r.confidence = pair.confidence
             RETURN count(r) AS cnt`,
            { pairs, welder: WELDER, commitHash },
        );
        linked = pickRefTypeCount(mergeResult, 'cnt');
    }

    const sweepResult = await run(
        `MATCH ()-[r:REFERENCES_TYPE]->()
         WHERE r.valid_to_commit IS NULL
           AND r.weldedBy = $welder
           AND r.weldedAtCommit <> $commitHash
         SET r.valid_to_commit = $commitHash
         RETURN count(r) AS cnt`,
        { welder: WELDER, commitHash },
    );
    const swept = pickRefTypeCount(sweepResult, 'cnt');

    return { linked, swept };
}

function pickRefTypeCount(rec: any, key: string): number {
    const v = rec?.records?.[0]?.get?.(key);
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toNumber === 'function') return v.toNumber();
    return Number(v);
}

/**
 * Find a DataStructure URN by matching against SourceFile paths.
 *
 * Uses the FULL schemaPath from the LLM (not basename!) to preserve
 * context. If the LLM extracted "v2/save.avsc", the query matches
 * precisely. If it extracted just "save.avsc", it falls back gracefully.
 *
 * The raw path is sanitized (strip quotes) but NOT reduced to basename —
 * destroying context would cause false matches when multiple .avsc files
 * share the same filename (e.g. v1/save.avsc vs v2/save.avsc).
 */
export async function findDataStructureBySourceFile(schemaPath: string): Promise<string | null> {
    // Sanitize: strip leading/trailing quotes and normalize separators
    const matchPath = schemaPath
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/\\/g, '/');

    const result = await run(
        `MATCH (sf:SourceFile)-[:DEFINES_SCHEMA]->(ds:DataStructure)
         WHERE sf.path ENDS WITH $matchPath
           AND ds.type = 'message_payload'
         RETURN ds.id AS id
         LIMIT 1`,
        { matchPath },
    );
    if (result.records.length === 0) return null;
    return result.records[0].get('id') as string;
}



/**
 * Link a DataContainer to its parent Datastore via STORED_IN.
 *
 * Both URNs (DataContainer and Datastore) must be pre-built by the caller.
 * This function does NOT construct URNs — it matches existing nodes.
 *
 * Edge properties:
 *   - confidence: 0..1 — how certain we are that this is the right binding.
 *   - bindingReason: audit trail (sole-candidate / p0-yaml / llm-assignment / env-canonical-default).
 */
export async function linkDataContainerStoredIn(
    qualifiedRepoName: string,
    tableName: string,
    datastoreUrn: string,
    commitHash: string,
    bindingReason: string,
    databaseContext?: string,
    grounding?: GroundingFields,
) {
    const dbScope = databaseContext ?? qualifiedRepoName;
    const dtUrn = buildUrn('datacontainer', dbScope, tableName);
    await run(
        `MATCH (dt:DataContainer {id: $dtUrn})
     MATCH (ds:Datastore {id: $datastoreUrn})
     MERGE (dt)-[rel:STORED_IN]->(ds)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                   rel.bindingReason = $bindingReason
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash), rel.valid_to_commit = null,
                  rel.bindingReason = $bindingReason
     ${groundingWriteClause('rel')}`,
        { dtUrn, datastoreUrn, commitHash, bindingReason, ...groundingParams(grounding, commitHash) },
    );
}



export interface LinkFunctionToBrokerOptions {
    /** AMQP routing key / SNS topic ARN / Pub/Sub literal — emitted as edge property. */
    routingKey?: string;
    /** Kafka partition key extracted from a producer call. */
    partitionKey?: string;
    /** Consumer-group name (Kafka) or subscription name (Pub/Sub / SQS). */
    consumerGroup?: string;
    /** Filter expression on SNS / Pub/Sub subscriptions. */
    filterExpression?: string;
    /** LLM extraction confidence on the edge (0..1). */
    confidence?: number;
}

export async function linkFunctionToBroker(
    functionId: string,
    brokerName: string,
    operation: 'PUBLISHES_TO' | 'LISTENS_TO',
    commitHash: string,
    channelKind?: MessageChannelKind,
    opts: LinkFunctionToBrokerOptions = {},
) {
    const brokerUrn = channelKind ? buildMessageChannelUrn(brokerName, channelKind) : buildUrn('channel', brokerName);

    // The edge identity includes `routingKey` (when present) so multiple
    // publish call sites with different routing keys produce distinct edges
    // instead of collapsing into one. Memgraph supports MERGE on a relationship
    // with property patterns; when `routingKey` is null, only the null-key edge
    // is matched/created.
    const routingKeyParam = opts.routingKey ?? null;
    const isPublisher = operation === 'PUBLISHES_TO';
    const writeKey = isPublisher ? 'partitionKey' : 'consumerGroup';
    const writeKeyParam = isPublisher
        ? (opts.partitionKey ?? null)
        : (opts.consumerGroup ?? null);

    // NOTE: Cypher variable MUST NOT be 'mb' — reserved keyword in Memgraph.
    await run(
        `MATCH (f:Function {id: $functionId})
     MERGE (broker:MessageChannel {id: $brokerUrn})
     ON CREATE SET broker.valid_from_commit = $commitHash, broker.valid_to_commit = null, broker.name = $brokerName, broker.channelKind = $channelKind, broker.createdAt = timestamp(),
                   broker.source = 'llm', broker.quality = 'medium', broker.evidence_extractors = ['link-only-fallback@v1'],
                   broker.evidence_llmCalls = null, broker.evidence_fallbacksApplied = null, broker.evidence_mergedFrom = null,
                   broker.lastSeenCommit = $commitHash
     ON MATCH SET broker.valid_from_commit = coalesce(broker.valid_from_commit, $commitHash), broker.valid_to_commit = null, broker.channelKind = coalesce($channelKind, broker.channelKind)
     MERGE (f)-[rel:${operation} {routingKey: $routingKey}]->(broker)
     ON CREATE SET rel.valid_from_commit = $commitHash, rel.valid_to_commit = null,
                   rel.${writeKey} = $writeKeyValue,
                   rel.filterExpression = $filterExpression,
                   rel.confidence = $confidence
     ON MATCH SET rel.valid_from_commit = coalesce(rel.valid_from_commit, $commitHash),
                  rel.valid_to_commit = null,
                  rel.${writeKey} = coalesce($writeKeyValue, rel.${writeKey}),
                  rel.filterExpression = coalesce($filterExpression, rel.filterExpression),
                  rel.confidence = coalesce($confidence, rel.confidence)`,
        {
            functionId,
            brokerUrn,
            brokerName,
            channelKind: channelKind ?? null,
            commitHash,
            routingKey: routingKeyParam,
            writeKeyValue: writeKeyParam,
            filterExpression: opts.filterExpression ?? null,
            confidence: opts.confidence ?? null,
        },
    );
}


// ─── Data Contract Relationships (Function ↔ DataStructure) ──────────────────

/**
 * Link a Function to a DataStructure via [:PRODUCES].
 * Represents: "this function produces/publishes this data payload".
 */
export async function linkFunctionProducesSchema(functionId: string, schemaUrn: string, isOpaque: boolean | undefined, commitHash: string): Promise<void> {
    // fieldsCapped reset on every CREATE and MATCH (Phase 2): the field-link
    // mutation (linkFunctionProducesFields) overrides to true ONLY when the
    // hard cap actually triggered for this run. Without the reset, a stale
    // fieldsCapped=true from a previous run with more fields would survive
    // a re-ingest where the schema is now smaller, leading to a false positive
    // in the lineage gate's Path 2 fallback.
    await run(
        `MATCH (f:Function {id: $functionId}), (ds:DataStructure {id: $schemaUrn})
     MERGE (f)-[r:PRODUCES]->(ds)
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null, r.isOpaque = coalesce($isOpaque, false), r.fieldsCapped = false
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null, r.isOpaque = coalesce($isOpaque, r.isOpaque, false), r.fieldsCapped = false`,
        { functionId, schemaUrn, isOpaque: isOpaque ?? false , commitHash },
    );
}

/**
 * Link a Function to a DataStructure via [:CONSUMES].
 * Represents: "this function consumes/reads this data payload".
 */
export async function linkFunctionConsumesSchema(functionId: string, schemaUrn: string, isOpaque: boolean | undefined, commitHash: string): Promise<void> {
    // fieldsCapped reset on every CREATE and MATCH (Phase 2): see linkFunctionProducesSchema.
    await run(
        `MATCH (f:Function {id: $functionId}), (ds:DataStructure {id: $schemaUrn})
     MERGE (f)-[r:CONSUMES]->(ds)
     ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null, r.isOpaque = coalesce($isOpaque, false), r.fieldsCapped = false
     ON MATCH SET r.valid_from_commit = coalesce(r.valid_from_commit, $commitHash), r.valid_to_commit = null, r.isOpaque = coalesce($isOpaque, r.isOpaque, false), r.fieldsCapped = false`,
        { functionId, schemaUrn, isOpaque: isOpaque ?? false , commitHash },
    );
}

// ─── Field-Level Lineage (PRODUCES_FIELD / CONSUMES_FIELD) ────────────────────
//
// Phase 2: contract participation edges from Function to specific DataField.
// Semantic: "this function produces/consumes a payload whose schema declares
// this field". NOT a claim that the function reads/writes the field in its
// body (real access analysis is future work).

const FIELDS_PER_PAYLOAD_DEFAULT_CAP = 50;

/**
 * Link a Function to the DataFields of a specific DataStructure it produces,
 * subject to a per-payload hard cap. Structure-anchored MATCH: only fields
 * that genuinely belong to `$structureUrn` via HAS_FIELD are linked, so
 * a caller passing foreign or stale `fieldUrns` cannot create cross-structure
 * edges.
 *
 * When the input exceeds `cap`, the PRODUCES edge gets `fieldsCapped=true`
 * stamped so the lineage gate's Path 2 fallback can activate for fields
 * beyond the cap. When the input is within the cap, the reset on PRODUCES
 * (in linkFunctionProducesSchema) leaves `fieldsCapped=false`.
 *
 * Returns the actual link count from Cypher (slice.length minus any rows
 * filtered out by `valid_to_commit IS NULL` / structure-membership), so
 * telemetry reflects what really hit the graph.
 */
export async function linkFunctionProducesFields(
    functionId: string,
    structureUrn: string,
    fieldUrns: string[],
    commitHash: string,
    opts: { cap?: number } = {},
): Promise<{ linked: number; capped: number }> {
    const cap = opts.cap ?? FIELDS_PER_PAYLOAD_DEFAULT_CAP;
    const capped = fieldUrns.length > cap ? fieldUrns.length - cap : 0;
    const slice = fieldUrns.slice(0, cap);

    if (capped > 0) {
        await run(
            `MATCH (f:Function {id: $functionId})-[r:PRODUCES]->(ds:DataStructure {id: $structureUrn})
             WHERE r.valid_to_commit IS NULL
               AND f.valid_to_commit IS NULL
               AND ds.valid_to_commit IS NULL
             SET r.fieldsCapped = true`,
            { functionId, structureUrn },
        );
    }

    if (slice.length === 0) return { linked: 0, capped };
    const result = await run(
        `UNWIND $fieldUrns AS fieldUrn
         MATCH (f:Function {id: $functionId})
         WHERE f.valid_to_commit IS NULL
         MATCH (ds:DataStructure {id: $structureUrn})-[hf:HAS_FIELD]->(df:DataField {id: fieldUrn})
         WHERE ds.valid_to_commit IS NULL
           AND hf.valid_to_commit IS NULL
           AND df.valid_to_commit IS NULL
         MERGE (f)-[r:PRODUCES_FIELD]->(df)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null
         RETURN count(r) AS linked`,
        { functionId, structureUrn, fieldUrns: slice, commitHash },
    );
    const linked = Number((result as any)?.records?.[0]?.get?.('linked') ?? 0);
    return { linked, capped };
}

/**
 * Symmetric counterpart to linkFunctionProducesFields, materialising
 * CONSUMES_FIELD edges. Stamps `fieldsCapped` on the CONSUMES edge.
 */
export async function linkFunctionConsumesFields(
    functionId: string,
    structureUrn: string,
    fieldUrns: string[],
    commitHash: string,
    opts: { cap?: number } = {},
): Promise<{ linked: number; capped: number }> {
    const cap = opts.cap ?? FIELDS_PER_PAYLOAD_DEFAULT_CAP;
    const capped = fieldUrns.length > cap ? fieldUrns.length - cap : 0;
    const slice = fieldUrns.slice(0, cap);

    if (capped > 0) {
        await run(
            `MATCH (f:Function {id: $functionId})-[r:CONSUMES]->(ds:DataStructure {id: $structureUrn})
             WHERE r.valid_to_commit IS NULL
               AND f.valid_to_commit IS NULL
               AND ds.valid_to_commit IS NULL
             SET r.fieldsCapped = true`,
            { functionId, structureUrn },
        );
    }

    if (slice.length === 0) return { linked: 0, capped };
    const result = await run(
        `UNWIND $fieldUrns AS fieldUrn
         MATCH (f:Function {id: $functionId})
         WHERE f.valid_to_commit IS NULL
         MATCH (ds:DataStructure {id: $structureUrn})-[hf:HAS_FIELD]->(df:DataField {id: fieldUrn})
         WHERE ds.valid_to_commit IS NULL
           AND hf.valid_to_commit IS NULL
           AND df.valid_to_commit IS NULL
         MERGE (f)-[r:CONSUMES_FIELD]->(df)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null
         RETURN count(r) AS linked`,
        { functionId, structureUrn, fieldUrns: slice, commitHash },
    );
    const linked = Number((result as any)?.records?.[0]?.get?.('linked') ?? 0);
    return { linked, capped };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dynamic Infrastructure Resolution
// ═══════════════════════════════════════════════════════════════════════════════

export interface DynamicInfraStub {
    id: string;
    name: string;
    type: 'DataContainer' | 'MessageChannel' | 'Cache' | 'ObjectStorage' | 'Datastore';
}

export async function getDynamicInfraStubs(): Promise<DynamicInfraStub[]> {
    const result = await run(
        `MATCH (n)
         WHERE (n:DataContainer OR n:MessageChannel OR n:Cache OR n:ObjectStorage OR n:Datastore)
           AND n.name CONTAINS '{' AND n.name CONTAINS '}'
         RETURN n.id AS id, n.name AS name, labels(n) AS labels`
    );
    
    return result.records.map((record: any) => {
        const labels = record.get('labels') as string[];
        const type = labels.find(l => ['DataContainer', 'MessageChannel', 'Cache', 'ObjectStorage', 'Datastore'].includes(l)) as any;
        return {
            id: record.get('id') as string,
            name: record.get('name') as string,
            type,
        };
    });
}

export async function getConcreteInfraNodes(nodeType: string): Promise<{ id: string; name: string }[]> {
    if (!['DataContainer', 'MessageChannel', 'Cache', 'ObjectStorage', 'Datastore'].includes(nodeType)) {
        throw new Error(`Invalid infrastructure type for concrete node matching: ${nodeType}`);
    }
    const result = await run(
        `MATCH (n:${nodeType})
         WHERE NOT (n.name CONTAINS '{' AND n.name CONTAINS '}')
         RETURN n.id AS id, n.name AS name`
    );
    return result.records.map((record: any) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
    }));
}

export async function rewireDynamicToConcrete(stubUrn: string, concreteUrns: string[], stubName: string, commitHash: string): Promise<void> {
    if (concreteUrns.length === 0) return;
    
    const edgeTypes = ['READS', 'WRITES', 'PUBLISHES_TO', 'LISTENS_TO', 'CONNECTS_TO'];
    
    // Copy inbound edges (Function -> Stub) to concrete targets
    for (const relType of edgeTypes) {
        await run(
            `MATCH (f)-[r:${relType}]->(stub {id: $stubUrn})
             UNWIND $concreteUrns AS targetUrn
             MATCH (target {id: targetUrn})
             MERGE (f)-[newR:${relType}]->(target)
     ON CREATE SET newR.valid_from_commit = $commitHash, newR.valid_to_commit = null
     ON MATCH SET newR.valid_from_commit = coalesce(newR.valid_from_commit, $commitHash), newR.valid_to_commit = null
     SET newR.dynamicResolutionContext = $stubName`,
        { stubUrn, concreteUrns, stubName , commitHash }
    );
    }
    

    // NOTE: STORED_IN is intentionally NOT propagated here.
    // It is a governance edge computed deterministically by selectDatastoreHint()
    // from coderadius.yaml. Concrete nodes receive their STORED_IN during their
    // own normal persistence cycle — inheriting it from a stub would bypass the
    // authoritative routing algorithm and risk applying an incorrect Datastore
    // (e.g. if coderadius.yaml maps order_events to Datastore B, but the stub
    // happened to point to Datastore A).
    

    // Delete the original stub, which removes all its stale relationships
    await run(
        `MATCH (stub {id: $stubUrn})
         DETACH DELETE stub`,
        { stubUrn , commitHash }
    );
}

export async function markDynamicStubUnresolved(stubUrn: string, commitHash: string): Promise<void> {
    await run(
        `MATCH (n {id: $stubUrn})
         SET n:UnresolvedDynamicNode, n.unresolved = true`,
        { stubUrn , commitHash }
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Schema ↔ Channel Post-Processor
//
// After all file chunks in a repo are processed, this runs once to link
// orphan MessageChannel nodes to their DataStructure via the canonical
// SourceFile → DEFINES_SCHEMA → DataStructure graph path.
//
// Two-pass strategy:
//   Pass 1 (deterministic): Channels with schemaPath set but no HAS_SCHEMA
//          → use the real file path to resolve via findDataStructureBySourceFile.
//          This handles race conditions where the .avsc structural pass wasn't
//          done when the graph-writer first persisted the channel.
//   Pass 2 (heuristic fallback): Channels without schemaPath → derive a
//          candidate .avsc filename from the channel name. Only applies to
//          dash-separated naming conventions (e.g. Prefix-SchemaName).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a MessageChannel name to a candidate .avsc filename.
 *
 * Convention: topics are sometimes named `{Prefix}-{SchemaName}` where
 * the last segment after the final `-` matches the Avro schema filename.
 *
 * This is a HEURISTIC FALLBACK — prefer schemaPath when available.
 *
 * Examples:
 *   - "Order-Save"              → "save.avsc"
 *   - "Order-ShipmentBundleV2"  → "shipmentBundleV2.avsc"
 *   - "save"                          → "save.avsc"
 *
 * Returns null if the name doesn't look like a schema-bearing topic.
 */
export function normalizeChannelToSchemaFilename(channelName: string): string | null {
    if (!channelName || channelName.includes('.')) return null; // dotted names are routing keys, not schema topics
    const segments = channelName.split('-');
    const lastSegment = segments[segments.length - 1];
    if (!lastSegment || lastSegment.length < 2) return null;
    // Lowercase first char to match Avro naming convention (Save → save, ShipmentBundleV2 → shipmentBundleV2)
    const normalized = lastSegment[0].toLowerCase() + lastSegment.slice(1);
    return `${normalized}.avsc`;
}

/**
 * Post-processing: infer and create HAS_SCHEMA relationships for orphan
 * MessageChannel nodes.
 *
 * Pass 1: Use the schemaPath already stored on the node (extracted by the
 *         LLM during ingestion). This is the deterministic path — it uses
 *         actual file paths, not heuristics.
 * Pass 2: Fall back to name normalization for channels without schemaPath.
 */
export async function inferAndLinkChannelSchemas(commitHash: string): Promise<number> {
    // Find all MessageChannels without HAS_SCHEMA
    const orphans = await run(
        `MATCH (ch:MessageChannel)
         WHERE ch.valid_to_commit IS NULL
           AND NOT (ch)-[:HAS_SCHEMA]->(:DataStructure)
         RETURN ch.id AS urn, ch.name AS name, ch.schemaPath AS schemaPath`,
        {},
    );

    let linked = 0;
    for (const record of orphans.records) {
        const channelUrn = record.get('urn') as string;
        const channelName = record.get('name') as string;
        const schemaPath = record.get('schemaPath') as string | null;

        // Pass 1: Use the actual schemaPath if present (deterministic)
        if (schemaPath) {
            const schemaUrn = await findDataStructureBySourceFile(schemaPath);
            if (schemaUrn) {
                await linkChannelToSchema(channelUrn, schemaUrn, commitHash);
                linked++;
                continue;
            }
        }

        // Pass 2: Heuristic fallback — derive candidate from channel name
        const candidate = normalizeChannelToSchemaFilename(channelName);
        if (!candidate) continue;

        const schemaUrn = await findDataStructureBySourceFile(candidate);
        if (!schemaUrn) continue;

        await linkChannelToSchema(channelUrn, schemaUrn, commitHash);
        linked++;
    }

    return linked;
}

/**
 * Link DataContainers to their `database_table` DataStructures via canonical
 * `HAS_SCHEMA` edges.
 *
 * Strategy: name-match is the *necessary* condition (DataStructure for a
 * `database_table` is keyed by the lowercased table name); we additionally
 * require **same-repo grounding** so cross-repo collisions on common table
 * names (`users`, `orders`, …) don't produce false welds.
 *
 * "Same repo" means: at least one `Service` whose `Function` READS/WRITES/MAPS_TO
 * the DataContainer is `STORED_IN` a Repository that ALSO `CONTAINS` (via
 * `SourceFile DEFINES_SCHEMA`) the DataStructure. If no such overlap exists
 * we deliberately leave the link missing — better empty than wrong, given
 * the downstream side-drawer renders these as authoritative schemas.
 */
export async function linkDataContainerSchemas(commitHash: string): Promise<{ linked: number }> {
    const result = await run(
        `MATCH (dc:DataContainer)
         WHERE dc.valid_to_commit IS NULL
         MATCH (ds:DataStructure {type: 'database_table'})
         WHERE ds.valid_to_commit IS NULL
           AND toLower(ds.name) = toLower(dc.name)
         // Repo accessing the container (via any Function-DC edge type)
         MATCH (svc:Service)-[svc_contains:CONTAINS]->(fn:Function)-[acc:READS|WRITES|MAPS_TO]->(dc)
         WHERE svc.valid_to_commit IS NULL
           AND svc_contains.valid_to_commit IS NULL
           AND fn.valid_to_commit IS NULL
           AND acc.valid_to_commit IS NULL
         MATCH (svc)-[svr:STORED_IN]->(repo:Repository)
         WHERE svr.valid_to_commit IS NULL AND repo.valid_to_commit IS NULL
         // Repo where the DataStructure is defined.
         // FIX: schema declares (Repository)-[:CONTAINS]->(SourceFile), not
         // (SourceFile)-[:STORED_IN]->(Repository). Inverted direction made the
         // query match zero rows pre-fix, so HAS_SCHEMA was never created.
         MATCH (sf:SourceFile)-[def:DEFINES_SCHEMA]->(ds)
         WHERE def.valid_to_commit IS NULL AND sf.valid_to_commit IS NULL
         MATCH (sfRepo:Repository)-[sfr:CONTAINS]->(sf)
         WHERE sfr.valid_to_commit IS NULL AND sfRepo.valid_to_commit IS NULL
           AND sfRepo.id = repo.id
         WITH DISTINCT dc, ds
         MERGE (dc)-[r:HAS_SCHEMA]->(ds)
         ON CREATE SET r.valid_from_commit = $commitHash, r.valid_to_commit = null
         ON MATCH SET r.valid_to_commit = null
         RETURN count(r) AS linked`,
        { commitHash },
    );
    const linked = result.records[0]?.get('linked');
    return { linked: typeof linked === 'number' ? linked : Number(linked ?? 0) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-service welding for DataContainer
//
// Welds DataContainer nodes that share the same physical endpoint fingerprint
// (computed by physical-fingerprint.ts) and the same logical name + schema +
// kind family. The "winner" is the lexicographically-smallest URN, making the
// pass deterministic and idempotent.
//
// Multi-tenant invariant:
//   - Both candidates MUST have a non-null physicalEndpointKey AND non-null
//     kindFamily — no fingerprint, no weld. We never invent a canonical.
//   - kindFamily must match (cannot weld a MySQL table with a Mongo collection
//     of the same name).
//   - schemaOrNs must match (Postgres safety: the same physical instance can
//     hold `app_main.public.users` and `app_main.audit.users` distinctly).
//   - confidence must be 'high' on both sides (template-resolved fingerprints
//     come from authoritative sources only).
//
// Edge handling:
//   - Inbound READS / WRITES / MAPS_TO are moved from loser to winner.
//   - The loser's STORED_IN edge target is preserved on the winner.
//   - The loser is tombstoned (valid_to_commit set, welded_into pointer).
// ═══════════════════════════════════════════════════════════════════════════════

export interface DataContainerWeldResult {
    weldedPairs: number;
    rewiredEdges: number;
    tombstoned: number;
    skippedAmbiguous: Array<{ name: string; key: string; urns: string[]; reason: string }>;
}

export async function weldDataContainersByEndpoint(
    commitHash: string,
): Promise<DataContainerWeldResult> {
    // Discovery: every (winner, loser) pair where they share fingerprint + name + ns + family.
    const pairsResult = await run(
        `MATCH (a:DataContainer), (b:DataContainer)
         WHERE a.id < b.id
           AND a.valid_to_commit IS NULL AND b.valid_to_commit IS NULL
           AND a.physicalEndpointKey IS NOT NULL
           AND a.physicalEndpointKey = b.physicalEndpointKey
           AND a.kindFamily IS NOT NULL AND b.kindFamily IS NOT NULL
           AND a.kindFamily = b.kindFamily
           AND toLower(a.name) = toLower(b.name)
           AND coalesce(a.schemaOrNs,'') = coalesce(b.schemaOrNs,'')
           AND coalesce(a.physicalEndpointConfidence,'high') = 'high'
           AND coalesce(b.physicalEndpointConfidence,'high') = 'high'
         RETURN a.id AS winnerId, b.id AS loserId,
                a.name AS name, a.physicalEndpointKey AS key`,
    );

    let weldedPairs = 0;
    let rewiredEdges = 0;
    let tombstoned = 0;
    const skippedAmbiguous: DataContainerWeldResult['skippedAmbiguous'] = [];

    // Group by winner — when one winner has many losers we still process them
    // independently. The graph-level `a.id < b.id` filter ensures we never
    // double-process the same pair on re-run (idempotent).
    for (const rec of pairsResult.records) {
        const winnerId = rec.get('winnerId') as string;
        const loserId = rec.get('loserId') as string;

        // Move inbound READS / WRITES / MAPS_TO from loser to winner.
        const moveTypes = ['READS', 'WRITES', 'MAPS_TO'];
        for (const rt of moveTypes) {
            const moveResult = await run(
                `MATCH (f)-[r:${rt}]->(loser:DataContainer {id: $loserId})
                 WHERE r.valid_to_commit IS NULL
                 MATCH (winner:DataContainer {id: $winnerId})
                 MERGE (f)-[nr:${rt}]->(winner)
                 ON CREATE SET nr.valid_from_commit = coalesce(r.valid_from_commit, $commitHash),
                               nr.valid_to_commit = null,
                               nr.welded_from = $loserId
                 ON MATCH SET nr.valid_to_commit = null,
                              nr.welded_from = coalesce(nr.welded_from, $loserId)
                 DELETE r
                 RETURN count(f) AS moved`,
                { loserId, winnerId, commitHash },
            );
            rewiredEdges += Number(moveResult.records[0]?.get('moved') ?? 0);
        }

        // Preserve the loser's STORED_IN target on the winner.
        await run(
            `MATCH (loser:DataContainer {id: $loserId})-[s:STORED_IN]->(d:Datastore)
             WHERE s.valid_to_commit IS NULL
             MATCH (winner:DataContainer {id: $winnerId})
             MERGE (winner)-[ns:STORED_IN]->(d)
             ON CREATE SET ns.valid_from_commit = $commitHash, ns.valid_to_commit = null
             ON MATCH SET ns.valid_to_commit = null
             DELETE s`,
            { loserId, winnerId, commitHash },
        );

        // Tombstone the loser.
        await run(
            `MATCH (loser:DataContainer {id: $loserId})
             SET loser.valid_to_commit = $commitHash, loser.welded_into = $winnerId`,
            { loserId, winnerId, commitHash },
        );
        tombstoned++;
        weldedPairs++;
    }

    return { weldedPairs, rewiredEdges, tombstoned, skippedAmbiguous };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup pass: prune incompatible STORED_IN edges
//
// `linkDataContainerStoredIn` is additive (MERGE-only), so any false binding
// produced by an earlier ingest stays in the graph forever — even after the
// `kindFamily` gate in `resolveDatastoreBinding` was added to refuse new ones.
// This mutation removes the legacy mistakes:
//
//   - Walks every active `(dc:DataContainer)-[r:STORED_IN]->(ds:Datastore)`.
//   - When `dc.kindFamily` and `ds.technology` are both known and belong to
//     incompatible families (e.g. an `@ORM\Table` rdbms entity wired to a
//     mongodb Datastore), tombstones the edge with `r.valid_to_commit`.
//   - Optionally clears `dc.technology` when a DC ends up with zero active
//     STORED_IN edges, so the stale "technology=mongodb" badge stamped by
//     the original wrong binding stops appearing in the dashboard.
//
// Anti-drift design: the (family ↔ tech) knowledge lives ONLY in
// `db-scope-resolver.ts:familyForTechnology`. This mutation builds the
// per-family incompatibility list at run-time by inverting that helper over
// `ALL_KNOWN_TECHS`, and passes it to Cypher as a `$rules` parameter. There
// is no hardcoded family/tech mapping anywhere in this file.
//
// Idempotent (re-runs are no-ops because tombstoned edges fail the
// `valid_to_commit IS NULL` predicate).
// ═══════════════════════════════════════════════════════════════════════════════

export interface DataContainerPruneResult {
    /** Number of (DataContainer)-[:STORED_IN]->(Datastore) edges tombstoned. */
    pruned: number;
    /** Number of DataContainer nodes whose stale `technology` field was cleared. */
    cleared: number;
}

interface PruneRule {
    family: KindFamily;
    incompatibleTechs: string[];
}

/**
 * Build the run-time incompatibility map from `familyForTechnology`. Two
 * technologies are incompatible iff they map to different non-null families.
 * Tech names that don't resolve to any family are skipped (treated as opaque,
 * not classified as incompatible — fail-safe).
 */
function buildPruneRules(): PruneRule[] {
    return ALL_KIND_FAMILIES.map(family => ({
        family,
        incompatibleTechs: ALL_KNOWN_TECHS.filter(tech => {
            const techFamily = familyForTechnology(tech);
            return techFamily !== null && techFamily !== family;
        }),
    }));
}

export async function pruneIncompatibleStoredInEdges(
    commitHash: string,
): Promise<DataContainerPruneResult> {
    const rules = buildPruneRules();

    // Step 1: tombstone STORED_IN edges where DC kindFamily is incompatible
    // with the bound Datastore technology. Iterate the rule set per family
    // via UNWIND so the Cypher itself contains zero hardcoded tech names.
    const pruneResult = await run(
        `UNWIND $rules AS rule
         MATCH (dc:DataContainer {kindFamily: rule.family})-[r:STORED_IN]->(ds:Datastore)
         WHERE r.valid_to_commit IS NULL
           AND dc.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
           AND ds.technology IN rule.incompatibleTechs
         SET r.valid_to_commit = $commitHash,
             r.prunedReason = 'kindFamily-mismatch'
         RETURN count(r) AS pruned`,
        { rules, commitHash },
    );
    const pruned = Number(pruneResult.records[0]?.get('pruned') ?? 0);

    // Step 2: clear `dc.technology` for any DC that has no active STORED_IN
    // remaining. This wipes the legacy stale stamp (e.g. `technology='mongodb'`
    // on a Doctrine entity that is no longer attached to any Datastore) so
    // the dashboard stops painting the wrong badge.
    const clearResult = await run(
        `MATCH (dc:DataContainer)
         WHERE dc.valid_to_commit IS NULL
           AND dc.kindFamily IS NOT NULL
           AND dc.technology IS NOT NULL
           AND NOT EXISTS {
             MATCH (dc)-[r2:STORED_IN]->(:Datastore)
             WHERE r2.valid_to_commit IS NULL
           }
         SET dc.technology = null
         RETURN count(dc) AS cleared`,
        {},
    );
    const cleared = Number(clearResult.records[0]?.get('cleared') ?? 0);

    return { pruned, cleared };
}

/**
 * Drop DataContainers that merely echo a Datastore's own name.
 *
 * The LLM extracts a database SELECTION (e.g. `selectDatabase('archive')` in DI
 * / container-builder config) as if it were a collection, producing a self-echo:
 *   (:DataContainer{name:'archive'})-[:STORED_IN]->(:Datastore{name:'archive'})
 * The database identity already IS the Datastore; the duplicate container is a
 * false node (the sanitizer can't catch it — it has no datastore identity).
 * This structural reconciliation runs post-ingest, where both sides exist.
 *
 * Hard-deletes the node (it was never a valid container), mirroring
 * `gcOrphanUnresolvedDependencies`. Language-agnostic, no hardcoded names: the
 * predicate is purely `container.name == a Datastore it is STORED_IN`. A
 * container deleted via one echo edge takes all its edges with it (the
 * observed field shape: one 'archive' container stored in both 'archive' and
 * 'integration-hub'). A collection legitimately named the same as its OWN
 * datastore is treated as an echo (pathological; the datastore carries the name).
 */
export async function pruneDatastoreNameEchoContainers(): Promise<number> {
    const result = await run(
        `MATCH (dc:DataContainer)-[r:STORED_IN]->(ds:Datastore)
         WHERE r.valid_to_commit IS NULL
           AND dc.valid_to_commit IS NULL
           AND ds.valid_to_commit IS NULL
           AND toLower(dc.name) = toLower(ds.name)
         WITH DISTINCT dc, dc.id AS dcid
         DETACH DELETE dc
         RETURN count(dcid) AS removed`,
        {},
    );
    return Number(result.records[0]?.get('removed') ?? 0);
}
