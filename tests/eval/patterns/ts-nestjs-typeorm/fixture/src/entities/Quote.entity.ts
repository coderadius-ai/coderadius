import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * TypeORM entity with an EXPLICIT table name. The table name is statically
 * knowable: the pipeline extracts it via the orm-entity framework signal and
 * grounds the LLM through the entity-table registry (no pluralization guess).
 */
@Entity('quotes')
export class QuoteEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    customerId: number;

    @Column({ type: 'decimal' })
    premium: number;

    @Column()
    status: string;
}
