import { describe, it, expect } from 'vitest';
import { normalizeApiPath } from '../../../../src/ingestion/processors/api-path-utils.js';

describe('normalizeApiPath', () => {
    it('should strip common /api prefixes', () => {
        expect(normalizeApiPath('/api/users')).toBe('/users');
        expect(normalizeApiPath('/api/v1/charge')).toBe('/charge');
        expect(normalizeApiPath('/api/v2/items')).toBe('/items');
        expect(normalizeApiPath('/api')).toBe('/');
    });

    it('should normalize path parameters to a common placeholder', () => {
        // Express vs OpenAPI style
        expect(normalizeApiPath('/users/:userId')).toBe('/users/{param}');
        expect(normalizeApiPath('/api/users/{id}')).toBe('/users/{param}');

        // Match them correctly
        expect(normalizeApiPath('/users/:userId')).toEqual(normalizeApiPath('/api/users/{id}'));
    });

    it('should filter out pure dynamic paths and return null', () => {
        expect(normalizeApiPath('DYNAMIC')).toBeNull();
        expect(normalizeApiPath('{config.path}')).toBeNull();
        expect(normalizeApiPath('{baseUri}/users')).toBeNull();
        expect(normalizeApiPath('/{id}/{subId}')).toBeNull();
    });

    it('should preserve literal segment values', () => {
        expect(normalizeApiPath('/users/123')).toBe('/users/123');
    });

    it('should preserve GRAPHQL marker unaffected', () => {
        expect(normalizeApiPath('GRAPHQL QUERY GetUsers')).toBe('GRAPHQL QUERY GetUsers');
    });
});
