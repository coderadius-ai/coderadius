import type endpoints from './ExternalApi.repository';

/**
 * Type interface for the external Quotes API client.
 * Consumers inject IExternalApiRepository instead of the concrete Zodios client.
 */
export type IExternalApiRepository = typeof endpoints;
