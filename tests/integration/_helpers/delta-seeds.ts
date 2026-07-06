/**
 * Delta-based seeding helpers for integration tests.
 *
 * Replace the retired per-node mutations (mergeDatastore, mergeDataContainer,
 * mergeDatabaseEndpoint, linkDatastoreServedBy, linkChannelRouting) with the
 * production write path: GraphDelta → MemgraphGraphStore. Prop mapping
 * mirrors what the interpreters emit, so seeded nodes are indistinguishable
 * from pipeline-written ones — including the first-non-null-wins semantics
 * of DataContainer kindFamily/technology (propsIfMissing).
 */
import { MemgraphGraphStore } from '../../../src/graph/write-model/memgraph-applier.js';
import { GraphDeltaSchema } from '../../../src/graph/write-model/delta.js';
import { astGrounding, type GroundingFields } from '../../../src/graph/grounding.js';
import { buildUrn } from '../../../src/graph/urn.js';
import { buildMessageChannelUrn } from '../../../src/graph/mutations/data-contracts.js';

const store = new MemgraphGraphStore();

async function apply(input: unknown, commitHash: string): Promise<void> {
    await store.apply(GraphDeltaSchema.parse(input), { commitHash });
}

const seedGrounding = (): GroundingFields => astGrounding('test-seed@v1');

export async function seedDatastore(
    namespace: string,
    logicalId: string,
    technology: string,
    commitHash: string,
    grounding: GroundingFields = seedGrounding(),
): Promise<string> {
    const urn = buildUrn('datastore', namespace, logicalId);
    await apply({
        nodes: [{
            label: 'Datastore',
            urn,
            propsOnce: { name: logicalId, namespace, valid_from_commit: commitHash },
            props: { valid_to_commit: null, technology },
            grounding,
        }],
    }, commitHash);
    return urn;
}

export interface SeedWeldingHints {
    kindFamily?: string;
    technology?: string;
    datastoreUrn?: string;
    physicalEndpointKey?: string;
}

export async function seedDataContainer(
    scope: string,
    name: string,
    commitHash: string,
    welding: SeedWeldingHints = {},
    grounding: GroundingFields = seedGrounding(),
): Promise<string> {
    const urn = buildUrn('datacontainer', scope, name);
    const propsIfMissing: Record<string, string> = {};
    if (welding.kindFamily) propsIfMissing.kindFamily = welding.kindFamily;
    if (welding.technology) propsIfMissing.technology = welding.technology;
    await apply({
        nodes: [{
            label: 'DataContainer',
            urn,
            propsOnce: { name, scope, scopeSource: 'repo_fallback', sourceRepo: scope, valid_from_commit: commitHash },
            props: {
                valid_to_commit: null,
                ...(welding.datastoreUrn ? { datastoreUrn: welding.datastoreUrn } : {}),
                ...(welding.physicalEndpointKey ? { physicalEndpointKey: welding.physicalEndpointKey } : {}),
            },
            ...(Object.keys(propsIfMissing).length > 0 ? { propsIfMissing } : {}),
            grounding,
        }],
    }, commitHash);
    return urn;
}

export async function seedDatabaseEndpoint(
    input: { endpointKey: string; environment: string; dbName: string; technology: string; host?: string; port?: number },
    commitHash: string,
): Promise<string> {
    const urn = buildUrn('dbendpoint', input.endpointKey, input.environment);
    await apply({
        nodes: [{
            label: 'DatabaseEndpoint',
            urn,
            propsOnce: { endpointKey: input.endpointKey, environment: input.environment, dbName: input.dbName, valid_from_commit: commitHash },
            props: {
                valid_to_commit: null,
                technology: input.technology,
                ...(input.host ? { host: input.host } : {}),
                ...(input.port != null ? { port: input.port } : {}),
            },
            grounding: astGrounding('connection-extractor@v1'),
        }],
    }, commitHash);
    return urn;
}

export async function seedServedBy(datastoreUrn: string, endpointUrn: string, commitHash: string): Promise<void> {
    await apply({
        edges: [{
            type: 'SERVED_BY',
            from: { label: 'Datastore', urn: datastoreUrn },
            to: { label: 'DatabaseEndpoint', urn: endpointUrn },
            propsOnce: { valid_from_commit: commitHash },
            props: { valid_to_commit: null },
            grounding: astGrounding('connection-extractor@v1'),
        }],
    }, commitHash);
}

export async function seedRoutesTo(
    subscriptionName: string,
    topicName: string,
    commitHash: string,
): Promise<void> {
    await apply({
        edges: [{
            type: 'ROUTES_TO',
            from: { label: 'MessageChannel', urn: buildMessageChannelUrn(subscriptionName, 'subscription') },
            to: { label: 'MessageChannel', urn: buildMessageChannelUrn(topicName, 'topic') },
            keyProps: { bindingKey: '' },
            propsOnce: { valid_from_commit: commitHash },
            props: { valid_to_commit: null },
            grounding: seedGrounding(),
        }],
    }, commitHash);
}
