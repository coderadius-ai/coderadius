import { describe, it, expect } from 'vitest';
import {
    interpretDatastore,
    interpretCache,
    interpretObjectStorage,
    type DatabaseInfraItem,
    type DatastoreInterpretContext,
} from '../../../src/ingestion/processors/code-pipeline/interpret/datastore.js';
import { buildUrn } from '../../../src/graph/urn.js';
import { computeEndpointKey, type DatastoreIdentity } from '../../../src/ingestion/processors/db-scope-resolver.js';
import { buildPhysicalEndpoint } from '../../../src/ingestion/processors/physical-fingerprint.js';
import type { GraphDelta, NodeUpsert, EdgeUpsert } from '../../../src/graph/write-model/delta.js';

// interpretDatastore PINS the decision logic extracted from
// persistFunction's Database case. Every assertion below encodes the behaviour
// of the pre-refactor graph-writer path (grounding precedence, ambiguity
// handling, welding hints, system-db denylist, placeholder binding) so the
// switch from inline mutations to GraphDelta is observable-equivalent.

const QUALIFIED = 'acme/inventory';
const COMMIT = 'commit-test-1';
const FN_ID = 'acme/inventory:src/orders.php:saveOrder';

function identity(over: Partial<DatastoreIdentity> = {}): DatastoreIdentity {
    return {
        identityKey: 'orders',
        canonicalHint: {
            dbName: 'orders',
            technology: 'mysql',
            host: 'orders-prod.internal',
            port: 3306,
            sourceFile: 'helm/values.yaml',
            confidence: 'high',
        },
        environments: [
            { environment: 'production', host: 'orders-prod.internal', port: 3306, dbName: 'orders', sourceFile: 'helm/values.yaml' },
        ],
        ...over,
    } as DatastoreIdentity;
}

function ctx(over: Partial<DatastoreInterpretContext> = {}): DatastoreInterpretContext {
    return {
        functionId: FN_ID,
        qualifiedRepoName: QUALIFIED,
        commitHash: COMMIT,
        repoHints: { databases: [], decorators: [], hints: [] },
        identities: [identity()],
        envVarNames: [],
        allowPlainTextHosts: true,
        ...over,
    };
}

function infra(over: Partial<DatabaseInfraItem> = {}): DatabaseInfraItem {
    return { name: 'orders_table', operation: 'WRITES', ...over };
}

function nodes(delta: GraphDelta, label: string): NodeUpsert[] {
    return delta.nodes.filter(n => n.label === label);
}

function edges(delta: GraphDelta, type: string): EdgeUpsert[] {
    return delta.edges.filter(e => e.type === type);
}

