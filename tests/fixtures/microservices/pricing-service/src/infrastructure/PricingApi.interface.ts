import type endpoints from './PricingApi.repository';

/**
 * Type interface for the external Pricing API client.
 * NestJS modules inject IPricingApiRepository via DI instead of the raw Zodios client.
 */
export type IPricingApiRepository = typeof endpoints;
