import { describe, it, expect, beforeEach } from 'vitest';
import {
    canonicaliseClassRef,
    parseGraphQLClientName,
    registerGraphQLClientDecorator,
    clearGraphQLClientDecorators,
    matchGraphQLClientDecorator,
    listGraphQLClientDecorators,
} from '../../../../src/ingestion/core/graphql-client-registry.js';

describe('canonicaliseClassRef', () => {
    it('normalises double backslashes to single', () => {
        expect(canonicaliseClassRef('My\\\\NS\\\\Cls')).toBe('My\\NS\\Cls');
    });

    it('normalises forward slashes to backslashes', () => {
        expect(canonicaliseClassRef('My/NS/Cls')).toBe('My\\NS\\Cls');
    });

    it('strips leading and trailing separators', () => {
        expect(canonicaliseClassRef('\\My\\NS\\Cls\\')).toBe('My\\NS\\Cls');
    });

    it('returns empty for falsy', () => {
        expect(canonicaliseClassRef('')).toBe('');
    });
});

describe('parseGraphQLClientName', () => {
    it('parses Class::method form', () => {
        expect(parseGraphQLClientName('My\\NS\\Cls::send')).toEqual({ className: 'My\\NS\\Cls', methodName: 'send' });
    });

    it('canonicalises separator variants', () => {
        expect(parseGraphQLClientName('My//NS//Cls::send'))
            .toEqual({ className: 'My\\NS\\Cls', methodName: 'send' });
    });

    it('returns null for missing separator', () => {
        expect(parseGraphQLClientName('Cls.send')).toBeNull();
    });

    it('returns null for empty method', () => {
        expect(parseGraphQLClientName('Cls::')).toBeNull();
    });
});

describe('matchGraphQLClientDecorator', () => {
    beforeEach(() => clearGraphQLClientDecorators());

    it('matches an exact FQCN + method pair', () => {
        registerGraphQLClientDecorator('My\\NS\\OrdersClient::post', ['query', 'variables']);
        expect(matchGraphQLClientDecorator('My\\NS\\OrdersClient', 'post')).not.toBeNull();
    });

    it('matches when receiver has a vendor prefix not present in the configured FQCN', () => {
        registerGraphQLClientDecorator('My\\NS\\OrdersClient::post');
        expect(matchGraphQLClientDecorator('Vendor\\My\\NS\\OrdersClient', 'post')).not.toBeNull();
    });

    it('matches a bare classname against an FQCN-receiver', () => {
        registerGraphQLClientDecorator('OrdersClient::post');
        expect(matchGraphQLClientDecorator('Foo\\Bar\\OrdersClient', 'post')).not.toBeNull();
    });

    it('does not match the wrong method', () => {
        registerGraphQLClientDecorator('My\\NS\\Cls::send');
        expect(matchGraphQLClientDecorator('My\\NS\\Cls', 'receive')).toBeNull();
    });

    it('does not match unrelated receivers', () => {
        registerGraphQLClientDecorator('My\\NS\\OrdersClient::post');
        expect(matchGraphQLClientDecorator('Other\\Cls', 'post')).toBeNull();
    });

    it('handles forward-slash configured value vs backslash receiver', () => {
        registerGraphQLClientDecorator('My/NS/OrdersClient::post');
        expect(matchGraphQLClientDecorator('My\\NS\\OrdersClient', 'post')).not.toBeNull();
    });

    it('clearGraphQLClientDecorators wipes all entries', () => {
        registerGraphQLClientDecorator('A\\B::do');
        expect(listGraphQLClientDecorators()).toHaveLength(1);
        clearGraphQLClientDecorators();
        expect(listGraphQLClientDecorators()).toHaveLength(0);
    });
});