describe('interpretDatastore — sole-candidate named table', () => {
    const { delta, traces } = interpretDatastore(infra(), ctx());
    const dsUrn = buildUrn('datastore', QUALIFIED, 'orders');
    const dcUrn = buildUrn('datacontainer', QUALIFIED, 'orders_table');

    it('emits the Datastore with mutation-parity props and ast grounding (connection_string binding)', () => {
        const [ds] = nodes(delta, 'Datastore');
        expect(ds.urn).toBe(dsUrn);
        expect(ds.propsOnce).toEqual({ name: 'orders', namespace: QUALIFIED, valid_from_commit: COMMIT });
        expect(ds.props).toEqual({ valid_to_commit: null, technology: 'mysql' });
        expect(ds.grounding.source).toBe('ast');
        expect(ds.grounding.evidence.extractors).toEqual(['connection-extractor@v1']);
    });

    it('emits one DatabaseEndpoint per usable environment variant, SERVED_BY the Datastore', () => {
        const epKey = computeEndpointKey('orders-prod.internal', 3306, 'orders');
        const [ep] = nodes(delta, 'DatabaseEndpoint');
        expect(ep.urn).toBe(buildUrn('dbendpoint', epKey, 'production'));
        expect(ep.propsOnce).toMatchObject({ endpointKey: epKey, environment: 'production', dbName: 'orders' });
        expect(ep.props).toMatchObject({ technology: 'mysql', host: 'orders-prod.internal', port: 3306 });

        const [served] = edges(delta, 'SERVED_BY');
        expect(served.from.urn).toBe(dsUrn);
        expect(served.to.urn).toBe(ep.urn);
    });

    it('emits the DataContainer with welding hints: overwrite props vs first-non-null-wins split', () => {
        const [dc] = nodes(delta, 'DataContainer');
        expect(dc.urn).toBe(dcUrn);
        expect(dc.propsOnce).toEqual({
            name: 'orders_table',
            scope: QUALIFIED,
            scopeSource: 'repo_fallback',
            sourceRepo: QUALIFIED,
            valid_from_commit: COMMIT,
        });
        const expectedFingerprint = buildPhysicalEndpoint({
            technology: 'mysql', host: 'orders-prod.internal', port: 3306, logicalName: 'orders',
        })!.fingerprint;
        expect(dc.props).toMatchObject({
            valid_to_commit: null,
            physicalEndpointKey: expectedFingerprint,
            datastoreUrn: dsUrn,
            physicalEndpointConfidence: 'high',
        });
        expect(dc.propsIfMissing).toEqual({ kindFamily: 'rdbms', technology: 'mysql' });
    });

    it('DataContainer grounding is composite (llm default + connection-string ast)', () => {
        const [dc] = nodes(delta, 'DataContainer');
        expect(dc.grounding.source).toBe('composite');
        expect(dc.grounding.needsReview).toBeFalsy();
    });

    it('links WRITES (function→DC), STORED_IN sole-candidate (DC→DS), CONNECTS_TO (function→DS)', () => {
        const [writes] = edges(delta, 'WRITES');
        expect(writes.from).toEqual({ label: 'Function', urn: FN_ID });
        expect(writes.to).toEqual({ label: 'DataContainer', urn: dcUrn });
        expect(writes.propsOnce).toEqual({ valid_from_commit: COMMIT });
        expect(writes.props).toEqual({ valid_to_commit: null });

        const [storedIn] = edges(delta, 'STORED_IN');
        expect(storedIn.from.urn).toBe(dcUrn);
        expect(storedIn.to.urn).toBe(dsUrn);
        expect(storedIn.props).toMatchObject({ bindingReason: 'sole-candidate' });
        expect(storedIn.grounding.source).toBe('ast');

        const [connects] = edges(delta, 'CONNECTS_TO');
        expect(connects.from).toEqual({ label: 'Function', urn: FN_ID });
        expect(connects.to.urn).toBe(dsUrn);
    });

    it('traces the DataContainer WRITE', () => {
        const write = traces.find(t => t.action === 'WRITE' && t.target === 'datacontainer:orders_table');
        expect(write).toBeDefined();
        expect(write!.meta).toMatchObject({ functionId: FN_ID, operation: 'WRITES', dbScope: QUALIFIED });
    });
});

describe('interpretDatastore — placeholder names', () => {
    it('<DYNAMIC> binds function to candidate Datastores without a DataContainer', () => {
        const { delta } = interpretDatastore(infra({ name: '<DYNAMIC>' }), ctx());
        expect(nodes(delta, 'DataContainer')).toHaveLength(0);
        expect(nodes(delta, 'Datastore')).toHaveLength(1);
        expect(nodes(delta, 'DatabaseEndpoint')).toHaveLength(1);
        expect(edges(delta, 'CONNECTS_TO')).toHaveLength(1);
        expect(edges(delta, 'STORED_IN')).toHaveLength(0);
        expect(edges(delta, 'WRITES')).toHaveLength(0);
    });

    it('unresolved-template names route through the placeholder path too', () => {
        const { delta } = interpretDatastore(infra({ name: 'orders_unknown_table' }), ctx());
        expect(nodes(delta, 'DataContainer')).toHaveLength(0);
        expect(edges(delta, 'CONNECTS_TO')).toHaveLength(1);
    });
});

