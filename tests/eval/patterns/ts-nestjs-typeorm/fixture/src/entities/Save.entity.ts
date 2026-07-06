import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('saves')
export class SaveEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    quoteId: number;

    @Column({ type: 'text' })
    payload: string;

    @Column()
    createdAt: Date;
}
