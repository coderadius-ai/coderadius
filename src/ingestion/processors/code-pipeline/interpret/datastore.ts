/**
 * interpretDatastore — pure interpreter for the `Database` infra kind.
 *
 * Extracted from persistFunction's Database case in graph-writer.ts: given one
 * LLM/static infrastructure item plus the resolution context, it DECIDES which
 * graph facts the item implies and returns them as a GraphDelta — no I/O, no
 * Cypher. The applier (GraphStore) executes the delta; trace events travel as
 * data so the caller can forward them to the trace collector.
 *
 * The decisions preserved verbatim from the inline path:
 *   - placeholder names (`<DYNAMIC>`, unresolved templates) bind the function
 *     to ALL candidate Datastores conservatively, with no DataContainer;
 *   - system database names (mongo `admin`, `information_schema`, …) are
 *     dropped with a DROP trace;
 *   - tied multi-candidate bindings (`env-canonical-default`) write STORED_IN
 *     to ALL candidates as `ambiguous-multi-candidate` and flag the container
 *     `needsReview` — an honest ambiguity instead of a confident wrong answer;
 *   - DataContainer `kindFamily` / `technology` are first-non-null-wins
 *     (`propsIfMissing`) so a structural extractor's stamp is never clobbered
 *     by a later LLM-derived binding;
 *   - grounding precedence: explicit `infra.grounding` (DI bypass) > AST
 *     (connection-string binding) > LLM default, composite on agreement.
 */
import { buildUrn } from '../../../../graph/urn.js';
import {
    astGrounding,
    compositeGrounding,
    llmGrounding,
    type GroundingFields,
} from '../../../../graph/grounding.js';
import {
    emptyDelta,
    mergeDeltas,
    type EdgeUpsert,
    type GraphDelta,
    type NodeRef,
    type NodeUpsert,
    type PropRecord,
} from '../../../../graph/write-model/delta.js';
import type { RepoHints } from '../../../../config/repo-hints.js';
import { isUnresolvedTemplateName, SYSTEM_DATABASE_NAMES } from '../../../../ai/workflows/sanitizer.js';
import {
    computeEndpointKey,
    inferDatastoreFromEnvVars,
    resolveContainerScope,
    resolveDatastoreBinding,
    type DatastoreBinding,
    type DatastoreIdentity,
    type KindFamily,
} from '../../db-scope-resolver.js';
import { buildPhysicalEndpoint, canonicalizeTechnology, familyFor } from '../../physical-fingerprint.js';
import type { DataContainerWeldingHints } from '../../../../graph/mutations/data-contracts.js';
import { groundingForInfra, type InfraWithGrounding } from './infra-grounding.js';
import type { InterpretLog, PersistTrace } from './types.js';

export interface DatabaseInfraItem {
    name: string;
    operation: 'READS' | 'WRITES' | 'MAPS_TO';
    /** Coarse family signal from the static extractor (Doctrine → rdbms, …). */
    kindFamily?: KindFamily;
    /** LLM technology hint — family fallback when no explicit kindFamily. */
    technology?: string;
    /** Explicit grounding from the DI-bypass path; wins over all defaults. */
    grounding?: GroundingFields;
}

export interface DatastoreInterpretContext {
    functionId: string;
    qualifiedRepoName: string;
    commitHash: string;
    repoHints: RepoHints;
    identities?: readonly DatastoreIdentity[];
    /** Uppercased env-var names observed in the function chunk. */
    envVarNames: string[];
    allowPlainTextHosts: boolean;
}

export type { PersistTrace } from './types.js';

export interface InterpretOutcome {
    delta: GraphDelta;
    traces: PersistTrace[];
    logs?: InterpretLog[];
}

/**
 * Shared binding-grounding precedence: a connection-string binding is a
 * deterministic AST fact; anything else inherits the LLM tier.
 */
export function bindingGrounding(binding: Pick<DatastoreBinding, 'bindingSource'>): GroundingFields {
    return binding.bindingSource === 'connection_string'
        ? astGrounding('connection-extractor@v1')
        : llmGrounding('unified-analyzer', 'graph-writer@v1');
}

export function interpretDatastore(item: DatabaseInfraItem, ctx: DatastoreInterpretContext): InterpretOutcome {
    const family = effectiveKindFamily(item);
    if (isPlaceholderDatabaseName(item.name)) return interpretPlaceholderDatabase(item, family, ctx);
    return interpretNamedDatabase(item, family, ctx);
}

