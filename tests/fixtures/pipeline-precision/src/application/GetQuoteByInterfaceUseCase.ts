import type { IQuoteRepository } from './quote.providers';

export class GetQuoteByInterfaceUseCase {
    constructor(private readonly quoteRepository: IQuoteRepository) {}

    async execute(id: string): Promise<unknown> {
        return this.quoteRepository.findQuoteById(id);
    }
}
