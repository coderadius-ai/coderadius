export interface IQuoteRepository {
    findQuoteById(id: string): Promise<unknown>;
}

export type QuoteStore = IQuoteRepository;
