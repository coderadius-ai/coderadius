import { describe, expect, it, afterEach } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import {
    registerCustomMessageConsumerDecorator,
    clearCustomMessageConsumerDecorators,
} from '../../../../src/ingestion/core/languages/typescript-framework-signals.js';
import {
    buildFrameworkSignalOverlay,
    matchFrameworkSignalsToChunk,
} from '../../../../src/ingestion/core/framework-signal-overlay.js';

let parser: Parser | null = null;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(ts.typescript as unknown as Parser.Language);
    }
    return parser;
}

function parseTree(src: string): Parser.Tree {
    return getParser().parse(src);
}

const plugin = new TypeScriptPlugin();

describe('TypeScript framework signals — ORM metadata', () => {
    it('extracts TypeORM @Entity class metadata and emits a synthetic __class_metadata chunk', () => {
        const src = `
import { Entity, Column } from 'typeorm';

@Entity({ name: 'shopping_carts' })
export class OrderTableSchema {
  @Column({ name: 'voucher_id' })
  voucherId!: string;
}
`;
        const tree = parseTree(src);

        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'apps/api/src/database/entities/Order.entity.ts');
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'OrderTableSchema')).toBe(true);
        expect(signals.find(signal => signal.kind === 'orm-entity')?.resolvedName).toBe('shopping_carts');

        const chunks = plugin.extractFunctions(tree, src, 'apps/api/src/database/entities/Order.entity.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'OrderTableSchema::__class_metadata');
        expect(metadataChunk).toBeDefined();
        expect(metadataChunk!.sourceCode).toContain("@Entity({ name: 'shopping_carts' })");

        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra).not.toBeNull();
        expect(staticInfra!.capabilities).toContain('orm-entity');
        expect(staticInfra!.infrastructure[0]).toMatchObject({
            name: 'shopping_carts',
            type: 'Database',
            operation: 'MAPS_TO',
        });
    });

    it('extracts TypeORM @Entity with direct-string table name (@Entity(\'quotes\'))', () => {
        // The string-arg form is the grounding source for the ts-nestjs-typeorm
        // pattern eval: the AST-declared table name must reach the entity-table
        // registry verbatim (no class-name pluralization).
        const src = `
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('quotes')
export class QuoteEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;
}
`;
        const tree = parseTree(src);

        const chunks = plugin.extractFunctions(tree, src, 'src/entities/Quote.entity.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'QuoteEntity::__class_metadata');
        expect(metadataChunk).toBeDefined();

        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra).not.toBeNull();
        expect(staticInfra!.infrastructure[0]).toMatchObject({
            name: 'quotes',
            type: 'Database',
            operation: 'MAPS_TO',
        });
    });

    it('extracts TypeORM EntitySchema builders as ORM metadata chunks', () => {
        const src = `
import { EntitySchema } from 'typeorm';

export const OrderTableSchema = new EntitySchema({
  name: 'shopping_carts',
  columns: {
    id: { type: String, primary: true },
  },
});
`;
        const tree = parseTree(src);
        const chunks = plugin.extractFunctions(tree, src, 'apps/api/src/database/entities/Order.entity.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'OrderTableSchema::__class_metadata');

        expect(metadataChunk).toBeDefined();
        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra!.infrastructure[0].name).toBe('shopping_carts');
    });

    it('extracts Drizzle table builders as ORM metadata chunks', () => {
        const src = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const usersTable = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
`;
        const tree = parseTree(src);
        const chunks = plugin.extractFunctions(tree, src, 'src/db/schema/users.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'usersTable::__class_metadata');

        expect(metadataChunk).toBeDefined();
        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra!.infrastructure[0].name).toBe('users');
    });

    it('extracts Mongoose @Schema with explicit collection name', () => {
        const src = `
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'validation_error_log',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
})
export class ValidationErrorLogEntity {
    @Prop({ required: true })
    errors!: any[];
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/infrastructure/form/ValidationErrorLog.entity.ts');
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'ValidationErrorLogEntity')).toBe(true);
        expect(signals.find(signal => signal.kind === 'orm-entity')?.resolvedName).toBe('validation_error_log');

        const chunks = plugin.extractFunctions(tree, src, 'src/infrastructure/form/ValidationErrorLog.entity.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'ValidationErrorLogEntity::__class_metadata');
        expect(metadataChunk).toBeDefined();

        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra).not.toBeNull();
        expect(staticInfra!.infrastructure[0]).toMatchObject({
            name: 'validation_error_log',
            type: 'Database',
            operation: 'MAPS_TO',
            kindFamily: 'document',
        });
    });

    it('skips Mongoose @Schema({ _id: false }) — embedded subdocument, not a standalone collection', () => {
        const src = `
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as SchemaM } from 'mongoose';

@Schema({ _id: false })
class QuoteIdSubEntity {
    @Prop({ required: true })
    id!: number;

    @Prop({ required: true, type: SchemaM.Types.String })
    type!: string;
}

const QuoteIdSubSchema = SchemaFactory.createForClass(QuoteIdSubEntity);

@Schema({
    collection: 'validation_error_log',
    timestamps: { createdAt: true, updatedAt: false },
})
export class ValidationErrorLogEntity {
    @Prop({ type: QuoteIdSubSchema })
    quoteId?: any;
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/infrastructure/form/ValidationErrorLog.entity.ts');

        // The embedded subdocument must NOT be detected as orm-entity
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'QuoteIdSubEntity')).toBe(false);

        // The parent collection MUST still be detected
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'ValidationErrorLogEntity')).toBe(true);

        // No __class_metadata chunk for the subdocument
        const chunks = plugin.extractFunctions(tree, src, 'src/infrastructure/form/ValidationErrorLog.entity.ts');
        expect(chunks.find(chunk => chunk.name === 'QuoteIdSubEntity::__class_metadata')).toBeUndefined();

        // Parent metadata chunk must exist
        expect(chunks.find(chunk => chunk.name === 'ValidationErrorLogEntity::__class_metadata')).toBeDefined();
    });

    it('extracts TypeORM @ViewEntity as orm-entity with view name', () => {
        const src = `
import { ViewEntity, ViewColumn } from 'typeorm';

@ViewEntity('active_renewals_view')
export class ActiveRenewalView {
    @ViewColumn()
    quoteId!: number;

    @ViewColumn()
    status!: string;
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/entities/ActiveRenewalView.entity.ts');
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'ActiveRenewalView')).toBe(true);
        expect(signals.find(signal => signal.kind === 'orm-entity')?.resolvedName).toBe('active_renewals_view');

        const chunks = plugin.extractFunctions(tree, src, 'src/entities/ActiveRenewalView.entity.ts');
        const metadataChunk = chunks.find(chunk => chunk.name === 'ActiveRenewalView::__class_metadata');
        expect(metadataChunk).toBeDefined();

        const staticInfra = plugin.extractStaticInfra(tree.rootNode, metadataChunk!);
        expect(staticInfra).not.toBeNull();
        expect(staticInfra!.infrastructure[0]).toMatchObject({
            name: 'active_renewals_view',
            type: 'Database',
            operation: 'MAPS_TO',
            kindFamily: 'rdbms',
        });
    });

    it('extracts TypeORM @ViewEntity({ name }) object syntax', () => {
        const src = `
import { ViewEntity, ViewColumn } from 'typeorm';

@ViewEntity({ name: 'user_stats_view', expression: 'SELECT ...' })
export class UserStatsView {
    @ViewColumn()
    userId!: number;
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/entities/UserStatsView.entity.ts');
        expect(signals.find(signal => signal.kind === 'orm-entity')?.resolvedName).toBe('user_stats_view');
    });

    it('skips TypeORM @ChildEntity() — STI discriminator with no table of its own', () => {
        const src = `
import { Entity, ChildEntity, Column, TableInheritance } from 'typeorm';

@Entity('notifications')
@TableInheritance({ column: { type: 'varchar', name: 'type' } })
export class NotificationEntity {
    @Column()
    message!: string;
}

@ChildEntity('email')
export class EmailNotificationEntity extends NotificationEntity {
    @Column()
    emailAddress!: string;
}

@ChildEntity('sms')
export class SmsNotificationEntity extends NotificationEntity {
    @Column()
    phoneNumber!: string;
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/entities/Notification.entity.ts');

        // Parent @Entity must be detected
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'NotificationEntity')).toBe(true);
        expect(signals.find(signal => signal.kind === 'orm-entity' && signal.ownerName === 'NotificationEntity')?.resolvedName).toBe('notifications');

        // @ChildEntity classes must NOT be detected as orm-entity
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'EmailNotificationEntity')).toBe(false);
        expect(signals.some(signal => signal.kind === 'orm-entity' && signal.ownerName === 'SmsNotificationEntity')).toBe(false);

        // No __class_metadata for children
        const chunks = plugin.extractFunctions(tree, src, 'src/entities/Notification.entity.ts');
        expect(chunks.find(chunk => chunk.name === 'EmailNotificationEntity::__class_metadata')).toBeUndefined();
        expect(chunks.find(chunk => chunk.name === 'SmsNotificationEntity::__class_metadata')).toBeUndefined();

        // Parent __class_metadata must exist
        expect(chunks.find(chunk => chunk.name === 'NotificationEntity::__class_metadata')).toBeDefined();
    });
});

