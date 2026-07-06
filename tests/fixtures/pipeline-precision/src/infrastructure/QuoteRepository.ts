import { Client } from 'pg';
import type { IQuoteRepository } from '../contracts/quote-contracts';

export class QuoteRepository implements IQuoteRepository {
    constructor(private readonly client: Client) {}

    async findQuoteById(id: string): Promise<unknown> {
        return this.client.query('SELECT * FROM quotes WHERE id = $1', [id]);
    }
}