function effectiveKindFamily(item: DatabaseInfraItem): KindFamily | undefined {
    if (item.kindFamily) return item.kindFamily;
    if (!item.technology) return undefined;
    const family = familyFor(canonicalizeTechnology(item.technology));
    return family === 'rdbms' || family === 'document' || family === 'kv' ? family : undefined;
}

function isPlaceholderDatabaseName(name: string): boolean {
    return name === '<DYNAMIC>' || /unknown|placeholder/i.test(name) || isUnresolvedTemplateName(name);
}

function resolveBindings(name: string | null, family: KindFamily | undefined, ctx: DatastoreInterpretContext): DatastoreBinding[] {
    const envVarHint = inferDatastoreFromEnvVars(ctx.envVarNames);
    return resolveDatastoreBinding(name, 'Database', ctx.repoHints, envVarHint, ctx.identities, family);
}

function fnRef(ctx: DatastoreInterpretContext): NodeRef {
    return { label: 'Function', urn: ctx.functionId };
}

function revivalEdge(
    type: string,
    from: NodeRef,
    to: NodeRef,
    commitHash: string,
    grounding: GroundingFields,
    props: PropRecord = {},
): EdgeUpsert {
    return {
        type,
        from,
        to,
        propsOnce: { valid_from_commit: commitHash },
        props: { valid_to_commit: null, ...props },
        grounding,
    };
}

/**
 * Context needed to materialise a Datastore node + its physical endpoints,
 * independent of any function. `DatastoreInterpretContext` is a superset.
 */
export interface DatastoreNodeContext {
    qualifiedRepoName: string;
    commitHash: string;
    allowPlainTextHosts: boolean;
}

/**
 * The function-INDEPENDENT Datastore facts: the logical Datastore node and its
 * physical DatabaseEndpoint variants (paradigm A). No CONNECTS_TO — the caller
 * adds it when a function is in scope. Reused by the standalone-promotion path
 * (reconcile), which materialises datastores whose only I/O function was
 * dropped by the taint gate and therefore never reached the per-function loop.
 */
export function datastoreNodeFacts(
    binding: DatastoreBinding,
    ctx: DatastoreNodeContext,
    grounding: GroundingFields,
): { dsUrn: string; delta: GraphDelta } {
    const namespace = binding.shared ? 'shared' : ctx.qualifiedRepoName;
    const dsUrn = buildUrn('datastore', namespace, binding.datastoreId);
    const delta = emptyDelta();
    delta.nodes.push({
        label: 'Datastore',
        urn: dsUrn,
        propsOnce: { name: binding.datastoreId, namespace, valid_from_commit: ctx.commitHash },
        props: { valid_to_commit: null, ...(binding.technology ? { technology: binding.technology } : {}) },
        grounding,
    });
    appendEndpointFacts(delta, dsUrn, binding, ctx);
    return { dsUrn, delta };
}

/**
 * Facts shared by every candidate binding: the logical Datastore node, its
 * physical DatabaseEndpoint variants (paradigm A), and the conservative
 * function→Datastore CONNECTS_TO for blast-radius.
 *
 * `opts.grounding` overrides the binding-derived grounding (Cache parity:
 * explicit DI-bypass grounding wins).
 */
function datastoreFacts(
    binding: DatastoreBinding,
    ctx: DatastoreInterpretContext,
    opts: { grounding?: GroundingFields } = {},
): { dsUrn: string; delta: GraphDelta } {
    const ground = opts.grounding ?? bindingGrounding(binding);
    const { dsUrn, delta } = datastoreNodeFacts(binding, ctx, ground);
    delta.edges.push(revivalEdge('CONNECTS_TO', fnRef(ctx), { label: 'Datastore', urn: dsUrn }, ctx.commitHash, ground));
    return { dsUrn, delta };
}

