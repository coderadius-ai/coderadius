import type { api } from './PlacesApi.repository';

/**
 * Interface for the Places API client — exposes only the subset of endpoints
 * needed by the application.
 *
 * NOTE: This is the pattern that breaks the current Zodios type index.
 * The regex in zodios-context-builder.ts only handles:
 *   export type IFoo = typeof api
 * but NOT:
 *   export type IFoo = Pick<typeof api, 'a' | 'b'>
 *
 * This fixture reproduces the bug: IPlacesApiRepository is NOT indexed,
 * so PlacesService.ts call-sites receive no Zodios context.
 */
export type IPlacesApiRepository = Pick<
    typeof api,
    'findPlaces' | 'getPlace' | 'findBirthplaces'
>;
