import { makeApi } from '@zodios/core';
import { z } from 'zod';

/**
 * Zodios API definition for the external Quotes service.
 * Maps HTTP endpoints to typed method aliases.
 */
const endpoints = makeApi([
    {
        method: 'get',
        path: '/api/v1/quotes',
        alias: 'getQuotes',
        description: 'Fetch all available quotes',
        response: z.array(
            z.object({
                id: z.string(),
                productId: z.string(),
                price: z.number(),
            }),
        ),
    },
    {
        method: 'post',
        path: '/api/v1/quotes',
        alias: 'createQuote',
        description: 'Create a new quote request',
        parameters: [
            {
                name: 'body',
                type: 'Body',
                schema: z.object({
                    productId: z.string(),
                    customerId: z.string(),
                    quantity: z.number(),
                }),
            },
        ],
        response: z.object({
            quoteId: z.string(),
            totalPrice: z.number(),
            expiresAt: z.string(),
        }),
    },
    {
        method: 'delete',
        path: '/api/v1/quotes/:quoteId',
        alias: 'deleteQuote',
        description: 'Delete an existing quote',
        response: z.void(),
    },
]);

export default endpoints;