describe('interpretDatastore — ambiguity and denylist', () => {
    it('two tied candidates → STORED_IN to ALL with ambiguous-multi-candidate and needsReview on the DC', () => {
        const two = [
            identity(),
            identity({
                identityKey: 'archive',
                canonicalHint: {
                    dbName: 'archive', technology: 'mysql', host: 'archive-prod.internal',
                    port: 3306, sourceFile: 'helm/values.yaml', confidence: 'high',
                } as DatastoreIdentity['canonicalHint'],
                environments: [],
            }),
        ];
        const { delta } = interpretDatastore(infra(), ctx({ identities: two }));

        expect(nodes(delta, 'Datastore')).toHaveLength(2);
        const storedIn = edges(delta, 'STORED_IN');
        expect(storedIn).toHaveLength(2);
        for (const e of storedIn) expect(e.props.bindingReason).toBe('ambiguous-multi-candidate');
        expect(edges(delta, 'CONNECTS_TO')).toHaveLength(2);
        expect(nodes(delta, 'DataContainer')[0].grounding.needsReview).toBe(true);
    });

    it('system database names are dropped with a DROP trace; the DataContainer survives', () => {
        const admin = identity({
            identityKey: 'admin',
            canonicalHint: {
                dbName: 'admin', technology: 'mongodb', host: 'mongo.internal',
                port: 27017, sourceFile: 'docker-compose.yml', confidence: 'high',
            } as DatastoreIdentity['canonicalHint'],
            environments: [],
        });
        const { delta, traces } = interpretDatastore(infra({ kindFamily: 'document' }), ctx({ identities: [admin] }));

        expect(nodes(delta, 'Datastore')).toHaveLength(0);
        expect(edges(delta, 'STORED_IN')).toHaveLength(0);
        expect(nodes(delta, 'DataContainer')).toHaveLength(1);
        expect(traces.some(t => t.action === 'DROP' && t.target === 'datastore:admin')).toBe(true);
    });
});

describe('interpretDatastore — bindings absent or filtered', () => {
    it('no identities → DataContainer + operation edge only, kindFamily from the explicit signal', () => {
        const { delta } = interpretDatastore(
            infra({ operation: 'READS', kindFamily: 'rdbms' }),
            ctx({ identities: [] }),
        );
        expect(nodes(delta, 'Datastore')).toHaveLength(0);
        expect(edges(delta, 'READS')).toHaveLength(1);
        const [dc] = nodes(delta, 'DataContainer');
        expect(dc.propsIfMissing).toEqual({ kindFamily: 'rdbms' });
        expect(dc.grounding.source).toBe('llm');
    });

    it('kindFamily gate: document entity never binds to an rdbms identity', () => {
        const { delta } = interpretDatastore(infra({ kindFamily: 'document' }), ctx());
        expect(nodes(delta, 'Datastore')).toHaveLength(0);
        expect(edges(delta, 'STORED_IN')).toHaveLength(0);
        expect(nodes(delta, 'DataContainer')).toHaveLength(1);
    });

    it('MAPS_TO operation emits a MAPS_TO edge', () => {
        const { delta } = interpretDatastore(infra({ operation: 'MAPS_TO' }), ctx());
        expect(edges(delta, 'MAPS_TO')).toHaveLength(1);
    });
});

