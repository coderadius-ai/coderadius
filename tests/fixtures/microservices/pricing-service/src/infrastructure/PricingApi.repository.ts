import { makeApi } from '@zodios/core';
import { z } from 'zod';

/**
 * Zodios API definition for the external Pricing Engine service.
 * Used by the pricing-service to fetch and compute product pricing data.
 */
const endpoints = makeApi([
    {
        method: 'get',
        path: '/api/v1/pricing/:productId',
        alias: 'getPricing',
        description: 'Get current price for a product',
        response: z.object({
            productId: z.string(),
            basePrice: z.number(),
            currency: z.string(),
        }),
    },
    {
        method: 'post',
        path: '/api/v1/pricing/discount',
        alias: 'calculateDiscount',
        description: 'Calculate discount price given a coupon code',
        parameters: [
            {
                name: 'body',
                type: 'Body',
                schema: z.object({
                    productId: z.string(),
                    couponCode: z.string(),
                    quantity: z.number().optional(),
                }),
            },
        ],
        response: z.object({
            discountedPrice: z.number(),
            savingsAmount: z.number(),
            couponApplied: z.boolean(),
        }),
    },
]);

export default endpoints;
