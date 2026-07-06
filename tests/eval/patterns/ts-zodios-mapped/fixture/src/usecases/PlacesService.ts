import type { IPlacesApiRepository } from '../infrastructure/PlacesApiRepository.interface';

/**
 * Use-case that calls the Places API via an injected typed client.
 *
 * The injected type is IPlacesApiRepository (a Pick<typeof api, ...>).
 * The actual HTTP endpoints are:
 *   GET  /places         → findPlaces()
 *   GET  /birthplaces    → findBirthplaces()
 *   GET  /places/:placeId → getPlace()
 *
 * The LLM must NOT extract these directly (wrapper rule applies).
 * The AST resolver (zodios-context-builder) must resolve them post-LLM
 * — but only if IPlacesApiRepository is correctly indexed via Pick<typeof api>.
 */
export class PlacesService {
    constructor(private readonly placesApi: IPlacesApiRepository) {}

    async findCityByName(search: string) {
        const response = await this.placesApi.findPlaces({
            queries: { search, type: 'city' },
        });
        return response.items;
    }

    async getPlaceDetail(placeId: string) {
        return this.placesApi.getPlace({ params: { placeId } });
    }

    async findBirthplace(search: string) {
        const response = await this.placesApi.findBirthplaces({
            queries: { search },
        });
        return response.items;
    }
}