describe('TypeScript framework signals — controller, GraphQL, messaging, schema', () => {
    it('combines controller and method decorators into a ground-truth HTTP endpoint overlay', () => {
        const src = `
import { Controller, Get, UseGuards } from '@nestjs/common';

@Controller('/users')
export class UsersController {
  @UseGuards(AuthGuard)
  @Get('/:id')
  findOne() {
    return this.usersService.findOne();
  }
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/users/users.controller.ts');
        const matched = matchFrameworkSignalsToChunk('UsersController.findOne', signals);
        const overlay = buildFrameworkSignalOverlay('UsersController.findOne', matched);

        expect(matched.some(signal => signal.kind === 'http-controller')).toBe(true);
        expect(matched.some(signal => signal.kind === 'http-route')).toBe(true);
        expect(matched.some(signal => signal.metadata?.capability === 'authenticated-endpoint')).toBe(true);
        expect(overlay).not.toBeNull();
        expect(overlay!.capabilities).toContain('http-handler');
        expect(overlay!.capabilities).toContain('authenticated-endpoint');
        expect(overlay!.emergentApiCalls[0]).toMatchObject({
            method: 'GET',
            path: '/users/:id',
            direction: 'INBOUND',
            api_kind: 'rest',
        });
        expect(overlay!.allowedInboundPaths.has('/users/:id')).toBe(true);
    });

    it('extracts GraphQL resolver decorators into GraphQL endpoint overlays', () => {
        const src = `
import { Resolver, Query } from '@nestjs/graphql';

@Resolver(() => User)
export class UsersResolver {
  @Query(() => User, { name: 'user' })
  findOne() {
    return this.usersService.findOne();
  }
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/users/users.resolver.ts');
        const overlay = buildFrameworkSignalOverlay(
            'UsersResolver.findOne',
            matchFrameworkSignalsToChunk('UsersResolver.findOne', signals),
        );

        expect(overlay).not.toBeNull();
        expect(overlay!.capabilities).toContain('graphql-handler');
        expect(overlay!.emergentApiCalls[0]).toMatchObject({
            method: null,
            path: 'GRAPHQL QUERY user',
            direction: 'INBOUND',
            api_kind: 'graphql',
        });
    });

    it('extracts Bull processor decorators into MessageChannel overlays', () => {
        const src = `
import { Processor, Process } from '@nestjs/bull';

@Processor('emails')
export class EmailProcessor {
  @Process('welcome')
  handleWelcome() {
    return true;
  }
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/jobs/email.processor.ts');
        const overlay = buildFrameworkSignalOverlay(
            'EmailProcessor.handleWelcome',
            matchFrameworkSignalsToChunk('EmailProcessor.handleWelcome', signals),
        );

        expect(overlay).not.toBeNull();
        expect(overlay!.capabilities).toContain('message-consumer');
        expect(overlay!.infrastructure[0]).toMatchObject({
            name: 'emails',
            type: 'MessageChannel',
            operation: 'READS',
        });
    });

    it('extracts custom MessageConsumer decorators through the broker registry', () => {
        // Simulates what decorators config does in the pipeline
        registerCustomMessageConsumerDecorator('MessageConsumer');

        const src = `
function MessageConsumer(_: string) {
  return () => undefined;
}

export class OrderConsumer {
  @MessageConsumer('order.created.ready')
  handle() {
    return true;
  }
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/order.consumer.ts');
        const overlay = buildFrameworkSignalOverlay(
            'OrderConsumer.handle',
            matchFrameworkSignalsToChunk('OrderConsumer.handle', signals),
        );

        expect(overlay).not.toBeNull();
        expect(overlay!.capabilities).toContain('message-consumer');
        expect(overlay!.infrastructure[0]).toMatchObject({
            name: 'order.created.ready',
            type: 'MessageChannel',
            operation: 'READS',
        });

        // Clean up for test isolation
        clearCustomMessageConsumerDecorators();
    });

    it('extracts decorator-based DTO/schema field semantics', () => {
        const src = `
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Field, InputType } from '@nestjs/graphql';
import { IsOptional } from 'class-validator';

@InputType()
export class UserFilterInput {
  @Field(() => String, { name: 'email' })
  @ApiPropertyOptional({ required: false })
  @IsOptional()
  email?: string;
}
`;
        const tree = parseTree(src);
        const signals = plugin.extractFrameworkSignals!(tree.rootNode, src, 'src/users/dto/user-filter.input.ts');
        const fieldSignals = signals.filter(signal => signal.kind === 'schema-field');

        expect(signals.some(signal => signal.kind === 'schema-structure' && signal.ownerName === 'UserFilterInput')).toBe(true);
        expect(fieldSignals.length).toBeGreaterThan(0);
        expect(fieldSignals.some(signal => signal.ownerName === 'UserFilterInput.email' && signal.metadata?.required === false)).toBe(true);
        expect(fieldSignals.some(signal => signal.metadata?.alias === 'email')).toBe(true);
    });
});
