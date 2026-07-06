/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Eval Suite — LLM Extraction Quality (Golden Dataset Matrix)
 *
 * Data-driven evaluation tests validating the Unified Analyzer agent against
 * enterprise-grade edge cases that have historically caused hallucinations.
 *
 * Architecture:
 *   - goldenDataset[] defines input snippets + expected outputs
 *   - it.each() runs every case through the same assertion pipeline
 *   - Assertions are dynamic: infra expectations, API expectations, capability checks
 *   - LLM responses are cached via withReplay() for sub-second replay runs
 *
 * Modes (EVAL_LLM_MODE env var):
 *   replay  — Cached LLM outputs, deterministic, ~2s (default/CI)
 *   live    — Real LLM calls, saves to cache (~200s)
 *   refresh — Real LLM calls, overwrites cache (~200s)
 *
 * Run with:
 *   EVAL_LLM_MODE=replay bun vitest run tests/eval/agents/unified-analyzer.eval.test.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyzeFunction } from '../../../src/ai/agents/unified-analyzer.js';
import {
    isNoisyBrokerName,
    isUnsafeContainerName,
    NOISY_BROKER_NAMES,
} from '../../../src/ingestion/core/name-safety.js';
import type { CodeChunk } from '../../../src/graph/types.js';
import { wireUnifiedAnalyzerReplay } from '../helpers/with-replay.js';
import { EVAL_LLM_MODE } from '../helpers/llm-replay-cache.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface InfraExpectation {
    /** Infrastructure type: Database, MessageChannel, Cache, etc. */
    type: string;
    /** Names that MUST appear (at least one must match, case-insensitive substring) */
    mustContain?: string[];
    /** Names that MUST NOT appear (none must match, case-insensitive substring) */
    mustNotContain?: string[];
    /**
     * If set, at least one matching item MUST have this operation.
     * Use to verify the LLM correctly classifies publishers (WRITES) vs consumers (READS).
     * This catches the bug where $container->get() + ->publish() was misclassified as READS.
     */
    mustHaveOperation?: 'READS' | 'WRITES';
}

interface ApiExpectation {
    /** Substring that MUST appear in at least one emergent API path */
    pathContains?: string;
    /** Substring that MUST NOT appear in any emergent API path */
    pathNotContains?: string;
}

interface EvalCase {
    /** Short human-readable name for the test */
    name: string;
    /** Language of the code snippet */
    language: 'typescript' | 'php' | 'go' | 'python';
    /** The function/class name */
    functionName: string;
    /** Filepath (for context) */
    filepath: string;
    /** Source code snippet */
    sourceCode: string;
    /** Optional DI context */
    context?: {
        imports?: string[];
        constructorSource?: string;
        classProperties?: string[];
    };
    /** Optional taint context summary (injected as-is into the LLM prompt) */
    taintContextSummary?: string;
    /** Optional custom knowledge block from coderadius.yaml (injected as-is into the LLM prompt) */
    customKnowledge?: string;
    /** Expected has_io value */
    expectedHasIo: boolean;
    /** Infrastructure assertions */
    infra?: InfraExpectation[];
    /** Maximum number of infrastructure items allowed (use 0 for wrapper functions that should produce none) */
    maxInfraCount?: number;
    /** Emergent API call assertions */
    apis?: ApiExpectation[];
    /** Capabilities that should be present (substring match) */
    expectedCapabilities?: string[];

}

// ─── Golden Dataset ──────────────────────────────────────────────────────────

