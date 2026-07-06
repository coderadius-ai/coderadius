import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QuoteEntity } from './entities/Quote.entity';
import { SaveEntity } from './entities/Save.entity';
import { RenewalEntity } from './entities/Renewal.entity';

/**
 * Service that manages order quotes — reads/writes multiple TypeORM
 * entities. The LLM must extract each entity table as a DataContainer.
 *
 * This fixture simulates a NestJS service that uses TypeORM repositories
 * injected via @InjectRepository. The service itself has no direct process.env
 * access — the DB connection is configured in a separate Database.module.ts
 * via TypeOrmModule.forRootAsync + ConfigService.
 */
@Injectable()
export class QuoteService {
    constructor(
        @InjectRepository(QuoteEntity)
        private readonly quoteRepo: Repository<QuoteEntity>,

        @InjectRepository(SaveEntity)
        private readonly saveRepo: Repository<SaveEntity>,

        @InjectRepository(RenewalEntity)
        private readonly renewalRepo: Repository<RenewalEntity>,
    ) {}

    async createQuote(data: Partial<QuoteEntity>): Promise<QuoteEntity> {
        const quote = this.quoteRepo.create(data);
        return this.quoteRepo.save(quote);
    }

    async findQuoteById(id: number): Promise<QuoteEntity | null> {
        return this.quoteRepo.findOne({ where: { id } });
    }

    async saveQuoteSnapshot(quoteId: number, payload: Record<string, unknown>): Promise<SaveEntity> {
        const save = this.saveRepo.create({
            quoteId,
            payload: JSON.stringify(payload),
            createdAt: new Date(),
        });
        return this.saveRepo.save(save);
    }

    async findActiveRenewals(agencyId: number): Promise<RenewalEntity[]> {
        return this.renewalRepo.find({
            where: { agencyId, status: 'active' },
            order: { expiresAt: 'ASC' },
        });
    }

    async processRenewalBatch(agencyId: number): Promise<{ renewed: number }> {
        const renewals = await this.findActiveRenewals(agencyId);
        let renewed = 0;
        for (const renewal of renewals) {
            const quote = await this.quoteRepo.findOne({
                where: { id: renewal.quoteId },
            });
            if (quote) {
                renewal.status = 'renewed';
                await this.renewalRepo.save(renewal);
                renewed++;
            }
        }
        return { renewed };
    }
}