function appendEndpointFacts(delta: GraphDelta, dsUrn: string, binding: DatastoreBinding, ctx: Pick<DatastoreNodeContext, 'commitHash' | 'allowPlainTextHosts'>): void {
    for (const env of binding.environments ?? []) {
        if (!env.host || !env.port || !env.dbName) continue;
        const endpointKey = computeEndpointKey(env.host, env.port, env.dbName);
        const epUrn = buildUrn('dbendpoint', endpointKey, env.environment);
        const ground = astGrounding('connection-extractor@v1');
        delta.nodes.push({
            label: 'DatabaseEndpoint',
            urn: epUrn,
            propsOnce: { endpointKey, environment: env.environment, dbName: env.dbName, valid_from_commit: ctx.commitHash },
            props: {
                valid_to_commit: null,
                technology: binding.technology,
                ...(ctx.allowPlainTextHosts && env.host ? { host: env.host } : {}),
                port: env.port,
            },
            grounding: ground,
        });
        delta.edges.push(revivalEdge('SERVED_BY', { label: 'Datastore', urn: dsUrn }, { label: 'DatabaseEndpoint', urn: epUrn }, ctx.commitHash, ground));
    }
}

/**
 * Placeholder path: the LLM could not resolve a concrete container name, so
 * the function is bound to ALL candidate Datastores (worst-case blast radius)
 * and no DataContainer is asserted.
 */
function interpretPlaceholderDatabase(
    _item: DatabaseInfraItem,
    family: KindFamily | undefined,
    ctx: DatastoreInterpretContext,
): InterpretOutcome {
    const bindings = resolveBindings(null, family, ctx);
    const delta = mergeDeltas(...bindings.map(b => datastoreFacts(b, ctx).delta));
    return { delta, traces: [] };
}

function interpretNamedDatabase(
    item: DatabaseInfraItem,
    family: KindFamily | undefined,
    ctx: DatastoreInterpretContext,
): InterpretOutcome {
    const traces: PersistTrace[] = [];
    const { scope: dbScope, scopeSource } = resolveContainerScope(item.name, ctx.qualifiedRepoName, ctx.repoHints);
    const databaseNameHint = dbScope !== ctx.qualifiedRepoName ? dbScope : undefined;
    const bindings = resolveBindings(item.name, family, ctx);

    const delta = emptyDelta();
    const dsUrns: string[] = [];
    for (const binding of bindings) {
        if (SYSTEM_DATABASE_NAMES.has(binding.datastoreId.toLowerCase())) {
            traces.push({
                action: 'DROP',
                target: `datastore:${binding.datastoreId}`,
                reason: 'system database denylist (datastore interpreter)',
            });
            continue;
        }
        const facts = datastoreFacts(binding, ctx);
        dsUrns.push(facts.dsUrn);
        delta.nodes.push(...facts.delta.nodes);
        delta.edges.push(...facts.delta.edges);
    }

    const primary: DatastoreBinding | undefined = bindings[0];
    const welding = buildWeldingHints(family, primary, dsUrns[0]);
    const ambiguous = primary?.bindingReason === 'env-canonical-default' && dsUrns.length > 1;
    const dcProv = dataContainerGrounding(item, primary, ambiguous);

    const dc = dataContainerNode(item.name, ctx, dbScope, scopeSource, databaseNameHint, welding, dcProv);
    delta.nodes.push(dc);
    const dcRef: NodeRef = { label: 'DataContainer', urn: dc.urn };
    delta.edges.push(revivalEdge(operationEdgeType(item.operation), fnRef(ctx), dcRef, ctx.commitHash, dcProv));
    appendStoredIn(delta, dcRef, dsUrns, primary, ambiguous, ctx);

    traces.push({
        action: 'WRITE',
        target: `datacontainer:${item.name}`,
        reason: 'DataContainer merged',
        meta: {
            functionId: ctx.functionId,
            operation: item.operation,
            dbScope,
            databaseNameHint,
            scopeSource,
            fingerprint: welding?.physicalEndpointKey,
        },
    });
    return { delta, traces };
}

function operationEdgeType(operation: DatabaseInfraItem['operation']): string {
    if (operation === 'WRITES') return 'WRITES';
    if (operation === 'MAPS_TO') return 'MAPS_TO';
    return 'READS';
}

function dataContainerGrounding(
    item: DatabaseInfraItem,
    primary: DatastoreBinding | undefined,
    ambiguous: boolean,
): GroundingFields {
    let prov = item.grounding ?? defaultDataContainerGrounding(primary);
    if (ambiguous) prov = { ...prov, needsReview: true };
    return prov;
}

function defaultDataContainerGrounding(primary: DatastoreBinding | undefined): GroundingFields {
    const prov = llmGrounding('unified-analyzer', 'graph-writer@v1');
    return primary?.bindingSource === 'connection_string'
        ? compositeGrounding(prov, astGrounding('connection-extractor@v1'))
        : prov;
}