describe('interpretCache', () => {
    const redisIdentity = identity({
        identityKey: 'session-cache',
        canonicalHint: {
            dbName: 'session-cache', technology: 'redis', host: 'redis-prod.internal',
            port: 6379, sourceFile: 'helm/values.yaml', confidence: 'high',
        } as DatastoreIdentity['canonicalHint'],
        environments: [
            { environment: 'production', host: 'redis-prod.internal', port: 6379, dbName: 'session-cache', sourceFile: 'helm/values.yaml' },
        ],
    });

    it('auto-promotes discovered kv identities: Datastore + endpoint + CONNECTS_TO, no DataContainer', () => {
        const { delta } = interpretCache(infra({ name: 'cache' }), ctx({ identities: [redisIdentity] }));
        const [ds] = nodes(delta, 'Datastore');
        expect(ds.urn).toBe(buildUrn('datastore', QUALIFIED, 'session-cache'));
        expect(ds.props).toMatchObject({ technology: 'redis' });
        expect(nodes(delta, 'DatabaseEndpoint')).toHaveLength(1);
        expect(edges(delta, 'CONNECTS_TO')).toHaveLength(1);
        expect(nodes(delta, 'DataContainer')).toHaveLength(0);
        expect(edges(delta, 'STORED_IN')).toHaveLength(0);
    });

    it('ignores non-kv identities (mysql never becomes a cache Datastore)', () => {
        const { delta } = interpretCache(infra({ name: 'cache' }), ctx());
        expect(delta.nodes).toHaveLength(0);
        expect(delta.edges).toHaveLength(0);
    });

    it('explicit infra.grounding wins over the binding grounding (DI bypass parity)', () => {
        const explicit = {
            source: 'ast' as const, quality: 'exact' as const,
            evidence: { extractors: ['di-binding-resolver@v1'] },
        };
        const { delta } = interpretCache(
            infra({ name: 'cache', grounding: explicit }),
            ctx({ identities: [redisIdentity] }),
        );
        expect(nodes(delta, 'Datastore')[0].grounding.evidence.extractors).toEqual(['di-binding-resolver@v1']);
    });
});

describe('interpretObjectStorage', () => {
    it('object-tech bucket: DataContainer + autopromoted object Datastore + STORED_IN + CONNECTS_TO', () => {
        const { delta } = interpretObjectStorage(
            infra({ name: 'invoices-bucket', technology: 'gcs' }),
            ctx({ identities: [] }),
        );

        const [dc] = nodes(delta, 'DataContainer');
        expect(dc.urn).toBe(buildUrn('datacontainer', QUALIFIED, 'invoices-bucket'));
        expect(dc.propsIfMissing).toMatchObject({ kindFamily: 'object' });

        const [ds] = nodes(delta, 'Datastore');
        expect(ds.urn).toBe(buildUrn('datastore', QUALIFIED, 'gcs'));
        expect(nodes(delta, 'DatabaseEndpoint')).toHaveLength(0);

        const [storedIn] = edges(delta, 'STORED_IN');
        expect(storedIn.props).toMatchObject({ bindingReason: 'object-tech-autopromote' });
        expect(edges(delta, 'CONNECTS_TO')).toHaveLength(1);
        expect(edges(delta, 'WRITES')).toHaveLength(1);
    });

    it('no object tech and no yaml binding → DataContainer + operation edge only', () => {
        const { delta } = interpretObjectStorage(
            infra({ name: 'invoices-bucket', operation: 'READS' }),
            ctx({ identities: [] }),
        );
        expect(nodes(delta, 'DataContainer')).toHaveLength(1);
        expect(edges(delta, 'READS')).toHaveLength(1);
        expect(nodes(delta, 'Datastore')).toHaveLength(0);
        expect(edges(delta, 'STORED_IN')).toHaveLength(0);
    });

    it('placeholder bucket name with no bindings emits nothing (POC policy)', () => {
        const { delta } = interpretObjectStorage(
            infra({ name: '<DYNAMIC>' }),
            ctx({ identities: [] }),
        );
        expect(delta.nodes).toHaveLength(0);
        expect(delta.edges).toHaveLength(0);
    });
});

describe('interpretDatastore — grounding precedence', () => {
    it('explicit infra.grounding wins over the llm/composite default on the DataContainer', () => {
        const explicit = {
            source: 'ast' as const,
            quality: 'exact' as const,
            evidence: { extractors: ['di-binding-resolver@v1'] },
        };
        const { delta } = interpretDatastore(infra({ grounding: explicit }), ctx());
        const [dc] = nodes(delta, 'DataContainer');
        expect(dc.grounding.source).toBe('ast');
        expect(dc.grounding.evidence.extractors).toEqual(['di-binding-resolver@v1']);
    });
});
