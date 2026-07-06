import type { QuoteStore } from './quote.providers';

export class GetQuoteUseCase {
    constructor(private readonly quoteStore: QuoteStore) {}

    async handle(id: string): Promise<unknown> {
        return this.quoteStore.findQuoteById(id);
    }
}