function isContainerFamily(family: string | null | undefined): family is 'rdbms' | 'document' | 'kv' {
    return family === 'rdbms' || family === 'document' || family === 'kv';
}

function buildWeldingHints(
    family: KindFamily | undefined,
    primary: DatastoreBinding | undefined,
    dsUrn: string | undefined,
): DataContainerWeldingHints | undefined {
    let hints: DataContainerWeldingHints | undefined;
    if (family && family !== 'timeseries') hints = { kindFamily: family as DataContainerWeldingHints['kindFamily'] };
    if (!primary) return hints;

    const tech = canonicalizeTechnology(primary.technology);
    const techFamily = familyFor(tech);
    const bindingHints: DataContainerWeldingHints = {
        technology: tech,
        kindFamily: isContainerFamily(techFamily) ? techFamily : hints?.kindFamily,
        datastoreUrn: dsUrn,
        physicalEndpointConfidence: primary.bindingSource === 'connection_string' ? 'high' : 'medium',
    };
    if (primary._rawConnHint && primary.endpointKey) {
        const ep = buildPhysicalEndpoint({
            technology: primary._rawConnHint.technology,
            host: primary._rawConnHint.host,
            port: primary._rawConnHint.port,
            logicalName: primary._rawConnHint.dbName,
        });
        if (ep) {
            bindingHints.physicalEndpointKey = ep.fingerprint;
            bindingHints.kindFamily = isContainerFamily(ep.family) ? ep.family : bindingHints.kindFamily;
        }
    }
    return { ...hints, ...bindingHints };
}

function dataContainerNode(
    name: string,
    ctx: DatastoreInterpretContext,
    dbScope: string,
    scopeSource: 'manual_override' | 'repo_fallback' | undefined,
    databaseNameHint: string | undefined,
    welding: DataContainerWeldingHints | undefined,
    grounding: GroundingFields,
): NodeUpsert {
    const propsIfMissing: PropRecord = {};
    if (databaseNameHint) propsIfMissing.databaseName = databaseNameHint;
    if (welding?.kindFamily) propsIfMissing.kindFamily = welding.kindFamily;
    if (welding?.technology) propsIfMissing.technology = welding.technology;
    if (dbScope !== ctx.qualifiedRepoName) propsIfMissing.sourceRepo = ctx.qualifiedRepoName;

    const props: PropRecord = { valid_to_commit: null };
    if (welding?.physicalEndpointKey) props.physicalEndpointKey = welding.physicalEndpointKey;
    if (welding?.schemaOrNs) props.schemaOrNs = welding.schemaOrNs;
    if (welding?.datastoreUrn) props.datastoreUrn = welding.datastoreUrn;
    if (welding?.physicalEndpointConfidence) props.physicalEndpointConfidence = welding.physicalEndpointConfidence;

    return {
        label: 'DataContainer',
        urn: buildUrn('datacontainer', dbScope, name),
        propsOnce: {
            name,
            scope: dbScope,
            scopeSource: scopeSource ?? 'repo_fallback',
            sourceRepo: ctx.qualifiedRepoName,
            valid_from_commit: ctx.commitHash,
        },
        props,
        ...(Object.keys(propsIfMissing).length > 0 ? { propsIfMissing } : {}),
        grounding,
    };
}

/**
 * Cache kind: P0 yaml binding, else auto-promote discovered kv identities
 * (redis/memcached) like the Database path does for rdbms. Multiple kv
 * identities → link the function to each (conservative blast-radius).
 * No DataContainer: a cache is the store itself, not a named container.
 */
export function interpretCache(item: InfraWithGrounding & { name: string }, ctx: DatastoreInterpretContext): InterpretOutcome {
    const bindings = resolveDatastoreBinding(null, 'Cache', ctx.repoHints, null, ctx.identities);
    const delta = mergeDeltas(
        ...bindings.map(b => datastoreFacts(b, ctx, { grounding: item.grounding }).delta),
    );
    return { delta, traces: [] };
}

