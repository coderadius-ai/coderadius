import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('renewals')
export class RenewalEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    quoteId: number;

    @Column()
    agencyId: number;

    @Column()
    status: string;

    @Column()
    expiresAt: Date;
}
