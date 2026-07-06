import { describe, it, expect } from 'vitest';
import {
    interpretResourceDeclarations,
    type DatastoreInterpretContext,
} from '../../../src/ingestion/processors/code-pipeline/interpret/datastore.js';
import { interpretEnvVars } from '../../../src/ingestion/processors/code-pipeline/interpret/env-vars.js';
import { buildUrn } from '../../../src/graph/urn.js';
import type { EnvVarBinding } from '../../../src/ingestion/processors/infra-manifest-resolver.js';

// The two declarative sections of persistFunction become
// deltas — deterministic resource declarations (Helm/Terraform/NestJS
// forRoot) and env-var reads. Single-apply ordering also fixes the latent
// CONFIGURED_VIA gap: the edge used to run BEFORE the EnvVar nodes merged.

const QUALIFIED = 'acme/inventory';
const FN_ID = 'acme/inventory:src/db.ts:connect';
const COMMIT = 'commit-rd-1';

function ctx(): DatastoreInterpretContext {
    return {
        functionId: FN_ID,
        qualifiedRepoName: QUALIFIED,
        commitHash: COMMIT,
        repoHints: { databases: [], decorators: [], hints: [] },
        identities: [],
        envVarNames: [],
        allowPlainTextHosts: true,
    };
}

describe('interpretResourceDeclarations', () => {
    const decl = {
        logicalId: 'orders-db',
        technology: 'postgres',
        configuredVia: ['DATABASE_URL'],
        endpointKey: 'abc12345',
        dbName: 'orders',
        host: 'pg.internal',
        port: 5432,
        declarationSource: 'nestjs-forroot',
    };

    it('emits Datastore + CONNECTS_TO + CONFIGURED_VIA + endpoint with SERVED_BY, all ast-grounded', () => {
        const { delta, traces } = interpretResourceDeclarations([decl], ctx());

        const ds = delta.nodes.find(n => n.label === 'Datastore')!;
        expect(ds.urn).toBe(buildUrn('datastore', QUALIFIED, 'orders-db'));
        expect(ds.grounding.evidence.extractors).toEqual(['resource-declaration@v1']);

        const ep = delta.nodes.find(n => n.label === 'DatabaseEndpoint')!;
        expect(ep.urn).toBe(buildUrn('dbendpoint', 'abc12345', 'unknown'));
        expect(ep.propsOnce).toMatchObject({ environment: 'unknown', dbName: 'orders' });
        expect(ep.props).toMatchObject({ host: 'pg.internal', port: 5432 });

        const types = delta.edges.map(e => e.type).sort();
        expect(types).toEqual(['CONFIGURED_VIA', 'CONNECTS_TO', 'SERVED_BY']);
        const configured = delta.edges.find(e => e.type === 'CONFIGURED_VIA')!;
        expect(configured.from.urn).toBe(ds.urn);
        expect(configured.to).toEqual({ label: 'EnvVar', urn: buildUrn('envvar', 'DATABASE_URL') });

        expect(traces.some(t => t.action === 'WRITE' && t.reason === 'deterministic datastore declaration merged')).toBe(true);
    });

    it('skips system database names and omits the endpoint when the key is missing', () => {
        const { delta, logs } = interpretResourceDeclarations(
            [
                { logicalId: 'information_schema', technology: 'mysql' },
                { logicalId: 'orders-db', technology: 'postgres' },
            ],
            ctx(),
        );
        expect(delta.nodes.filter(n => n.label === 'Datastore')).toHaveLength(1);
        expect(delta.nodes.filter(n => n.label === 'DatabaseEndpoint')).toHaveLength(0);
        expect(logs!.some(l => l.message.includes('information_schema'))).toBe(true);
    });

    it('host is omitted when plain-text hosts are disallowed', () => {
        const { delta } = interpretResourceDeclarations([decl], { ...ctx(), allowPlainTextHosts: false });
        const ep = delta.nodes.find(n => n.label === 'DatabaseEndpoint')!;
        expect(ep.props.host).toBeUndefined();
    });
});

describe('interpretEnvVars', () => {
    it('emits EnvVar nodes with resolved bindings and READS_ENV edges', () => {
        const dict = new Map<string, EnvVarBinding>([
            ['DATABASE_URL', { value: 'postgres://pg.internal/orders', sourceFile: '.env.production', confidence: 0.9 }],
        ]);
        const { delta } = interpretEnvVars(['DATABASE_URL', 'UNRESOLVED_FLAG'], dict, { functionId: FN_ID, commitHash: COMMIT });

        const resolved = delta.nodes.find(n => n.urn === buildUrn('envvar', 'DATABASE_URL'))!;
        expect(resolved.label).toBe('EnvVar');
        expect(resolved.props).toMatchObject({ resolvedValue: 'postgres://pg.internal/orders', valueSourceFile: '.env.production' });
        expect(resolved.grounding.evidence.extractors).toEqual(['env-var-resolver@v1']);

        const unresolved = delta.nodes.find(n => n.urn === buildUrn('envvar', 'UNRESOLVED_FLAG'))!;
        expect(unresolved.props.resolvedValue).toBeUndefined();

        expect(delta.edges.filter(e => e.type === 'READS_ENV')).toHaveLength(2);
        expect(delta.edges[0].from).toEqual({ label: 'Function', urn: FN_ID });
    });
});