/**
 * ObjectStorage kind. Three branches preserved from the inline case:
 *   - placeholder bucket name → bind to the FIRST yaml-configured object
 *     datastore only (no DataContainer; nothing when unconfigured — POC);
 *   - bucket with an intrinsic object technology (sanitizer cloud-object
 *     repair: gcs/s3) → DataContainer + ONE object Datastore per
 *     (namespace, tech) synthesized BY TECHNOLOGY, STORED_IN autopromoted;
 *   - otherwise → DataContainer, plus STORED_IN only when exactly one yaml
 *     binding resolves.
 */
export function interpretObjectStorage(
    item: InfraWithGrounding & { name: string; operation: 'READS' | 'WRITES' | 'MAPS_TO'; technology?: string },
    ctx: DatastoreInterpretContext,
): InterpretOutcome {
    if (isPlaceholderDatabaseName(item.name)) {
        const bindings = resolveDatastoreBinding(null, 'ObjectStorage', ctx.repoHints, null, ctx.identities);
        if (bindings.length === 0) return { delta: emptyDelta(), traces: [] };
        return { delta: datastoreFacts(bindings[0], ctx).delta, traces: [] };
    }

    const { scope: bucketScope, scopeSource } = resolveContainerScope(item.name, ctx.qualifiedRepoName, ctx.repoHints);
    const bucketNameHint = bucketScope !== ctx.qualifiedRepoName ? bucketScope : undefined;

    // A bucket carries an explicit object technology (sanitizer cloud-object
    // repair). Connection-string binding never resolves buckets, so the
    // object Datastore is synthesized BY TECHNOLOGY (the store's identity).
    const objTech = item.technology ? canonicalizeTechnology(item.technology) : undefined;
    const isObjectInfra = !!objTech && familyFor(objTech) === 'object';
    const bucketWelding: DataContainerWeldingHints | undefined = isObjectInfra
        ? { kindFamily: 'object', technology: objTech }
        : undefined;
    const prov = groundingForInfra(item, 'graph-writer@v1');

    const delta = emptyDelta();
    const dc = dataContainerNode(item.name, ctx, bucketScope, scopeSource, bucketNameHint, bucketWelding, prov);
    delta.nodes.push(dc);
    const dcRef: NodeRef = { label: 'DataContainer', urn: dc.urn };
    delta.edges.push(revivalEdge(operationEdgeType(item.operation), fnRef(ctx), dcRef, ctx.commitHash, prov));
    const traces: PersistTrace[] = [{
        action: 'WRITE',
        target: `datacontainer:${item.name}`,
        reason: 'DataContainer merged (ObjectStorage)',
        meta: { functionId: ctx.functionId, operation: item.operation, bucketScope, bucketNameHint, scopeSource },
    }];

    if (isObjectInfra && objTech) {
        // Promote ONE object Datastore per (namespace, object-tech),
        // idempotent on the URN. STORED_IN attaches the bucket.
        const dsUrn = buildUrn('datastore', ctx.qualifiedRepoName, objTech);
        delta.nodes.push({
            label: 'Datastore',
            urn: dsUrn,
            propsOnce: { name: objTech, namespace: ctx.qualifiedRepoName, valid_from_commit: ctx.commitHash },
            props: { valid_to_commit: null, technology: objTech },
            grounding: prov,
        });
        const dsRef: NodeRef = { label: 'Datastore', urn: dsUrn };
        delta.edges.push(revivalEdge('STORED_IN', dcRef, dsRef, ctx.commitHash, prov, { bindingReason: 'object-tech-autopromote' }));
        delta.edges.push(revivalEdge('CONNECTS_TO', fnRef(ctx), dsRef, ctx.commitHash, prov));
        return { delta, traces };
    }

    // Fallback: P0 yaml-configured object datastore (no intrinsic tech).
    const bindings = resolveDatastoreBinding(item.name, 'ObjectStorage', ctx.repoHints, null, ctx.identities);
    if (bindings.length === 1) {
        const facts = datastoreFacts(bindings[0], ctx, { grounding: item.grounding });
        delta.nodes.push(...facts.delta.nodes);
        delta.edges.push(...facts.delta.edges);
        const storedInProv = item.grounding ?? bindingGrounding(bindings[0]);
        delta.edges.push(revivalEdge('STORED_IN', dcRef, { label: 'Datastore', urn: facts.dsUrn }, ctx.commitHash, storedInProv, { bindingReason: bindings[0].bindingReason }));
    }
    return { delta, traces };
}

