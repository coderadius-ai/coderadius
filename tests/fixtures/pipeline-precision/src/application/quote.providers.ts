import { QuoteRepository } from '../infrastructure/QuoteRepository';

export type { IQuoteRepository, QuoteStore } from '../contracts/quote-contracts';

export const quoteProviders = [
    { provide: 'IQuoteRepository', useClass: QuoteRepository },
    { provide: 'QuoteStore', useExisting: 'IQuoteRepository' },
];
