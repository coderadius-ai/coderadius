import type { IExternalApiRepository } from '../infrastructure/ExternalApi.interface';

/**
 * Use-case that calls the external Quotes API via the injected Zodios client wrapper.
 *
 * NOTE: The calls to .getQuotes() and .createQuote() are Zodios alias wrappers —
 * they resolve to GET /api/v1/quotes and POST /api/v1/quotes respectively.
 * The LLM should NOT extract these as API calls (wrapper rule).
 * The AST-based deterministic injector (zodios-context-builder) resolves them post-LLM.
 */
export class QuoteUseCase {
    constructor(private readonly quoteApi: IExternalApiRepository) {}

    /**
     * Fetch all available quotes for a customer.
     */
    async listQuotesForCustomer(customerId: string) {
        const quotes = await this.quoteApi.getQuotes();
        return quotes.filter(q => q.productId.startsWith(customerId));
    }

    /**
     * Request a new quote for a given product.
     */
    async requestQuote(productId: string, customerId: string, quantity: number) {
        const result = await this.quoteApi.createQuote({
            productId,
            customerId,
            quantity,
        });
        return {
            quoteId: result.quoteId,
            totalPrice: result.totalPrice,
        };
    }
}
