import { makeApi, Zodios } from '@zodios/core';
import type { ZodiosOptions } from '@zodios/core';
import { z } from 'zod';

/**
 * Zodios API definition for an anonymous Place entity service.
 * Mirrors the real pattern: makeApi + createApiClient factory.
 *
 * Endpoints defined:
 *   GET  /places          → findPlaces
 *   GET  /places/:placeId → getPlace
 *   GET  /birthplaces     → findBirthplaces
 */
const PlaceType = z.enum(['country', 'region', 'province', 'city']);
const PlaceId = z.string().uuid();

const PlaceItem = z.object({
    id: PlaceId,
    type: PlaceType,
    name: z.string(),
    shortName: z.string().optional(),
}).passthrough();

const PlaceDetail = z.object({
    id: PlaceId,
    type: PlaceType,
    name: z.string(),
    istatCode: z.string().optional(),
}).passthrough();

const BirthplaceItem = z.object({
    id: PlaceId,
    type: z.enum(['country', 'city']),
    name: z.string(),
    atCode: z.string(),
}).passthrough();

const PlacesResponse = z.object({
    items: z.array(PlaceItem),
    total: z.number(),
});

const endpoints = makeApi([
    {
        method: 'get',
        path: '/places',
        alias: 'findPlaces',
        description: 'Find places by type or search term',
        requestFormat: 'json',
        parameters: [
            { name: 'search', type: 'Query', schema: z.string().optional() },
            { name: 'type', type: 'Query', schema: PlaceType.optional() },
        ],
        response: PlacesResponse,
    },
    {
        method: 'get',
        path: '/places/:placeId',
        alias: 'getPlace',
        description: 'Get place detail by ID',
        requestFormat: 'json',
        parameters: [{ name: 'placeId', type: 'Path', schema: z.string().uuid() }],
        response: PlaceDetail,
    },
    {
        method: 'get',
        path: '/birthplaces',
        alias: 'findBirthplaces',
        description: 'Get birthplaces (countries and cities) for fiscal code calculation',
        requestFormat: 'json',
        parameters: [
            { name: 'search', type: 'Query', schema: z.string().optional() },
        ],
        response: z.object({ items: z.array(BirthplaceItem), total: z.number() }),
    },
]);

export const api = new Zodios(endpoints);

export function createApiClient(baseUrl: string, options?: ZodiosOptions) {
    return new Zodios(baseUrl, endpoints, options);
}
