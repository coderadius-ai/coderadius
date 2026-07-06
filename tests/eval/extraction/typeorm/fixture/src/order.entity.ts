import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

// TypeORM entity: @Entity('orders') maps the class to the `orders` table;
// @Column decorators declare the mapped columns.
@Entity('orders')
export class Order {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'reference', type: 'varchar' })
    reference!: string;

    @Column({ type: 'integer', nullable: true })
    total_amount!: number;

    @Column({ type: 'varchar' })
    status!: string;
}
