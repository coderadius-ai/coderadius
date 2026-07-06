import { describe, it, expect, beforeEach } from 'vitest';
import {
    registerHttpClientDecorator,
    clearHttpClientDecorators,
    matchHttpClientDecorator,
    listHttpClientDecorators,
} from '../../../../src/ingestion/core/http-client-registry.js';

describe('http-client-registry', () => {
    beforeEach(() => clearHttpClientDecorators());

    it('registers and matches by exact FQCN::method', () => {
        registerHttpClientDecorator('Acme\\Inventory\\OrdersClient::callMethod', 0, 'POST');
        const result = matchHttpClientDecorator('Acme\\Inventory\\OrdersClient', 'callMethod');
        expect(result).not.toBeNull();
        expect(result!.pathArgIndex).toBe(0);
        expect(result!.httpMethod).toBe('POST');
    });

    it('matches by FQCN suffix (vendor-prefixed namespace)', () => {
        registerHttpClientDecorator('Inventory\\OrdersClient::callMethod');
        const result = matchHttpClientDecorator('Vendor\\Acme\\Inventory\\OrdersClient', 'callMethod');
        expect(result).not.toBeNull();
    });

    it('matches by bare class name (last segment)', () => {
        registerHttpClientDecorator('OrdersClient::callMethod');
        const result = matchHttpClientDecorator('Acme\\Inventory\\OrdersClient', 'callMethod');
        expect(result).not.toBeNull();
    });

    it('does NOT match different method name', () => {
        registerHttpClientDecorator('OrdersClient::callMethod');
        expect(matchHttpClientDecorator('OrdersClient', 'otherMethod')).toBeNull();
    });

    it('does NOT match different class', () => {
        registerHttpClientDecorator('OrdersClient::callMethod');
        expect(matchHttpClientDecorator('OtherClient', 'callMethod')).toBeNull();
    });

    it('canonicalises forward slashes in registration', () => {
        registerHttpClientDecorator('Acme/Inventory/OrdersClient::callMethod');
        const result = matchHttpClientDecorator('Acme\\Inventory\\OrdersClient', 'callMethod');
        expect(result).not.toBeNull();
    });

    it('defaults pathArgIndex=0 and httpMethod=POST when omitted', () => {
        registerHttpClientDecorator('OrdersClient::callMethod');
        const result = matchHttpClientDecorator('OrdersClient', 'callMethod');
        expect(result!.pathArgIndex).toBe(0);
        expect(result!.httpMethod).toBe('POST');
    });

    it('respects configured pathArgIndex and httpMethod overrides', () => {
        registerHttpClientDecorator('OrdersClient::callMethod', 2, 'PUT');
        const result = matchHttpClientDecorator('OrdersClient', 'callMethod');
        expect(result!.pathArgIndex).toBe(2);
        expect(result!.httpMethod).toBe('PUT');
    });

    it('lists registered decorators', () => {
        registerHttpClientDecorator('A\\B::m1');
        registerHttpClientDecorator('A\\C::m2');
        expect(listHttpClientDecorators()).toHaveLength(2);
    });

    it('returns null when registry is empty', () => {
        expect(matchHttpClientDecorator('OrdersClient', 'callMethod')).toBeNull();
    });

    it('rejects malformed name silently (no Class::method separator)', () => {
        registerHttpClientDecorator('NotAValidName');
        expect(listHttpClientDecorators()).toHaveLength(0);
    });
});
