import { describe, expect, it } from 'vitest';
import type { TopologyNode } from '../../../packages/shared-types/index';
import {
    pickIdentityToken,
    type IdentityToken,
} from '../../../packages/dashboard-ui/src/components/blast-radius/lib/identity-token';

function node(partial: Partial<TopologyNode> & { type: string; name?: string }): TopologyNode {
    return {
        name: partial.name ?? 'sample',
        type: partial.type,
        teamOwner: null,
        repository: null,
        channelKind: null,
        tags: null,
        discoverySource: null,
        technology: null,
        language: null,
        datastore: null,
        apiKind: null,
        operation: null,
        groundingSource: null,
        quality: null,
        needsReview: null,
        ...partial,
    } as TopologyNode;
}

describe('pickIdentityToken', () => {
    it('Service: teamOwner wins over language when both present', () => {
        const tok = pickIdentityToken(node({ type: 'Service', teamOwner: 'payments-team', language: 'php' }));
        expect(tok.text).toBe('payments-team');
        expect(tok.muted).toBe(false);
    });

    it('Service: falls back to language when teamOwner is null', () => {
        const tok = pickIdentityToken(node({ type: 'Service', teamOwner: null, language: 'typescript' }));
        expect(tok.text).toBe('typescript');
        expect(tok.muted).toBe(false);
    });

    it('Service: falls back to humanised type when both teamOwner and language are null', () => {
        const tok = pickIdentityToken(node({ type: 'Service' }));
        expect(tok.text).toBe('Service');
        expect(tok.muted).toBe(true);
    });

    it('DataContainer: technology · datastoreName when both present', () => {
        const tok = pickIdentityToken(node({
            type: 'DataContainer',
            technology: 'mysql',
            datastore: [{ name: 'inventory' }],
        }));
        expect(tok.text).toBe('mysql · inventory');
        expect(tok.muted).toBe(false);
    });

    it('DataContainer: technology alone when datastore is absent', () => {
        const tok = pickIdentityToken(node({ type: 'DataContainer', technology: 'postgres' }));
        expect(tok.text).toBe('postgres');
        expect(tok.muted).toBe(false);
    });

    it('DataContainer: datastoreName alone when technology is absent', () => {
        const tok = pickIdentityToken(node({
            type: 'DataContainer',
            datastore: [{ name: 'orders' }],
        }));
        expect(tok.text).toBe('orders');
        expect(tok.muted).toBe(false);
    });

    it('DataContainer: humanised type label when both technology and datastore are null', () => {
        const tok = pickIdentityToken(node({ type: 'DataContainer' }));
        expect(tok.text).toBe('Data Container');
        expect(tok.muted).toBe(true);
    });

    it('Datastore: technology alone', () => {
        const tok = pickIdentityToken(node({ type: 'Datastore', technology: 'redis' }));
        expect(tok.text).toBe('redis');
    });

    it('DatabaseEndpoint: technology · host when both present', () => {
        const tok = pickIdentityToken(node({
            type: 'DatabaseEndpoint',
            technology: 'mysql',
            datastore: [{ name: 'orders', host: 'db.acme.internal' }],
        }));
        expect(tok.text).toBe('mysql · db.acme.internal');
    });

    it('MessageChannel: technology · channelKind', () => {
        const tok = pickIdentityToken(node({
            type: 'MessageChannel',
            technology: 'kafka',
            channelKind: 'topic',
        }));
        expect(tok.text).toBe('kafka · topic');
    });

    it('MessageChannel: technology alone when channelKind is null', () => {
        const tok = pickIdentityToken(node({ type: 'MessageChannel', technology: 'rabbitmq' }));
        expect(tok.text).toBe('rabbitmq');
    });

    it('APIEndpoint REST: HTTP method parsed from name', () => {
        const tok = pickIdentityToken(node({
            type: 'APIEndpoint',
            name: 'GET /v1/orders/{id}',
            apiKind: 'rest',
        }));
        expect(tok.text).toBe('GET');
    });

    it('APIEndpoint GraphQL: operation token', () => {
        const tok = pickIdentityToken(node({
            type: 'APIEndpoint',
            name: 'orderById',
            apiKind: 'graphql',
            operation: 'QUERY',
        }));
        expect(tok.text).toBe('graphql · QUERY');
    });

    it('APIEndpoint gRPC: subtype defaults to UNARY when operation absent', () => {
        const tok = pickIdentityToken(node({
            type: 'APIEndpoint',
            name: 'GetOrder',
            apiKind: 'grpc',
        }));
        expect(tok.text).toBe('grpc · UNARY');
    });

    it('UnresolvedDependency: literal "unresolved" muted token', () => {
        const tok = pickIdentityToken(node({ type: 'UnresolvedDependency', name: 'missing-svc' }));
        expect(tok.text).toBe('unresolved');
        expect(tok.muted).toBe(true);
    });

    it('Function: falls back to language when present', () => {
        const tok = pickIdentityToken(node({ type: 'Function', language: 'go' }));
        expect(tok.text).toBe('go');
    });

    it('Package: ecosystem wins over language', () => {
        const tok = pickIdentityToken(node({ type: 'Package', ecosystem: 'npm', language: 'typescript' }));
        expect(tok.text).toBe('npm');
        expect(tok.muted).toBe(false);
    });

    it('Package: falls back to language when ecosystem is null', () => {
        const tok = pickIdentityToken(node({ type: 'Package', language: 'typescript' }));
        expect(tok.text).toBe('typescript');
    });

    it('Package: humanised type when both ecosystem and language are null', () => {
        const tok = pickIdentityToken(node({ type: 'Package' }));
        expect(tok.text).toBe('Package');
        expect(tok.muted).toBe(true);
    });

    it('Library: same rules as Package — ecosystem wins', () => {
        const tok = pickIdentityToken(node({ type: 'Library', ecosystem: 'composer' }));
        expect(tok.text).toBe('composer');
    });

    it('APIInterface: env-var shows External API, openapi shows title', () => {
        const envVar = pickIdentityToken(node({ type: 'APIInterface', apiSource: 'env-var' }));
        expect(envVar.text).toBe('External API');
        expect(envVar.muted).toBe(false);
        const withTitle = pickIdentityToken(node({ type: 'APIInterface', apiSource: 'openapi', title: 'Orders API' }));
        expect(withTitle.text).toBe('Orders API');
        const bare = pickIdentityToken(node({ type: 'APIInterface' }));
        expect(bare.text).toBe('API Interface');
        expect(bare.muted).toBe(true);
    });

    it('System: teamOwner if set, else humanised type', () => {
        const owned = pickIdentityToken(node({ type: 'System', teamOwner: 'platform' }));
        expect(owned.text).toBe('platform');
        const bare = pickIdentityToken(node({ type: 'System' }));
        expect(bare.text).toBe('System');
        expect(bare.muted).toBe(true);
    });

    it('unknown type: humanised type label muted', () => {
        const tok = pickIdentityToken(node({ type: 'WhateverNew' } as unknown as TopologyNode));
        expect(tok.text).toBe('Whatever New');
        expect(tok.muted).toBe(true);
    });

    it('never returns empty string — fallback is non-empty', () => {
        const tok = pickIdentityToken(node({ type: '' } as unknown as TopologyNode));
        expect(tok.text.length).toBeGreaterThan(0);
    });

    it('coerenza singolo↔cluster: DataContainer singolo produce stessa stringa del cluster aggregato', () => {
        // Lo strip della card cluster fa: `${technology} · ${datastoreName}`.
        // Lo stesso DataContainer come nodo singolo deve produrre la stessa
        // composizione, in modo che la "voce" sia coerente fra le due rese.
        const single = pickIdentityToken(node({
            type: 'DataContainer',
            technology: 'mysql',
            datastore: [{ name: 'inventory' }],
        }));
        const clusterStrip = `${'mysql'} · ${'inventory'}`;
        expect(single.text).toBe(clusterStrip);
    });

    it('shape: token has text and muted fields', () => {
        const tok: IdentityToken = pickIdentityToken(node({ type: 'Service', teamOwner: 't' }));
        expect(typeof tok.text).toBe('string');
        expect(typeof tok.muted).toBe('boolean');
    });
});