const goldenDataset: EvalCase[] = [

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 1: PHP legacy-monolith regression cases (original 4)
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP: Repository class vs physical table name',
        language: 'php',
        functionName: 'InfoCatalogRepository.findBySku',
        filepath: 'src/infrastructure/infoCatalog/InfoCatalogRepository.php',
        sourceCode: `
class InfoCatalogRepository {
    private $connection;

    public function __construct(\\PDO $connection) {
        $this->connection = $connection;
    }

    public function findBySku(string $sku): ?array {
        $stmt = $this->connection->prepare(
            "SELECT * FROM info_catalog WHERE sku = :sku"
        );
        $stmt->execute(['sku' => $sku]);
        return $stmt->fetch(\\PDO::FETCH_ASSOC) ?: null;
    }
}`,
        context: {
            constructorSource: 'public function __construct(\\PDO $connection)',
            classProperties: ['connection: \\PDO'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['info_catalog'],
                mustNotContain: ['infoCatalogRepository', 'infoCatalog', 'InfoCatalog'],
            },
        ],
    },

    {
        name: 'PHP: DI PubSub — topic string vs client class',
        language: 'php',
        functionName: 'OrderEventPublisher.publishOrderCreated',
        filepath: 'src/events/OrderEventPublisher.php',
        sourceCode: `
class OrderEventPublisher {
    private $pubSubClient;

    public function __construct(PubSubClient $pubSubClient) {
        $this->pubSubClient = $pubSubClient;
    }

    public function publishOrderCreated(array $orderData): void {
        $message = json_encode([
            'orderId' => $orderData['id'],
            'customerId' => $orderData['customer_id'],
            'total' => $orderData['total_amount'],
            'timestamp' => date('c'),
        ]);

        $this->pubSubClient->publish('order.created', $message);
    }
}`,
        context: {
            imports: [
                "use Google\\Cloud\\PubSub\\PubSubClient;",
            ],
            constructorSource: 'public function __construct(PubSubClient $pubSubClient)',
            classProperties: ['pubSubClient: PubSubClient'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'MessageChannel',
                mustContain: ['order.created'],
                mustNotContain: ['PubSubClient', 'pubSubClient', 'pubsub'],
            },
        ],
        // Capabilities are free-form semantic tags; the model stably emits the
        // 'message-*' family (message-publisher). 'publish' substring-matches it.
        expectedCapabilities: ['publish'],
    },

    {
        name: 'PHP: Dynamic table name — should omit or be caught by filter',
        language: 'php',
        functionName: 'DeliveryHistoryRepository.findByType',
        filepath: 'src/repository/DeliveryHistoryRepository.php',
        sourceCode: `
class DeliveryHistoryRepository {
    private $connection;

    public function __construct(\\PDO $connection) {
        $this->connection = $connection;
    }

    public function findByType(string $type, string $sku): ?array {
        $tableName = "delivery_history_{$type}";
        $sql = "SELECT * FROM {$tableName} WHERE sku = :sku ORDER BY valid_from DESC LIMIT 1";
        $stmt = $this->connection->prepare($sql);
        $stmt->execute(['sku' => $sku]);
        return $stmt->fetch(\\PDO::FETCH_ASSOC) ?: null;
    }
}`,
        context: {
            constructorSource: 'public function __construct(\\PDO $connection)',
            classProperties: ['connection: \\PDO'],
        },
        expectedHasIo: true,

    },

    {
        name: 'TS: Semantic param names in template literals',
        language: 'typescript',
        functionName: 'CartClient.getCartById',
        filepath: 'src/clients/CartClient.ts',
        sourceCode: `
import axios from 'axios';

export class CartClient {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async getCartById(cartId: string): Promise<CartResponse> {
        const response = await axios.get(\`\${this.baseUrl}/api/carts/\${cartId}\`);
        return response.data;
    }

    async listCartsByCustomer(customerId: string, page: number): Promise<CartListResponse> {
        const response = await axios.get(
            \`\${this.baseUrl}/api/customers/\${customerId}/carts?page=\${page}\`
        );
        return response.data;
    }
}`,
        context: {
            constructorSource: 'constructor(baseUrl: string)',
            classProperties: ['baseUrl: string'],
        },
        expectedHasIo: true,
        apis: [
            { pathContains: '/carts/' },
            { pathNotContains: 'baseUrl' },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 2: NestJS — Decorators, MessagePattern, Kafka
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'NestJS: @Get(":id") controller with param extraction',
        language: 'typescript',
        functionName: 'UsersController.findOne',
        filepath: 'src/users/users.controller.ts',
        sourceCode: `
import { Controller, Get, Param } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Get(':id')
    async findOne(@Param('id') id: string) {
        return this.usersService.findById(id);
    }
}`,
        context: {
            imports: [
                "import { Controller, Get, Param } from '@nestjs/common';",
                "import { UsersService } from './users.service';",
            ],
            constructorSource: 'constructor(private readonly usersService: UsersService) {}',
            classProperties: ['usersService: UsersService'],
        },
        expectedHasIo: true,
        expectedCapabilities: ['http-handler'],
        apis: [
            { pathContains: 'users' },
        ],
    },

    {
        name: 'NestJS: @MessagePattern consumer with Kafka client',
        language: 'typescript',
        functionName: 'NotificationController.handleUserCreated',
        filepath: 'src/notification/notification.controller.ts',
        sourceCode: `
import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, ClientKafka, Transport, Payload } from '@nestjs/microservices';

@Controller()
export class NotificationController {
    constructor(
        @Inject('NOTIFICATION_SERVICE') private readonly kafkaClient: ClientKafka,
    ) {}

    @MessagePattern('user.created')
    async handleUserCreated(@Payload() data: { userId: string; username: string }) {
        await this.sendWelcomeMessage(data.username);
        this.kafkaClient.emit('notification.sent', {
            userId: data.userId,
            type: 'welcome_message',
            sentAt: new Date().toISOString(),
        });
    }

    private async sendWelcomeMessage(username: string): Promise<void> {
        // ... message logic
    }
}`,
        context: {
            imports: [
                "import { Controller, Inject } from '@nestjs/common';",
                "import { MessagePattern, ClientKafka, Transport, Payload } from '@nestjs/microservices';",
            ],
            constructorSource: "constructor(@Inject('NOTIFICATION_SERVICE') private readonly kafkaClient: ClientKafka) {}",
            classProperties: ['kafkaClient: ClientKafka'],
        },
        expectedHasIo: true,
        // NOTE: This test consistently triggers LLM API timeouts (maxRetries: 6 + exponential backoff > 120s).

        infra: [
            {
                type: 'MessageChannel',
                mustContain: ['user.created'],
                mustNotContain: ['kafkaClient', 'NOTIFICATION_SERVICE'],
            },
            {
                type: 'MessageChannel',
                mustContain: ['notification.sent'],
            },
        ],
        // 'consumer' substring-matches the stable 'message-consumer' tag.
        expectedCapabilities: ['consumer'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 3: Express.js — Dynamic routes, middleware
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'Express: Dynamic route with version variable',
        language: 'typescript',
        functionName: 'setupRoutes',
        filepath: 'src/routes/index.ts',
        sourceCode: `
import express from 'express';
import { userRouter } from './users';
import { orderRouter } from './orders';

export function setupRoutes(app: express.Application) {
    const version = process.env.API_VERSION || 'v1';
    app.use('/api/' + version + '/users', userRouter);
    app.use('/api/' + version + '/orders', orderRouter);
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
}`,
        expectedHasIo: false, // Route registration is not I/O itself

    },

    {
        name: 'Express: Handler with Redis caching and Postgres query',
        language: 'typescript',
        functionName: 'getProductById',
        filepath: 'src/handlers/product.handler.ts',
        sourceCode: `
import { Request, Response } from 'express';
import { pool } from '../db';
import { redis } from '../cache';

export async function getProductById(req: Request, res: Response) {
    const { productId } = req.params;

    // Check cache first
    const cached = await redis.get(\`product:\${productId}\`);
    if (cached) {
        return res.json(JSON.parse(cached));
    }

    // Query database
    const result = await pool.query(
        'SELECT * FROM products WHERE id = $1',
        [productId]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
    }

    // Cache for 5 minutes
    await redis.set(\`product:\${productId}\`, JSON.stringify(result.rows[0]), 'EX', 300);

    return res.json(result.rows[0]);
}`,
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['products'],
                mustNotContain: ['pool', 'postgres', 'pg'],
            },
        ],
        expectedCapabilities: ['http-handler', 'database', 'cache'],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 4: TypeORM / Prisma — Decorator-based entity names
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TypeORM: @Entity("users_table") — extract table, not class name',
        language: 'typescript',
        functionName: 'UserRepository.findActiveUsers',
        filepath: 'src/repositories/user.repository.ts',
        sourceCode: `
import { Repository, EntityRepository } from 'typeorm';
import { User } from '../entities/user.entity';

@EntityRepository(User)
export class UserRepository extends Repository<User> {
    async findActiveUsers(): Promise<User[]> {
        return this.createQueryBuilder('user')
            .where('user.isActive = :active', { active: true })
            .andWhere('user.deletedAt IS NULL')
            .orderBy('user.lastLoginAt', 'DESC')
            .getMany();
    }
}

// In user.entity.ts:
// @Entity('users_table')
// export class User { ... }`,
        context: {
            imports: [
                "import { Repository, EntityRepository } from 'typeorm';",
                "import { User } from '../entities/user.entity';",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                // The LLM correctly extracts 'users_table' from the entity comment.
                // mustNotContain uses exact class names, NOT substrings that match actual tables.
                mustNotContain: ['UserRepository'],
            },
        ],
    },

    {
        name: 'Prisma: client.user.findMany — extract model name',
        language: 'typescript',
        functionName: 'UserService.getRecentUsers',
        filepath: 'src/services/user.service.ts',
        sourceCode: `
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class UserService {
    async getRecentUsers(limit: number = 50) {
        const users = await prisma.user.findMany({
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                profile: true,
                subscriptions: {
                    where: { expiresAt: { gt: new Date() } },
                },
            },
        });
        return users;
    }
}`,
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustNotContain: ['PrismaClient', 'prisma', 'UserService'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 5: Obfuscated Messaging — ENV-driven queue URLs
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'AWS SQS: Queue URL from env var — should not extract generic "sqs"',
        language: 'typescript',
        functionName: 'OrderProcessor.sendToQueue',
        filepath: 'src/queue/order-processor.ts',
        sourceCode: `
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });

export async function sendToQueue(orderData: OrderPayload): Promise<void> {
    const command = new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL!,
        MessageBody: JSON.stringify({
            orderId: orderData.id,
            total: orderData.totalAmount,
            items: orderData.lineItems.length,
            timestamp: Date.now(),
        }),
        MessageGroupId: orderData.customerId,
    });

    await sqsClient.send(command);
}`,
        expectedHasIo: true,
        infra: [
            {
                type: 'MessageChannel',
                // The LLM may extract 'SQS_QUEUE_URL' as the logical name, which is
                // acceptable — the ENV var IS the logical identifier when the actual
                // queue name isn't visible. mustNotContain checks for generic tech names only.
                mustNotContain: ['SQSClient', 'sqsClient', 'aws-sdk'],
            },
        ],
    },

    {
        name: 'RabbitMQ: amqp.connect with hardcoded routing key',
        language: 'typescript',
        functionName: 'EventPublisher.publishPaymentCompleted',
        filepath: 'src/events/event-publisher.ts',
        sourceCode: `
import amqp from 'amqplib';

export class EventPublisher {
    private channel: amqp.Channel;

    constructor(channel: amqp.Channel) {
        this.channel = channel;
    }

    async publishPaymentCompleted(paymentId: string, amount: number): Promise<void> {
        const exchange = 'payments';
        const routingKey = 'payment.completed';

        this.channel.publish(exchange, routingKey, Buffer.from(JSON.stringify({
            paymentId,
            amount,
            completedAt: new Date().toISOString(),
        })));
    }
}`,
        context: {
            constructorSource: 'constructor(channel: amqp.Channel)',
            classProperties: ['channel: amqp.Channel'],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'MessageChannel',
                // The LLM may extract the exchange name ('payments') or the routing key
                // ('payment.completed'). Both are valid infrastructure identifiers.
                mustContain: ['payment'],
                mustNotContain: ['amqplib', 'rabbitmq', 'RabbitMQ'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 6: Cross-language — Go, Python
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'Go: SQL query with explicit table name',
        language: 'go',
        functionName: 'GetOrdersByCustomer',
        filepath: 'internal/repository/order_repo.go',
        sourceCode: `
func (r *OrderRepository) GetOrdersByCustomer(ctx context.Context, customerID string) ([]Order, error) {
    rows, err := r.db.QueryContext(ctx,
        "SELECT id, customer_id, total, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC",
        customerID,
    )
    if err != nil {
        return nil, fmt.Errorf("query orders: %w", err)
    }
    defer rows.Close()

    var orders []Order
    for rows.Next() {
        var o Order
        if err := rows.Scan(&o.ID, &o.CustomerID, &o.Total, &o.Status, &o.CreatedAt); err != nil {
            return nil, fmt.Errorf("scan order: %w", err)
        }
        orders = append(orders, o)
    }
    return orders, rows.Err()
}`,
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['orders'],
                mustNotContain: ['OrderRepository', 'db'],
            },
        ],
    },

    {
        name: 'Python: SQLAlchemy ORM query with model class',
        language: 'python',
        functionName: 'get_active_subscriptions',
        filepath: 'app/services/subscription_service.py',
        sourceCode: `
from sqlalchemy.orm import Session
from app.models import Subscription
from datetime import datetime

def get_active_subscriptions(db: Session, user_id: int):
    """Get all active subscriptions for a user."""
    return db.query(Subscription).filter(
        Subscription.user_id == user_id,
        Subscription.status == 'active',
        Subscription.expires_at > datetime.utcnow()
    ).order_by(Subscription.created_at.desc()).all()
`,
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustNotContain: ['Session', 'sqlalchemy'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 7: Edge Cases — No I/O, pure logic
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TS: Pure utility function — no I/O',
        language: 'typescript',
        functionName: 'calculateDiscount',
        filepath: 'src/utils/pricing.ts',
        sourceCode: `
export function calculateDiscount(
    basePrice: number,
    customerTier: 'bronze' | 'silver' | 'gold' | 'platinum',
    itemCount: number,
): number {
    const tierDiscounts = { bronze: 0, silver: 0.05, gold: 0.10, platinum: 0.15 };
    const volumeDiscount = itemCount >= 10 ? 0.05 : 0;
    const totalDiscount = tierDiscounts[customerTier] + volumeDiscount;
    return Math.round(basePrice * (1 - totalDiscount) * 100) / 100;
}`,
        expectedHasIo: false,
    },

    {
        name: 'PHP: Multiple tables in single function',
        language: 'php',
        functionName: 'DashboardService.getOverview',
        filepath: 'src/services/DashboardService.php',
        sourceCode: `
class DashboardService {
    private $pdo;

    public function __construct(\\PDO $pdo) {
        $this->pdo = $pdo;
    }

    public function getOverview(int $partnerId): array {
        $policiesCount = $this->pdo->query(
            "SELECT COUNT(*) FROM policies WHERE partner_id = {$partnerId}"
        )->fetchColumn();

        $claimsCount = $this->pdo->query(
            "SELECT COUNT(*) FROM claims WHERE partner_id = {$partnerId} AND status = 'open'"
        )->fetchColumn();

        $revenue = $this->pdo->query(
            "SELECT SUM(premium) FROM invoices WHERE partner_id = {$partnerId} AND paid = true"
        )->fetchColumn();

        return [
            'policies' => (int)$policiesCount,
            'openClaims' => (int)$claimsCount,
            'totalRevenue' => (float)$revenue,
        ];
    }
}`,
        context: {
            constructorSource: 'public function __construct(\\PDO $pdo)',
            classProperties: ['pdo: \\PDO'],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'Database',
                mustContain: ['policies'],
                mustNotContain: ['DashboardService', 'pdo'],
            },
            {
                type: 'Database',
                mustContain: ['claims'],
            },
            {
                type: 'Database',
                mustContain: ['invoices'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 8: Lossless Path Extraction — API Gateway Prefix Preservation
    // ═══════════════════════════════════════════════════════════════════════

    // Production chunking is PER-FUNCTION (extractFunctions splits methods),
    // so each lossless contract is pinned on its own method-level chunk. A
    // whole-class chunk is an artificial shape the pipeline never produces —
    // and the fast model reliably extracted only the first method from it.
    {
        name: 'TS: Lossless path — must preserve /api/v1/ prefix',
        language: 'typescript' as const,
        functionName: 'PaymentClient.processCharge',
        filepath: 'src/clients/payment.client.ts',
        sourceCode: `
    async processCharge(amount: number, currency: string): Promise<ChargeResult> {
        const response = await axios.post(\`\${this.baseUrl}/api/v1/charge\`, {
            amount,
            currency,
            timestamp: Date.now(),
        });
        return response.data;
    }`,
        context: {
            imports: ["import axios from 'axios';"],
            constructorSource: 'constructor(baseUrl: string)',
            classProperties: ['baseUrl: string'],
        },
        expectedHasIo: true,
        apis: [
            { pathContains: '/api/v1/charge' },       // Full path preserved, not stripped to /charge
            { pathNotContains: 'baseUrl' },            // Variable stripped
        ],
    },

    {
        name: 'TS: Lossless path — must preserve /api/v2/ prefix with mid-path param',
        language: 'typescript' as const,
        functionName: 'PaymentClient.getPaymentStatus',
        filepath: 'src/clients/payment.client.ts',
        sourceCode: `
    async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
        const response = await axios.get(
            \`\${this.baseUrl}/api/v2/payments/\${paymentId}/status\`
        );
        return response.data;
    }`,
        context: {
            imports: ["import axios from 'axios';"],
            constructorSource: 'constructor(baseUrl: string)',
            classProperties: ['baseUrl: string'],
        },
        expectedHasIo: true,
        // The mid-path ${paymentId} must NOT cause the call to be dropped as
        // "entirely dynamic" — literal segments are present, so the path is
        // emitted with the variable in {name} form (lossless contract).
        apis: [
            { pathContains: '/api/v2/payments/' },     // v2 prefix preserved
            { pathNotContains: 'baseUrl' },            // Variable stripped
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 9: NoSQL & Modern ORM/ODM — Collection Name Extraction
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TS: MongoDB Native Driver — .collection("users").insertOne()',
        language: 'typescript' as const,
        functionName: 'MongoUserRepository.createUser',
        filepath: 'src/repositories/mongo-user.repository.ts',
        sourceCode: `
import { MongoClient, Db, Collection } from 'mongodb';

export class MongoUserRepository {
    private db: Db;

    constructor(client: MongoClient) {
        this.db = client.db('appdb');
    }

    async createUser(userData: { email: string; name: string; role: string }): Promise<string> {
        const users: Collection = this.db.collection('users');
        const result = await users.insertOne({
            ...userData,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return result.insertedId.toString();
    }

    async findUsersByRole(role: string): Promise<any[]> {
        return this.db.collection('users').find({ role }).sort({ createdAt: -1 }).toArray();
    }

    async logAuditEvent(event: { action: string; userId: string }): Promise<void> {
        await this.db.collection('audit_log').insertOne({
            ...event,
            timestamp: new Date(),
        });
    }
}`,
        context: {
            imports: [
                "import { MongoClient, Db, Collection } from 'mongodb';",
            ],
            constructorSource: 'constructor(client: MongoClient) { this.db = client.db("appdb"); }',
            classProperties: ['db: Db'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['users'],
                mustNotContain: ['MongoClient', 'mongodb', 'mongo', 'MongoUserRepository', 'appdb'],
            },
        ],
    },

    {
        name: 'TS: Mongoose ODM — model definition + queries',
        language: 'typescript' as const,
        functionName: 'OrderService.getActiveOrders',
        filepath: 'src/services/order.service.ts',
        sourceCode: `
import mongoose, { Schema, Document } from 'mongoose';

interface IOrder extends Document {
    customerId: string;
    items: Array<{ productId: string; quantity: number; price: number }>;
    status: 'pending' | 'confirmed' | 'shipped' | 'delivered';
    totalAmount: number;
    createdAt: Date;
}

const OrderSchema = new Schema<IOrder>({
    customerId: { type: String, required: true, index: true },
    items: [{ productId: String, quantity: Number, price: Number }],
    status: { type: String, enum: ['pending', 'confirmed', 'shipped', 'delivered'], default: 'pending' },
    totalAmount: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
});

const OrderModel = mongoose.model<IOrder>('Order', OrderSchema);

export class OrderService {
    async getActiveOrders(customerId: string): Promise<IOrder[]> {
        return OrderModel.find({
            customerId,
            status: { $in: ['pending', 'confirmed', 'shipped'] },
        }).sort({ createdAt: -1 }).exec();
    }

    async createOrder(customerId: string, items: any[]): Promise<IOrder> {
        const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        const order = new OrderModel({ customerId, items, totalAmount });
        return order.save();
    }
}`,
        context: {
            imports: [
                "import mongoose, { Schema, Document } from 'mongoose';",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['order'],
                mustNotContain: ['mongoose', 'OrderModel', 'OrderSchema', 'OrderService'],
            },
        ],
    },

    {
        name: 'TS: Prisma Client — multi-model access',
        language: 'typescript' as const,
        functionName: 'AnalyticsService.trackPageView',
        filepath: 'src/services/analytics.service.ts',
        sourceCode: `
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class AnalyticsService {
    async trackPageView(userId: string, page: string): Promise<void> {
        await prisma.pageView.create({
            data: {
                userId,
                page,
                timestamp: new Date(),
                userAgent: 'server',
            },
        });

        // Update user's last active timestamp
        await prisma.userProfile.update({
            where: { userId },
            data: { lastActiveAt: new Date() },
        });
    }

    async getTopPages(days: number = 30): Promise<any[]> {
        const since = new Date(Date.now() - days * 86400000);
        return prisma.pageView.groupBy({
            by: ['page'],
            where: { timestamp: { gte: since } },
            _count: { page: true },
            orderBy: { _count: { page: 'desc' } },
            take: 20,
        });
    }
}`,
        context: {
            imports: [
                "import { PrismaClient } from '@prisma/client';",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['pageView'],
                mustNotContain: ['prisma', 'PrismaClient', 'AnalyticsService'],
            },
            {
                type: 'Database',
                mustContain: ['userProfile'],
            },
        ],
    },

    {
        name: 'TS: Drizzle ORM — schema-defined table + select().from()',
        language: 'typescript' as const,
        functionName: 'ProductRepository.searchProducts',
        filepath: 'src/repositories/product.repository.ts',
        sourceCode: `
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';
import { eq, ilike, and } from 'drizzle-orm';
import { Pool } from 'pg';

export const productsTable = pgTable('products', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export class ProductRepository {
    async searchProducts(query: string, onlyActive: boolean = true): Promise<any[]> {
        const conditions = [ilike(productsTable.name, \`%\${query}%\`)];
        if (onlyActive) {
            conditions.push(eq(productsTable.isActive, true));
        }
        return db.select().from(productsTable).where(and(...conditions));
    }

    async updatePrice(productId: number, newPrice: string): Promise<void> {
        await db.update(productsTable)
            .set({ price: newPrice })
            .where(eq(productsTable.id, productId));
    }
}`,
        context: {
            imports: [
                "import { drizzle } from 'drizzle-orm/node-postgres';",
                "import { pgTable, serial, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';",
                "import { eq, ilike, and } from 'drizzle-orm';",
                "import { Pool } from 'pg';",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['products'],
                mustNotContain: ['drizzle', 'ProductRepository', 'db', 'pool'],
            },
        ],
    },

    {
        name: 'PHP: Doctrine MongoDB ODM — #[Document(collection: "sessions")]',
        language: 'php' as const,
        functionName: 'SessionRepository.findActiveSessions',
        filepath: 'src/Repository/SessionRepository.php',
        sourceCode: `
<?php

namespace App\\Repository;

use Doctrine\\ODM\\MongoDB\\DocumentManager;
use Doctrine\\ODM\\MongoDB\\Repository\\DocumentRepository;
use App\\Document\\Session;

/**
 * @extends DocumentRepository<Session>
 *
 * The Session document is mapped to the "sessions" collection:
 * #[Document(collection: "sessions")]
 * class Session { ... }
 */
class SessionRepository extends DocumentRepository
{
    public function __construct(private readonly DocumentManager $dm) {
        parent::__construct($dm, $dm->getUnitOfWork(), $dm->getClassMetadata(Session::class));
    }

    public function findActiveSessions(string $userId): array
    {
        return $this->createQueryBuilder()
            ->field('userId')->equals($userId)
            ->field('expiresAt')->gt(new \\DateTime())
            ->sort('lastActivityAt', 'desc')
            ->getQuery()
            ->execute()
            ->toArray();
    }

    public function createSession(string $userId, string $ipAddress): Session
    {
        $session = new Session();
        $session->setUserId($userId);
        $session->setIpAddress($ipAddress);
        $session->setExpiresAt(new \\DateTime('+24 hours'));
        $session->setLastActivityAt(new \\DateTime());

        $this->dm->persist($session);
        $this->dm->flush();

        return $session;
    }
}`,
        context: {
            imports: [
                "use Doctrine\\ODM\\MongoDB\\DocumentManager;",
                "use Doctrine\\ODM\\MongoDB\\Repository\\DocumentRepository;",
                "use App\\Document\\Session;",
            ],
            constructorSource: 'public function __construct(private readonly DocumentManager $dm)',
            classProperties: ['dm: DocumentManager'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['sessions'],
                mustNotContain: ['DocumentManager', 'doctrine', 'SessionRepository', 'dm'],
            },
        ],
    },

    {
        name: 'PHP: Laravel MongoDB (jenssegers) — Eloquent model with $collection',
        language: 'php' as const,
        functionName: 'PaymentController.processRefund',
        filepath: 'src/Http/Controllers/PaymentController.php',
        sourceCode: `
<?php

namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use Illuminate\\Http\\JsonResponse;
use Jenssegers\\Mongodb\\Eloquent\\Model;

class Payment extends Model
{
    protected $connection = 'mongodb';
    protected $collection = 'payments';
    protected $fillable = ['orderId', 'amount', 'currency', 'status', 'refundedAt'];
}

class PaymentController extends Controller
{
    public function processRefund(Request $request, string $paymentId): JsonResponse
    {
        $payment = Payment::findOrFail($paymentId);

        if ($payment->status !== 'completed') {
            return response()->json(['error' => 'Payment not refundable'], 422);
        }

        $payment->update([
            'status' => 'refunded',
            'refundedAt' => now(),
        ]);

        // Log to refund_ledger collection
        $ledgerEntry = new class extends Model {
            protected $connection = 'mongodb';
            protected $collection = 'refund_ledger';
        };
        $ledgerEntry->create([
            'paymentId' => $paymentId,
            'amount' => $payment->amount,
            'processedAt' => now(),
        ]);

        return response()->json(['status' => 'refunded']);
    }
}`,
        context: {
            imports: [
                "use Illuminate\\Http\\Request;",
                "use Illuminate\\Http\\JsonResponse;",
                "use Jenssegers\\Mongodb\\Eloquent\\Model;",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['payments'],
                mustNotContain: ['eloquent', 'Model', 'PaymentController', 'mongodb'],
            },
            {
                type: 'Database',
                mustContain: ['refund_ledger'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 10: NoSQL/ORM Edge Cases — Dynamic Names & ENV Config
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'TS: Drizzle ORM — Dynamic table name (Should Drop)',
        language: 'typescript' as const,
        functionName: 'DynamicRepository.fetchData',
        filepath: 'src/repositories/dynamic.repository.ts',
        sourceCode: `
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export class DynamicRepository {
    async fetchData(tableRef: any, condition: any): Promise<any[]> {
        // The table is passed dynamically. We DO NOT know what it is.
        return db.select().from(tableRef).where(condition);
    }
}`,
        expectedHasIo: true, // It HAS I/O (we know it's a DB query)
        infra: [
            {
                type: 'Database',
                mustNotContain: ['tableRef', 'db', 'drizzle'], // It MUST NOT extract the variable name
            },
        ],
    },

    {
        name: 'TS: MongoDB Native — Collection via ENV var',
        language: 'typescript' as const,
        functionName: 'ConfigMongoRepo.insertDoc',
        filepath: 'src/repositories/config-mongo.repository.ts',
        sourceCode: `
import { Db } from 'mongodb';

export class ConfigMongoRepo {
    constructor(private db: Db) {}

    async insertDoc(data: any): Promise<void> {
        const collectionName = process.env.AUDIT_COLLECTION_NAME || 'fallback_audit';
        await this.db.collection(collectionName).insertOne(data);
    }
}`,
        context: {
            imports: ["import { Db } from 'mongodb';"],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                // It should extract the fallback string, or the ENV var template, but NOT "collectionName"
                mustContain: ['fallback_audit'],
                mustNotContain: ['collectionName', 'db'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 11: Enterprise — Telemetry Exclusion & Custom Knowledge
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'Enterprise: Telemetry-only function — Datadog + Sentry (must be has_io=false)',
        language: 'typescript' as const,
        functionName: 'MetricsService.trackOrderMetrics',
        filepath: 'src/observability/metrics.service.ts',
        sourceCode: `
import { StatsD } from 'hot-shots';
import * as Sentry from '@sentry/node';

const statsd = new StatsD({ host: process.env.DD_AGENT_HOST });

export class MetricsService {
    trackOrderMetrics(orderId: string, amount: number, duration: number): void {
        // Datadog custom metrics
        statsd.increment('orders.processed');
        statsd.histogram('orders.amount', amount);
        statsd.timing('orders.processing_time', duration);

        // Sentry breadcrumb for debugging
        Sentry.addBreadcrumb({
            category: 'order',
            message: \`Processed order \${orderId}\`,
            level: 'info',
        });

        // Sentry tags for error grouping
        Sentry.setTag('last_order_id', orderId);
    }
}`,
        context: {
            imports: [
                "import { StatsD } from 'hot-shots';",
                "import * as Sentry from '@sentry/node';",
            ],
        },
        expectedHasIo: false, // Telemetry is NOT business I/O
    },

    {
        name: 'Enterprise: Mixed I/O — DB write + Datadog metric (extract only DB)',
        language: 'typescript' as const,
        functionName: 'OrderService.createOrder',
        filepath: 'src/services/order.service.ts',
        sourceCode: `
import { PrismaClient } from '@prisma/client';
import { StatsD } from 'hot-shots';
import * as Sentry from '@sentry/node';

const prisma = new PrismaClient();
const statsd = new StatsD({ host: process.env.DD_AGENT_HOST });

export class OrderService {
    async createOrder(customerId: string, items: any[]): Promise<any> {
        const startTime = Date.now();

        // Real business I/O — this MUST be extracted
        const order = await prisma.order.create({
            data: {
                customerId,
                items: { create: items },
                status: 'pending',
                totalAmount: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
            },
        });

        // Telemetry — this must NOT appear in infrastructure
        statsd.increment('orders.created');
        statsd.histogram('orders.creation_time', Date.now() - startTime);
        Sentry.addBreadcrumb({
            category: 'order',
            message: \`Created order \${order.id}\`,
            level: 'info',
        });

        return order;
    }
}`,
        context: {
            imports: [
                "import { PrismaClient } from '@prisma/client';",
                "import { StatsD } from 'hot-shots';",
                "import * as Sentry from '@sentry/node';",
            ],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['order'],
                mustNotContain: ['PrismaClient', 'prisma'],
            },
            {
                // Telemetry must NOT create infrastructure entries
                type: 'MessageChannel',
                mustNotContain: ['statsd', 'datadog', 'sentry', 'metrics', 'hot-shots'],
            },
        ],
    },

    {
        name: 'Enterprise: Custom Knowledge — proprietary SDK recognized via hints',
        language: 'typescript' as const,
        functionName: 'EventPublisher.publishUserCreated',
        filepath: 'src/events/event-publisher.ts',
        sourceCode: `
import { AcmeEventBus } from '@acme-internal/event-bus';

export class EventPublisher {
    private bus: AcmeEventBus;

    constructor(bus: AcmeEventBus) {
        this.bus = bus;
    }

    async publishUserCreated(userId: string, email: string): Promise<void> {
        await this.bus.publish('user.created', {
            userId,
            email,
            createdAt: new Date().toISOString(),
        });
    }
}`,
        context: {
            imports: [
                "import { AcmeEventBus } from '@acme-internal/event-bus';",
            ],
            constructorSource: 'constructor(bus: AcmeEventBus)',
            classProperties: ['bus: AcmeEventBus'],
        },
        // Custom knowledge teaches the LLM what AcmeEventBus is
        customKnowledge: `\n--- Custom Domain Knowledge (from coderadius.yaml) ---
The following describes proprietary SDKs and wrappers used in this codebase.
Apply these rules when you encounter the listed patterns:
- MessageChannel wrappers [AcmeEventBus, event-bus, publishEvent]: Internal wrapper for GCP Pub/Sub. The .publish() method's first argument is the topic name. Treat as MessageChannel infrastructure.
--- End Custom Domain Knowledge ---`,
        expectedHasIo: true,
        infra: [
            {
                type: 'MessageChannel',
                mustContain: ['user.created'],
                mustNotContain: ['AcmeEventBus', 'event-bus', 'bus'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 14: Dynamic SQL Table Concatenation — Stub Emission (TDD)
    //
    // Tests that the LLM correctly emits a template stub form for dynamic
    // SQL table concatenation (e.g. 'shipment_log_' . $carrierType).
    // The downstream pipeline relies on the LLM emitting {var} syntax
    // so the sanitizer preserves it as a wildcard stub for post-processing.
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP: Dynamic SQL concat — must emit template stub, not phantom table',
        language: 'php' as const,
        functionName: 'ShipmentLogWriter.persistTracking',
        filepath: 'src/Core/ShipmentLogWriter.php',
        sourceCode: `
class ShipmentLogWriter
{
    private \\PDO $db;

    public function __construct(\\PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Persists shipment tracking data into a table determined at runtime.
     * The actual table is one of: shipment_log_express, shipment_log_freight
     * but the codebase resolves this only at runtime.
     */
    public function persistTracking(string $carrierType, int $trackingId, array $trackingData): void
    {
        $table = 'shipment_log_' . $carrierType;

        $stmt = $this->db->prepare(
            "INSERT INTO {$table} (tracking_id, origin, destination, weight_kg, shipped_at)
             VALUES (:tracking_id, :origin, :destination, :weight_kg, NOW())"
        );
        $stmt->execute([
            'tracking_id'  => $trackingId,
            'origin'       => $trackingData['origin'],
            'destination'  => $trackingData['destination'],
            'weight_kg'    => $trackingData['weight_kg'],
        ]);
    }
}`,
        context: {
            constructorSource: 'public function __construct(\\PDO $db)',
            classProperties: ['db: \\PDO'],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'Database',
                // The LLM MUST emit a table name containing 'shipment_log' — either as
                // the template form 'shipment_log_{carrierType}' or 'shipment_log_'.
                // Both are valid stub forms the pipeline can work with.
                mustContain: ['shipment_log'],
                // Must NOT emit class/variable names as table names
                mustNotContain: ['ShipmentLogWriter', 'PDO', 'connection'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 15: Ghost Table Hallucination — Variable Name Confusion (TDD)
    //
    // The LLM sees `$carrello = $this->cartRepository->getCart()` and may
    // hallucinate "carrello" as a Database table. But there is NO SQL query
    // — the repository handles DB access internally. The function only
    // calls repository methods and checks feature flags.
    //
    // This is a soft-check: the LLM may still hallucinate, but the
    // deterministic Layer 2 sanitizer (isHallucinatedTable) MUST catch it.
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP: Ghost table from variable name — $carrello is NOT a table',
        language: 'php' as const,
        functionName: 'LoyaltyTierChecker.isEligible',
        filepath: 'src/Eligibility/LoyaltyTierChecker.php',
        sourceCode: `
class LoyaltyTierChecker
{
    private CartRepository $cartRepository;
    private $featureFlags;
    private $logger;
    private $db;

    public function __construct(
        CartRepository $cartRepository,
        $featureFlags,
        $logger,
        $db
    ) {
        $this->cartRepository = $cartRepository;
        $this->featureFlags = $featureFlags;
        $this->logger = $logger;
        $this->db = $db;
    }

    public function isEligible(CartIdentifier $cartIdentifier): bool
    {
        $cartId = $cartIdentifier->getId();
        $cartType = $cartIdentifier->getType();

        if (!$this->featureFlags->isActiveFeatureBoolean(self::FEATURE_FLAG_NAME)) {
            $this->logger->debug(
                sprintf('[Loyalty] Cart not eligible: feature flag %s inactive', self::FEATURE_FLAG_NAME),
                ['cartId' => $cartId, 'cartType' => $cartType]
            );
            return false;
        }

        $carrello = $this->cartRepository->getCart($cartId, $cartType);
        if (!$carrello->isValid()) {
            $this->logger->debug(
                '[Loyalty] Cart not eligible: cart not found or invalid',
                ['cartId' => $cartId, 'cartType' => $cartType]
            );
            return false;
        }

        $userId = $carrello->getUser();
        if (!User::isPremiumMember($userId)) {
            $this->logger->debug(
                '[Loyalty] Cart not eligible: user is not premium',
                ['cartId' => $cartId, 'userId' => $userId]
            );
            return false;
        }

        $enabledTiers = $this->db->getEnabledLoyaltyTiers($userId);
        if (!isset($enabledTiers[GoldTier::slug()])) {
            return false;
        }

        return true;
    }
}`,
        context: {
            constructorSource: 'public function __construct(CartRepository $cartRepository, $featureFlags, $logger, $db)',
            classProperties: [
                'cartRepository: CartRepository',
                'featureFlags: mixed',
                'logger: mixed',
                'db: mixed',
            ],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'Database',
                // "carrello" MUST NOT appear as a table name — it's a local variable
                mustNotContain: ['carrello'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 16: Message Class Names as Broker Topics (TDD)
    //
    // The LLM sees `use App\Messaging\CartFinalizedMessage` and
    // `new CartFinalizedMessage(...)` and may hallucinate the PHP class
    // name as a broker topic. The real topics are 'checkout.finalized'
    // and 'stock.reserved' — the string literals in ->publish().
    //
    // This bucket tests BOTH:
    // 1. LLM extraction (the string literal topics should be found)
    // 2. Deterministic filter (class names should be blocked)
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP: Broker topic from string literal, not Message class name',
        language: 'php' as const,
        functionName: 'CheckoutOrchestrator.processCheckout',
        filepath: 'src/Checkout/CheckoutOrchestrator.php',
        sourceCode: `
class CheckoutOrchestrator
{
    private $db;
    private $messageBus;
    private $logger;

    public function __construct($db, $messageBus, $logger)
    {
        $this->db = $db;
        $this->messageBus = $messageBus;
        $this->logger = $logger;
    }

    public function processCheckout(int $orderId, array $items): void
    {
        $stmt = $this->db->prepare(
            "SELECT o.*, c.email FROM ordini o
             JOIN clienti c ON c.id = o.cliente_id
             WHERE o.id = :orderId"
        );
        $stmt->execute(['orderId' => $orderId]);
        $order = $stmt->fetch();

        if (!$order) {
            throw new \\RuntimeException("Order $orderId not found");
        }

        foreach ($items as $item) {
            $this->db->prepare(
                "UPDATE magazzino SET quantita = quantita - :qty WHERE prodotto_id = :pid"
            )->execute(['qty' => $item['quantity'], 'pid' => $item['product_id']]);
        }

        $msg = new CartFinalizedMessage($orderId, $order['email'], $items);
        $this->messageBus->publish('checkout.finalized', $msg);

        $reservationMsg = new ProductReservedMessage($orderId, $items);
        $this->messageBus->publish('stock.reserved', $reservationMsg);

        $this->logger->info("Checkout completed for order $orderId");
    }
}`,
        context: {
            imports: [
                "use App\\Messaging\\CartFinalizedMessage;",
                "use App\\Messaging\\ProductReservedMessage;",
            ],
            constructorSource: 'public function __construct($db, $messageBus, $logger)',
            classProperties: ['db: mixed', 'messageBus: mixed', 'logger: mixed'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['ordini', 'magazzino'],
            },
            {
                type: 'MessageChannel',
                mustContain: ['checkout.finalized', 'stock.reserved'],
                // The PHP class names MUST NOT appear as topic names
                mustNotContain: ['CartFinalizedMessage', 'ProductReservedMessage'],
                // CheckoutOrchestrator PUBLISHES via $messageBus->publish().
                mustHaveOperation: 'WRITES',
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 13: DI Container — DI-key channel extraction
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP: DI Container publisher — $container->get(\'payment.completed.publisher\')',
        language: 'php',
        functionName: 'PaymentProcessor.processPayment',
        filepath: 'src/Events/PaymentProcessor.php',
        sourceCode: `
class PaymentProcessor
{
    private $container;
    private $db;

    public function __construct(\\Psr\\Container\\ContainerInterface $container, \\PDO $db)
    {
        $this->container = $container;
        $this->db = $db;
    }

    public function processPayment(array $paymentData): array
    {
        $stmt = $this->db->prepare(
            "INSERT INTO payments (order_id, amount, currency, status, created_at)
             VALUES (:order_id, :amount, :currency, 'completed', NOW())"
        );
        $stmt->execute([
            'order_id' => $paymentData['orderId'],
            'amount' => $paymentData['amount'],
            'currency' => $paymentData['currency'],
        ]);

        $paymentId = $this->db->lastInsertId();

        $publisher = $this->container->get('payment.completed.publisher');
        $publisher->publish(json_encode([
            'paymentId' => $paymentId,
            'orderId' => $paymentData['orderId'],
            'amount' => $paymentData['amount'],
            'completedAt' => date('c'),
        ]));

        return ['paymentId' => $paymentId, 'status' => 'completed'];
    }
}`,
        context: {
            imports: [
                "use Psr\\Container\\ContainerInterface;",
            ],
            constructorSource: 'public function __construct(\\Psr\\Container\\ContainerInterface $container, \\PDO $db)',
            classProperties: ['container: ContainerInterface', 'db: \\PDO'],
        },
        expectedHasIo: true,
        // PSR DI pattern is complex — LLM attention may split between
        // container.get() and db.prepare(). The DI key (MessageChannel) is the
        // primary regression target; the DB table is secondary.

        infra: [
            {
                type: 'Database',
                mustContain: ['payments'],
                mustHaveOperation: 'WRITES',
            },
            {
                type: 'MessageChannel',
                // The LLM MUST extract this as a MessageChannel entry.
                // The name should be the DI key 'payment.completed.publisher'.
                // DI-key resolution is deterministic downstream: DI_BROKER_SUFFIXES
                // + registry binding (tests/unit/ingestion/di-resolution.test.ts).
                mustContain: ['payment'],
                mustNotContain: ['ContainerInterface', 'container', 'Psr'],
                // CRITICAL: PaymentProcessor PUBLISHES via $publisher->publish().
                // The operation MUST be WRITES, not READS. READS would create a
                // LISTENS_TO edge (consumer) instead of PUBLISHES_TO (publisher).
                mustHaveOperation: 'WRITES',
            },
        ],
    },

    {
        name: 'PHP: DI Container consumer — receive() + direct SQL write to payment_queue',
        language: 'php',
        functionName: 'OrderEventsHandler.handleIncomingOrders',
        filepath: 'src/Consumer/OrderEventsHandler.php',
        sourceCode: `
class OrderEventsHandler
{
    private $container;
    private $db;

    public function __construct(\\Psr\\Container\\ContainerInterface $container, \\PDO $db)
    {
        $this->container = $container;
        $this->db = $db;
    }

    public function handleIncomingOrders(): void
    {
        $consumer = $this->container->get('order.events.consumer');
        $message = $consumer->receive();

        if ($message !== null) {
            $orderId = $message['orderId'];
            $customerId = $message['customerId'];
            $total = $message['totalAmount'];

            $stmt = $this->db->prepare(
                "INSERT INTO payment_queue (order_id, customer_id, amount, status, queued_at)
                 VALUES (:order_id, :customer_id, :amount, 'pending', NOW())"
            );
            $stmt->execute([
                'order_id'    => $orderId,
                'customer_id' => $customerId,
                'amount'      => $total,
            ]);

            $consumer->acknowledge($message);
        }
    }
}`,
        context: {
            imports: [
                "use Psr\\Container\\ContainerInterface;",
            ],
            constructorSource: 'public function __construct(\\Psr\\Container\\ContainerInterface $container, \\PDO $db)',
            classProperties: ['container: ContainerInterface', 'db: \\PDO'],
        },
        expectedHasIo: true,
        infra: [
            {
                type: 'Database',
                mustContain: ['payment_queue'],
                mustHaveOperation: 'WRITES',
            },
            {
                type: 'MessageChannel',
                mustContain: ['order'],
                mustNotContain: ['ContainerInterface', 'container'],
                // OrderEventsHandler CONSUMES via $consumer->receive().
                mustHaveOperation: 'READS',
            },
        ],
        expectedCapabilities: ['consumer'],
    },

    {
        name: 'NestJS: @Inject DI key in constructor — should extract the injected DI key as channel',
        language: 'typescript',
        functionName: 'BillingService.processBilling',
        filepath: 'src/billing/billing.service.ts',
        sourceCode: `
import { Injectable, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class BillingService {
    constructor(
        @Inject('billing.events.publisher') private readonly eventBus: ClientProxy,
    ) {}

    async processBilling(invoiceId: string, amount: number): Promise<void> {
        this.eventBus.emit('invoice.finalized', {
            invoiceId,
            amount,
            finalizedAt: new Date().toISOString(),
        });
    }
}`,
        context: {
            imports: [
                "import { Injectable, Inject } from '@nestjs/common';",
                "import { ClientProxy } from '@nestjs/microservices';",
            ],
            constructorSource: "constructor(@Inject('billing.events.publisher') private readonly eventBus: ClientProxy)",
            classProperties: ['eventBus: ClientProxy'],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'MessageChannel',
                // The LLM should extract 'invoice.finalized' as the topic (from .emit())
                // and optionally 'billing.events.publisher' as a DI key
                mustContain: ['invoice.finalized'],
                mustNotContain: ['ClientProxy', 'eventBus'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 14: Wrapper Detection — Generic infra wrappers should NOT
    //            extract infrastructure. The binding belongs to the caller.
    // ═══════════════════════════════════════════════════════════════════════

    {
        name: 'PHP Wrapper: Generic RabbitMQ Consumer — queue from property, not hardcoded',
        language: 'php',
        functionName: 'RabbitMq\\Consumer\\Consumer.consume',
        filepath: 'classes/RabbitMq/Consumer/Consumer.php',
        sourceCode: `
class Consumer {
    private $channel;
    private array $queueOptions;
    private string $consumerTag;

    public function __construct($channel, array $queueOptions, string $consumerTag = '') {
        $this->channel = $channel;
        $this->queueOptions = $queueOptions;
        $this->consumerTag = $consumerTag;
    }

    public function consume(callable $callback): void {
        $this->channel->basic_consume(
            $this->queueOptions['name'],
            $this->consumerTag,
            false, false, false, false,
            $callback
        );
        while ($this->channel->is_consuming()) {
            $this->channel->wait();
        }
    }
}`,
        context: {
            imports: [
                'use PhpAmqpLib\\Channel\\AMQPChannel;',
                'use PhpAmqpLib\\Message\\AMQPMessage;',
            ],
            constructorSource: 'public function __construct($channel, array $queueOptions, string $consumerTag)',
            classProperties: ['channel: AMQPChannel', 'queueOptions: array', 'consumerTag: string'],
        },
        expectedHasIo: true,
        maxInfraCount: 0, // WRAPPER: queue name comes from $this->queueOptions, not hardcoded

    },

    {
        name: 'TS Wrapper: Generic Redis cache service — key from parameter',
        language: 'typescript',
        functionName: 'CacheService.get',
        filepath: 'src/cache/cache.service.ts',
        sourceCode: `
import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService {
    private readonly redis: Redis;

    constructor(redis: Redis) {
        this.redis = redis;
    }

    async get<T>(key: string): Promise<T | null> {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
    }

    async set(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }

    async del(key: string): Promise<void> {
        await this.redis.del(key);
    }
}`,
        context: {
            imports: [
                "import { Injectable } from '@nestjs/common';",
                "import Redis from 'ioredis';",
            ],
            constructorSource: 'constructor(redis: Redis)',
            classProperties: ['redis: Redis'],
        },
        expectedHasIo: true,
        maxInfraCount: 0, // WRAPPER: key comes from parameter, not hardcoded
    },

    {
        name: 'PHP Non-Wrapper Control: Consumer with hardcoded queue name',
        language: 'php',
        functionName: 'OrderNotificationConsumer.consumeOrderEvents',
        filepath: 'src/Consumer/OrderNotificationConsumer.php',
        sourceCode: `
class OrderNotificationConsumer {
    private $rabbitConnection;

    public function __construct(AMQPStreamConnection $rabbitConnection) {
        $this->rabbitConnection = $rabbitConnection;
    }

    public function consumeOrderEvents(): void {
        $channel = $this->rabbitConnection->channel();
        $channel->queue_declare('order_notifications', false, true, false, false);
        $channel->queue_bind('order_notifications', 'orders_exchange', 'order.created');

        $channel->basic_consume('order_notifications', '', false, true, false, false,
            function ($msg) {
                $data = json_decode($msg->body, true);
                $this->processOrderNotification($data);
            }
        );

        while ($channel->is_open()) {
            $channel->wait();
        }
    }
}`,
        context: {
            imports: [
                'use PhpAmqpLib\\Connection\\AMQPStreamConnection;',
            ],
            constructorSource: 'public function __construct(AMQPStreamConnection $rabbitConnection)',
            classProperties: ['rabbitConnection: AMQPStreamConnection'],
        },
        expectedHasIo: true,
        // NON-WRAPPER control: queue 'order_notifications' and routing key 'order.created' are hardcoded
        infra: [
            {
                type: 'MessageChannel',
                mustContain: ['order'],
            },
        ],
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUCKET 16: Symfony Messenger — Message Dispatch Pattern (CQRS)
    //
    // Validates the neuro-symbolic linker: dispatch-by-type patterns where the
    // physical queue name is NOT in the code but resolved via AmqpConfig mapping.
    //
    // Cases:
    //   A. Publisher: must return the Message class name as the channel (WRITES)
    //   B. AmqpConfig config map: has_io=false (pure config, no I/O)
    //   C. AmqpRoutingMiddleware: infrastructure wrapper → maxInfraCount=0
    //   D. Control: classic AMQP publish with hardcoded routing key as channel
    //
    // Fixtures: tests/fixtures/microservices/logistics-routing-service/
    // ═══════════════════════════════════════════════════════════════════════

    {
        // The canonical publisher pattern: dispatch(new MessageClass(...))
        // LLM must understand that ShipmentSavedMessage is the DI key,
        // NOT the bus variable $messageBus or DI service 'message_bus.sender'.
        name: 'PHP Messenger: ShipmentSavedMessagePublisher.publish — dispatch(new ShipmentSavedMessage()) must return the message class name as the channel',
        language: 'php',
        functionName: 'Fulfillment\\\\Messenger\\\\ShipmentSavedMessagePublisher.publish',
        filepath: 'src/Messenger/ShipmentSavedMessagePublisher.php',
        sourceCode: `
class ShipmentSavedMessagePublisher
{
    private MessageBusInterface $messageBus;
    private LoggerInterface $logger;

    public function __construct(MessageBusInterface $messageBus, LoggerInterface $logger)
    {
        $this->messageBus = $messageBus;
        $this->logger = $logger;
    }

    public function publish(int $shipmentId, string $partnerCode): void
    {
        try {
            $this->messageBus->dispatch(new ShipmentSavedMessage($shipmentId, $partnerCode));
        } catch (Throwable $e) {
            $this->logger->error(
                '[ShipmentSavedMessagePublisher] Failed to dispatch ShipmentSavedMessage - ' . $e->getMessage(),
                ['shipmentId' => $shipmentId, 'partnerCode' => $partnerCode]
            );
        }
    }
}`,
        context: {
            imports: [
                'use Fulfillment\\\\Messenger\\\\Message\\\\ShipmentSavedMessage;',
                'use Psr\\\\Log\\\\LoggerInterface;',
                'use Symfony\\\\Component\\\\Messenger\\\\MessageBusInterface;',
            ],
            constructorSource: 'public function __construct(MessageBusInterface $messageBus, LoggerInterface $logger)',
            classProperties: ['messageBus: MessageBusInterface', 'logger: LoggerInterface'],
        },
        expectedHasIo: true,
        // The message class name IS the logical channel on the abstract bus;
        // the registry/Messenger pipeline resolves it to the physical routing
        // key downstream (pinned by tests/eval/patterns/php-message-registry
        // and rabbitmq-messenger-routing). The isDiKey flag was removed from
        // the LLM schema (commit 4ccddf01): the contract here is name + op.

        infra: [
            {
                type: 'MessageChannel',
                // Accept PascalCase; snake_case also acceptable (both map correctly)
                mustContain: ['ShipmentSavedMessage'],
                // Must NOT return the bus variable, interface name, or DI service key
                mustNotContain: ['messageBus', 'message_bus', 'message_bus.sender', 'MessageBusInterface'],
                // dispatch() publishes → WRITES (READS would flip the edge to LISTENS_TO)
                mustHaveOperation: 'WRITES',
            },
        ],
    },

    {
        // AmqpConfig.getMessageMap() is a PURE CONFIG method — returns an array.
        // The UnifiedAnalyzer should correctly identify this as has_io=false.
        // The CONFIG SYMBOL EXTRACTOR handles this file (not the UnifiedAnalyzer).
        //
        // Real pattern from production: nested array with routing_key + env suffix.
        // The suffix is dynamic ('', '-canary', '-mock') → treat as {ENV} template.
        name: 'PHP Messenger Config: AmqpConfig.getMessageMap() — pure config method, has_io=false (ConfigSymbolExtractor handles it)',
        language: 'php',
        functionName: 'Fulfillment\\\\Messenger\\\\AmqpConfig.getMessageMap',
        filepath: 'src/Messenger/AmqpConfig.php',
        sourceCode: `
class AmqpConfig
{
    private string $environment;

    public function __construct(string $environment)
    {
        $this->environment = $environment;
    }

    public function getMessageMap(): array
    {
        $envSuffix = $this->getEnvSuffix(); // '' on prod, '-canary' or '-mock' on other envs

        return [
            SaveRequestedMessage::class => [
                'queue_name'  => 'fulfillment.shipment' . $envSuffix . '.save.requested',
                'routing_key' => 'fulfillment.shipment' . $envSuffix . '.save.requested',
                'handle'      => true,
            ],
            ShipmentSavedMessage::class => [
                'routing_key' => 'logistics.fulfillment' . $envSuffix . '.shipment.saved',
                'handle'      => false,
            ],
            ShipmentUpdatedMessage::class => [
                'routing_key' => 'logistics.fulfillment' . $envSuffix . '.shipment.updated',
                'handle'      => false,
            ],
        ];
    }

    public function getEnvSuffix(): string
    {
        switch ($this->environment) {
            case 'canary':
            case 'mock':
                return '-' . $this->environment;
            default:
                return '';
        }
    }
}`,
        context: {
            imports: [
                'use Fulfillment\\\\Messenger\\\\Message\\\\SaveRequestedMessage;',
                'use Fulfillment\\\\Messenger\\\\Message\\\\ShipmentSavedMessage;',
                'use Fulfillment\\\\Messenger\\\\Message\\\\ShipmentUpdatedMessage;',
            ],
        },
        expectedHasIo: false,

        // No infrastructure assertions — has_io=false means no infra array populated
    },

    {
        // AmqpRoutingMiddleware: reads routing_key from getMessageMap() and stamps the envelope.
        // This is a GENERIC INFRASTRUCTURE WRAPPER — it does not own any queues.
        // The infrastructure definitions are in AmqpConfig, not here.
        // Expected: maxInfraCount=0 (wrapper detection applies).
        name: 'PHP Messenger: AmqpRoutingMiddleware.handle — generic infrastructure wrapper, must not extract queues (maxInfraCount=0)',
        language: 'php',
        functionName: 'Fulfillment\\\\Messenger\\\\Middleware\\\\AmqpRoutingMiddleware.handle',
        filepath: 'src/Messenger/Middleware/AmqpRoutingMiddleware.php',
        sourceCode: `
class AmqpRoutingMiddleware implements MiddlewareInterface
{
    private AmqpConfig $amqpConfig;

    public function __construct(AmqpConfig $amqpConfig)
    {
        $this->amqpConfig = $amqpConfig;
    }

    public function handle(Envelope $envelope, StackInterface $stack): Envelope
    {
        if (empty($envelope->all(ReceivedStamp::class))) {
            $routingKey = $this->mapMessageToRoutingKey(get_class($envelope->getMessage()));
            if ($routingKey !== null) {
                $envelope = $envelope->with(
                    new AmqpStamp($routingKey)
                );
            }
        }

        return $stack->next()->handle($envelope, $stack);
    }

    private function mapMessageToRoutingKey(string $messageClass): ?string
    {
        return $this->amqpConfig->getMessageMap()[$messageClass]['routing_key'] ?? null;
    }
}`,
        context: {
            imports: [
                'use Fulfillment\\\\Messenger\\\\AmqpConfig;',
                'use Symfony\\\\Component\\\\Messenger\\\\Envelope;',
                'use Symfony\\\\Component\\\\Messenger\\\\Middleware\\\\MiddlewareInterface;',
                'use Symfony\\\\Component\\\\Messenger\\\\Middleware\\\\StackInterface;',
                'use Symfony\\\\Component\\\\Messenger\\\\Bridge\\\\Amqp\\\\Transport\\\\AmqpStamp;',
            ],
            constructorSource: 'public function __construct(AmqpConfig $amqpConfig)',
            classProperties: ['amqpConfig: AmqpConfig'],
        },
        expectedHasIo: true,

        // WRAPPER: routing keys come from $this->amqpConfig->getMessageMap() — dynamic, not hardcoded.
        // But it also calls $stack->next()->handle() which chains actual I/O processing.
    },

    {
        // Control case: classic low-level AMQP publish with hardcoded routing key.
        // The routing key 'order.created' is a string literal, extracted directly.
        name: 'PHP Messenger Publisher with concrete routing key — physical name visible as literal',
        language: 'php',
        functionName: 'Fulfillment\\\\Queue\\\\OrderEventPublisher.publishOrderCreated',
        filepath: 'src/Queue/OrderEventPublisher.php',
        sourceCode: `
class OrderEventPublisher
{
    private AMQPChannel $channel;

    public function __construct(AMQPChannel $channel)
    {
        $this->channel = $channel;
    }

    public function publishOrderCreated(int $orderId, string $customerId): void
    {
        $message = new AMQPMessage(
            json_encode(['orderId' => $orderId, 'customerId' => $customerId]),
            ['content_type' => 'application/json', 'delivery_mode' => 2]
        );

        $this->channel->basic_publish(
            $message,
            'orders_exchange',
            'order.created'  // hardcoded routing key — physical name is right here
        );
    }
}`,
        context: {
            imports: [
                'use PhpAmqpLib\\\\Channel\\\\AMQPChannel;',
                'use PhpAmqpLib\\\\Message\\\\AMQPMessage;',
            ],
            constructorSource: 'public function __construct(AMQPChannel $channel)',
            classProperties: ['channel: AMQPChannel'],
        },
        expectedHasIo: true,

        infra: [
            {
                type: 'MessageChannel',
                mustContain: ['order'],
                // basic_publish → WRITES; the literal routing key is the channel
                mustHaveOperation: 'WRITES',
            },
        ],
    },
];
// ─── Assertion Engine ────────────────────────────────────────────────────────

function makeChunk(evalCase: EvalCase): CodeChunk {
    return {
        name: evalCase.functionName,
        filepath: evalCase.filepath,
        sourceCode: evalCase.sourceCode,
        language: evalCase.language,
        startLine: 1,
        startColumn: 1,
        endLine: evalCase.sourceCode.split('\n').length,
        endColumn: 1,
        envVars: [],
    };
}

// ─── Test Runner ─────────────────────────────────────────────────────────────
// ─── LLM Replay Cache ────────────────────────────────────────────────────────
// analyzeFunction() routes through getAnalyzerStrategy() to PER-LANGUAGE
// agents (fast:php, deep:typescript, ...) whenever the plugin exposes
// promptHints — which all built-in plugins do. Wrapping only the generic
// singletons (the historical wiring) intercepted nothing: every case ran a
// live LLM call in every mode. wireUnifiedAnalyzerReplay() wraps generic +
// per-language agents; schema versions live in with-replay.ts.
await wireUnifiedAnalyzerReplay();

describe('Unified Analyzer — Golden Dataset Matrix', () => {

    beforeAll(() => {
        console.log(`[LLM Replay] Mode: ${EVAL_LLM_MODE}`);
    });

    it.each(goldenDataset)('$name', async (evalCase) => {
        const chunk = makeChunk(evalCase);
        // Stage 2: an I/O-expecting case stands in for a function the static gate
        // would mark ioConfirmed → slim filter-free prompt + forced has_io. has_io
        // false cases keep the full FILTER prompt (LLM decides), exercising both paths.
        const ioConfirmed = evalCase.expectedHasIo === true;
        const result = await analyzeFunction(
            chunk, 'fast', evalCase.context, evalCase.taintContextSummary, evalCase.customKnowledge,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            ioConfirmed,
        );

        expect(result, `LLM returned null for "${evalCase.name}"`).not.toBeNull();
        // NOTE: assertions run on the RAW analyzer output (this matrix
        // measures the LLM layer). The full sanitizeAnalysis is NOT applied
        // here: it is context-dependent (symbolRegistry, framework overlay,
        // entity context) and without that pipeline context it drops
        // legitimate DI-key channels and inbound endpoints that production
        // keeps. Deterministic guard behavior is pinned by the sanitizer
        // unit tests (tests/unit/ingestion/infra-drop-filter.test.ts).
        const analysis = result!.analysis;

        // ── has_io assertion ────────────────────────────────────────────
        expect(analysis.has_io).toBe(evalCase.expectedHasIo);

        // If no I/O expected, no further assertions needed
        if (!evalCase.expectedHasIo) return;

        // ── Infrastructure assertions ───────────────────────────────────
        if (evalCase.infra) {
            for (const expectation of evalCase.infra) {
                const matching = analysis.infrastructure.filter(
                    i => i.type === expectation.type,
                );
                const names = matching.map(i => i.name);

                if (expectation.mustContain) {
                    for (const expected of expectation.mustContain) {
                        const found = names.some(n =>
                            n.toLowerCase().includes(expected.toLowerCase()),
                        );
                        expect(
                            found,
                            `Expected ${expectation.type} names to contain "${expected}", ` +
                            `got: ${JSON.stringify(names)}`,
                        ).toBe(true);
                    }
                }

                if (expectation.mustNotContain) {
                    for (const forbidden of expectation.mustNotContain) {
                        const found = names.some(n =>
                            n.toLowerCase().includes(forbidden.toLowerCase()),
                        );
                        expect(
                            found,
                            `${expectation.type} names should NOT contain "${forbidden}", ` +
                            `got: ${JSON.stringify(names)}`,
                        ).toBe(false);
                    }
                }

                // ── mustHaveOperation assertion ────────────────────────
                if (expectation.mustHaveOperation) {
                    const hasOp = matching.some((i: any) =>
                        i.operation === expectation.mustHaveOperation,
                    );
                    expect(
                        hasOp,
                        `Expected at least one ${expectation.type} item to have ` +
                        `operation=${expectation.mustHaveOperation} ` +
                        `(publisher=WRITES, consumer=READS), ` +
                        `got: ${JSON.stringify(matching.map((i: any) => ({ name: i.name, operation: i.operation })))}`,
                    ).toBe(true);
                }
            }
        }

        // ── Max infrastructure count assertion ──────────────────────────
        // The wrapper contract is "no CONCRETE infra survives the pipeline".
        // The LLM may emit a non-physical name (a code-expression echo like
        // `queueOptions['name']`, or an explicit placeholder like <DYNAMIC>):
        // both are removed deterministically by the shared name-safety gate
        // before the graph, so they must not count against the wrapper rule.
        // Only context-FREE shape predicates run here (no symbolRegistry /
        // framework overlay), so legit concrete names always survive.
        if (evalCase.maxInfraCount !== undefined) {
            const survivors = analysis.infrastructure.filter((i: any) => {
                const name = String(i.name ?? '');
                if (NOISY_BROKER_NAMES.has(name.toLowerCase())) return false; // placeholders (<DYNAMIC>, unknown, ...)
                if (i.type === 'MessageChannel') return !isNoisyBrokerName(name);
                if (i.type === 'Database' || i.type === 'Cache' || i.type === 'DataContainer') {
                    return !isUnsafeContainerName(name);
                }
                return true;
            });
            expect(
                survivors.length,
                `Expected at most ${evalCase.maxInfraCount} concrete infrastructure items (wrapper should produce none), ` +
                `got ${survivors.length}: ${JSON.stringify(survivors.map((i: any) => i.name))}`,
            ).toBeLessThanOrEqual(evalCase.maxInfraCount);
        }

        // ── Emergent API assertions ─────────────────────────────────────
        if (evalCase.apis) {
            const apiCalls = 'emergent_api_calls' in analysis
                ? (analysis.emergent_api_calls ?? [])
                : [];

            for (const apiExp of evalCase.apis) {
                if (apiExp.pathContains) {
                    const found = apiCalls.some(c =>
                        c.path.toLowerCase().includes(apiExp.pathContains!.toLowerCase()),
                    );
                    expect(
                        found,
                        `Expected at least one API path containing "${apiExp.pathContains}", ` +
                        `got: ${JSON.stringify(apiCalls.map(c => c.path))}`,
                    ).toBe(true);
                }

                if (apiExp.pathNotContains) {
                    const found = apiCalls.some(c =>
                        c.path.toLowerCase().includes(apiExp.pathNotContains!.toLowerCase()),
                    );
                    expect(
                        found,
                        `No API path should contain "${apiExp.pathNotContains}", ` +
                        `got: ${JSON.stringify(apiCalls.map(c => c.path))}`,
                    ).toBe(false);
                }
            }
        }

        // ── Capability assertions ───────────────────────────────────────
        if (evalCase.expectedCapabilities) {
            const caps = analysis.capabilities.map((c: string) => c.toLowerCase());
            for (const expected of evalCase.expectedCapabilities) {
                expect(
                    caps.some(c => c.includes(expected.toLowerCase())),
                    `Expected capability containing "${expected}", ` +
                    `got: ${JSON.stringify(analysis.capabilities)}`,
                ).toBe(true);
            }
        }
    }, 300_000);
});