/** Fields consumed from `core/languages/types.ts` ResourceDeclaration. */
export interface ResourceDeclarationItem {
    logicalId: string;
    technology: string;
    configuredVia?: string[];
    endpointKey?: string;
    dbName?: string;
    host?: string;
    port?: number;
    declarationSource?: string;
}

/**
 * Deterministic resource declarations from structural plugins (Helm,
 * Terraform manifests, NestJS forRoot): Datastore + CONNECTS_TO +
 * CONFIGURED_VIA, plus the physical endpoint (environment 'unknown' — these
 * manifests carry no environment marker) when a stable key exists.
 *
 * The CONFIGURED_VIA edges resolve against EnvVar nodes from the SAME
 * single-transaction apply (nodes before edges), fixing the inline-path gap
 * where the link ran before the function's own EnvVar nodes were merged.
 */
export function interpretResourceDeclarations(
    declarations: ResourceDeclarationItem[],
    ctx: DatastoreInterpretContext,
): InterpretOutcome {
    const delta = emptyDelta();
    const traces: PersistTrace[] = [];
    const logs: InterpretLog[] = [];

    for (const declaration of declarations) {
        if (SYSTEM_DATABASE_NAMES.has(declaration.logicalId.toLowerCase())) {
            logs.push({ level: 'debug', message: `Skipped system database ResourceDeclaration: "${declaration.logicalId}"` });
            continue;
        }
        const prov = astGrounding('resource-declaration@v1');
        const dsUrn = buildUrn('datastore', ctx.qualifiedRepoName, declaration.logicalId);
        const dsRef: NodeRef = { label: 'Datastore', urn: dsUrn };
        delta.nodes.push({
            label: 'Datastore',
            urn: dsUrn,
            propsOnce: { name: declaration.logicalId, namespace: ctx.qualifiedRepoName, valid_from_commit: ctx.commitHash },
            props: { valid_to_commit: null, technology: declaration.technology },
            grounding: prov,
        });
        delta.edges.push(revivalEdge('CONNECTS_TO', fnRef(ctx), dsRef, ctx.commitHash, prov));
        for (const envVar of declaration.configuredVia ?? []) {
            delta.edges.push(revivalEdge('CONFIGURED_VIA', dsRef, { label: 'EnvVar', urn: buildUrn('envvar', envVar) }, ctx.commitHash, prov));
        }
        if (declaration.endpointKey && declaration.dbName) {
            const epUrn = buildUrn('dbendpoint', declaration.endpointKey, 'unknown');
            delta.nodes.push({
                label: 'DatabaseEndpoint',
                urn: epUrn,
                propsOnce: { endpointKey: declaration.endpointKey, environment: 'unknown', dbName: declaration.dbName, valid_from_commit: ctx.commitHash },
                props: {
                    valid_to_commit: null,
                    technology: declaration.technology,
                    ...(ctx.allowPlainTextHosts && declaration.host ? { host: declaration.host } : {}),
                    ...(declaration.port != null ? { port: declaration.port } : {}),
                },
                grounding: prov,
            });
            delta.edges.push(revivalEdge('SERVED_BY', dsRef, { label: 'DatabaseEndpoint', urn: epUrn }, ctx.commitHash, prov));
        }
        traces.push({
            action: 'WRITE',
            target: `datastore:${declaration.logicalId}`,
            reason: 'deterministic datastore declaration merged',
            meta: {
                technology: declaration.technology,
                declarationSource: declaration.declarationSource,
                endpointKey: declaration.endpointKey,
            },
        });
    }
    return { delta, traces, logs };
}

function appendStoredIn(
    delta: GraphDelta,
    dcRef: NodeRef,
    dsUrns: string[],
    primary: DatastoreBinding | undefined,
    ambiguous: boolean,
    ctx: DatastoreInterpretContext,
): void {
    if (!primary || dsUrns.length === 0) return;
    const ground = bindingGrounding(primary);
    const dsRef = (urn: string): NodeRef => ({ label: 'Datastore', urn });
    if (ambiguous) {
        for (const urn of dsUrns) {
            delta.edges.push(revivalEdge('STORED_IN', dcRef, dsRef(urn), ctx.commitHash, ground, { bindingReason: 'ambiguous-multi-candidate' }));
        }
        return;
    }
    delta.edges.push(revivalEdge('STORED_IN', dcRef, dsRef(dsUrns[0]), ctx.commitHash, ground, { bindingReason: primary.bindingReason }));
}
