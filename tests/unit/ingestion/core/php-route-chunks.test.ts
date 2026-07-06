import { describe, it, expect } from 'vitest';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import type { CodeChunk } from '../../../../src/graph/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const plugin = new PHPPlugin();
const parser = plugin.createParser();

function extractChunks(src: string, filepath = 'routes.php'): CodeChunk[] {
    const tree = parser.parse(src);
    return plugin.extractFunctions(tree, src, filepath);
}

function routeChunks(chunks: CodeChunk[]): CodeChunk[] {
    return chunks.filter(c => c.name.endsWith('::__route_handler'));
}

function inferChunk(src: string, chunkName: string) {
    const tree = parser.parse(src);
    const rootNode = tree.rootNode;
    return plugin.extractStaticInfra(rootNode, {
        name: chunkName,
        filepath: 'routes.php',
        sourceCode: src,
        language: 'php',
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Slim 4 / anonymised real-world fixture (acme.example)
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin integration / acme.example (Slim 4)', () => {
    const src = `<?php
use Slim\\Factory\\AppFactory;
use Slim\\Routing\\RouteCollectorProxy;
require_once __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

$app->get('/ping', function ($request, $response) {
    $response->getBody()->write('Pong');
    return $response;
});

$app->group('/api/v1/records', function (RouteCollectorProxy $group) {
    $group->post('/calculate', \\Acme\\Handler\\CalculateHandler::class);
    $group->post('/submit', \\Acme\\Handler\\SubmitHandler::class);
    $group->post('/archive', \\Acme\\Handler\\ArchiveHandler::class);
    $group->patch('/update/{id}', \\Acme\\Handler\\UpdateHandler::class);
});

$app->run();`;

    it('emits 5 route chunks', () => {
        const chunks = extractChunks(src, 'src/index.php');
        expect(routeChunks(chunks)).toHaveLength(5);
    });

    it('emits GET /ping::__route_handler', () => {
        const chunks = extractChunks(src, 'src/index.php');
        expect(routeChunks(chunks).map(c => c.name)).toContain('GET /ping::__route_handler');
    });

    it('group prefix: POST /api/v1/records/calculate::__route_handler', () => {
        const chunks = extractChunks(src, 'src/index.php');
        expect(routeChunks(chunks).map(c => c.name)).toContain('POST /api/v1/records/calculate::__route_handler');
    });

    it('group prefix: PATCH /api/v1/records/update/{id}::__route_handler', () => {
        const chunks = extractChunks(src, 'src/index.php');
        expect(routeChunks(chunks).map(c => c.name)).toContain('PATCH /api/v1/records/update/{id}::__route_handler');
    });

    it('extractStaticInfra: GET /ping → INBOUND direction', () => {
        const result = inferChunk(
            '/* slim route: GET /ping */',
            'GET /ping::__route_handler',
        );
        expect(result).not.toBeNull();
        expect(result!.emergent_api_calls[0]).toMatchObject({
            direction: 'INBOUND',
            method: 'GET',
            path: '/ping',
        });
    });

    it('extractStaticInfra: framework label extracted from sourceCode comment', () => {
        const result = inferChunk(
            '/* slim route: POST /api/v1/records/calculate */',
            'POST /api/v1/records/calculate::__route_handler',
        );
        expect(result!.emergent_api_calls[0].framework).toBe('slim');
    });

    it('extractStaticInfra: all arrays empty except emergent_api_calls', () => {
        const result = inferChunk(
            '/* slim route: GET /ping */',
            'GET /ping::__route_handler',
        );
        // StaticInfraResult shape: { has_io, intent, infrastructure, capabilities, emergent_api_calls }
        expect(result!.infrastructure).toHaveLength(0);
        expect(result!.emergent_api_calls).toHaveLength(1);
        expect(result!.has_io).toBe(true);
    });

    it('ORM class metadata chunk still works (no regression)', () => {
        const ormSrc = `<?php
/** @ORM\\Table(name="records") @ORM\\Entity */
class Record {
    protected $id;
}`;
        const ormTree = parser.parse(ormSrc);
        const ormChunks = plugin.extractFunctions(ormTree, ormSrc, 'src/Entity/Record.php');
        const metadataChunk = ormChunks.find(c => c.name.endsWith('::__class_metadata'));
        expect(metadataChunk).toBeDefined();

        const infra = plugin.extractStaticInfra(ormTree.rootNode, metadataChunk!);
        expect(infra).not.toBeNull();
        // ORM metadata chunks return the 'infrastructure' format with MAPS_TO operation
        const anyInfra = infra as unknown as { infrastructure?: Array<{ name: string }> };
        const tableName = anyInfra.infrastructure?.[0]?.name;
        expect(tableName).toBe('records');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Laravel Route facade integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin integration — Laravel', () => {
    it('Route::get / Route::post → route chunks', () => {
        const src = `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);`;
        const chunks = routeChunks(extractChunks(src, 'routes/api.php'));
        expect(chunks.map(c => c.name)).toContain('GET /users::__route_handler');
        expect(chunks.map(c => c.name)).toContain('POST /users::__route_handler');
        expect(chunks.map(c => c.name)).toContain('DELETE /users/{id}::__route_handler');
    });

    it('Route::resource → 5 route chunks', () => {
        const src = `<?php Route::resource('/orders', OrderController::class);`;
        const chunks = routeChunks(extractChunks(src, 'routes/api.php'));
        expect(chunks).toHaveLength(5);
    });

    it('extractStaticInfra for Laravel route chunk → framework: laravel', () => {
        const result = inferChunk(
            '/* laravel route: GET /users */',
            'GET /users::__route_handler',
        );
        expect(result!.emergent_api_calls[0].framework).toBe('laravel');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Symfony attribute integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin integration — Symfony #[Route]', () => {
    it('class-level prefix + method-level routes', () => {
        const src = `<?php
#[Route('/api')]
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index() {}

    #[Route('/users', methods: ['POST'])]
    public function create() {}

    #[Route('/users/{id}', methods: ['DELETE'])]
    public function delete() {}
}`;
        const chunks = routeChunks(extractChunks(src, 'src/Controller/UserController.php'));
        expect(chunks.map(c => c.name)).toContain('GET /api/users::__route_handler');
        expect(chunks.map(c => c.name)).toContain('POST /api/users::__route_handler');
        expect(chunks.map(c => c.name)).toContain('DELETE /api/users/{id}::__route_handler');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Platform
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin integration — API Platform', () => {
    it('#[ApiResource] → 6 route chunks', () => {
        const src = `<?php
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Order {
    public int $id;
}`;
        const chunks = routeChunks(extractChunks(src, 'src/Entity/Order.php'));
        expect(chunks).toHaveLength(6);
        expect(chunks.map(c => c.name)).toContain('GET /orders::__route_handler');
        expect(chunks.map(c => c.name)).toContain('POST /orders::__route_handler');
        expect(chunks.map(c => c.name)).toContain('DELETE /orders/{id}::__route_handler');
    });

    it('API Platform framework label in extractStaticInfra', () => {
        const result = inferChunk(
            '/* api-platform route: GET /orders */',
            'GET /orders::__route_handler',
        );
        expect(result!.emergent_api_calls[0].framework).toBe('api-platform');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractStaticInfra — null for non-route, non-metadata chunks
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHPPlugin extractStaticInfra — null passthrough', () => {
    it('returns null for a regular method chunk', () => {
        const src = `<?php class Foo { public function bar() { return 1; } }`;
        const tree = parser.parse(src);
        const result = plugin.extractStaticInfra(tree.rootNode, {
            name: 'Foo.bar',
            filepath: 'src/Foo.php',
            sourceCode: 'public function bar() { return 1; }',
            language: 'php',
            startLine: 1,
            startColumn: 1,
            endLine: 3,
            endColumn: 1,
        });
        expect(result).toBeNull();
    });

    it('returns null for ::main chunk', () => {
        const src = `<?php echo "hello";`;
        const tree = parser.parse(src);
        const result = plugin.extractStaticInfra(tree.rootNode, {
            name: 'index::main',
            filepath: 'index.php',
            sourceCode: 'echo "hello";',
            language: 'php',
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
        });
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Zero pollution — ORM entity files must not produce route chunks
// ═══════════════════════════════════════════════════════════════════════════════

describe('Zero pollution — ORM entities produce no route chunks', () => {
    it('Doctrine entity → 0 route chunks', () => {
        const src = `<?php
/** @ORM\\Table(name="orders") @ORM\\Entity */
class Order extends \\Doctrine\\ORM\\Mapping\\MappedSuperclass {
    protected $id;
    public function getId() { return $this->id; }
}`;
        const chunks = routeChunks(extractChunks(src, 'src/Entity/Order.php'));
        expect(chunks).toHaveLength(0);
    });

    it('Eloquent model → 0 route chunks', () => {
        const src = `<?php
class User extends Model {
    protected $table = 'users';
    protected $fillable = ['name', 'email'];
    public function orders() { return $this->hasMany(Order::class); }
}`;
        const chunks = routeChunks(extractChunks(src, 'app/Models/User.php'));
        expect(chunks).toHaveLength(0);
    });

    it('Service class → 0 route chunks', () => {
        // $this->gateway->post('/charge', ...) must NOT produce a route chunk.
        // The $this-> guard in handleMethodCall filters these out.
        const src = `<?php
class PaymentService {
    public function __construct(private GatewayClient $gateway) {}
    public function charge(int $amount): bool {
        return $this->gateway->post('/charge', ['amount' => $amount]);
    }
}`;
        const chunks = routeChunks(extractChunks(src, 'src/Service/PaymentService.php'));
        expect(chunks).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Zero pollution — HTTP request param readers must not produce route chunks
//
// Regression: $request->get('ORDER_REF') was hallucinated as GET /ORDER_REF
// because the LLM saw ->get('PARAM') and treated the argument as a URL path.
// These classes only READ query string parameters — they do NOT define routes.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Zero pollution — HTTP request param readers produce no route chunks', () => {
    const paramReaderSrc = `<?php
class SomeController
{
    private function getParamsWeb()
    {
        $request = $this->getGlobal()->getRequest()->query;
        $this->params = $request->all();
        if ($request->has('ORDER_REF')) {
            $this->setOrderRef((int)$request->get('ORDER_REF'));
        }
        if ($request->has('SAVEDRAFT')) {
            $this->isSnapshotParam = $request->get('SAVEDRAFT');
        }
        if ($request->has('ADDONS')) {
            $this->addonsSet = AddonsSetLib::buildFromBitmask((int)$request->get('ADDONS'));
        }
        $this->paymentFrequency = $request->get('PAYMENT_FREQUENCY', 1);
    }
}`;

    it('getParamsWeb() → 0 route chunks (query string keys are not routes)', () => {
        expect(routeChunks(extractChunks(paramReaderSrc, 'src/Controller/SomeController.php'))).toHaveLength(0);
    });

    it('method chunks have no ::__route_handler suffix', () => {
        const chunks = extractChunks(paramReaderSrc, 'src/Controller/SomeController.php');
        expect(chunks.map(c => c.name)).not.toContain(expect.stringContaining('__route_handler'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Zero pollution — AMQP ConsumerManager must not produce route chunks
//
// Regression: $msg->get('channel') on AMQPMessage was hallucinated as GET /channel
// because the LLM saw ->get('channel') and treated 'channel' as a URL path segment.
// ConsumerManager handles AMQP delivery — it is a message consumer, not an HTTP handler.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Zero pollution — AMQP ConsumerManager produces no route chunks', () => {
    const consumerManagerSrc = `<?php
namespace RabbitMq\\Consumer;

use PhpAmqpLib\\Channel\\AMQPChannel;
use PhpAmqpLib\\Message\\AMQPMessage;
use Psr\\Log\\LoggerInterface;
use RabbitMq\\Message\\MessageConsumerInterface;

class ConsumerManager
{
    public function buildConsumer(
        ConsumerInterface $consumer,
        MessageConsumerInterface $messageConsumer,
        string $exchange,
        QueueOptions $options,
        LoggerInterface $logger
    ): void {
        $callback = $this->callbackClosure($messageConsumer, $exchange, $logger);
        $consumer->createQueue($messageConsumer->getQueueName(), $messageConsumer->getQueueRoutingKeys(), $options);
        $consumer->consume($messageConsumer->getQueueName(), false, $callback, $logger);
    }

    private function callbackClosure(MessageConsumerInterface $messageConsumer, string $exchange, LoggerInterface $logger): \\Closure
    {
        return function (AMQPMessage $msg) use ($messageConsumer, $exchange, $logger) {
            /** @var AMQPChannel $channel */
            $channel = $msg->get('channel');
            $routingKey = $msg->get('routing_key');

            try {
                $messageConsumer->consume($msg);
                $this->hackMessage($channel, $msg);
            } catch (\\Exception $e) {
                $logger->error($e->getMessage(), ['exception' => $e]);
                $channel->basic_publish($msg, '', $messageConsumer->getDeadLetterQueueName());
                $this->hackMessage($channel, $msg);
            }
        };
    }

    private function hackMessage(AMQPChannel $channel, AMQPMessage $msg): void
    {
        $channel->basic_ack($msg->get('delivery_tag'));
    }
}`;

    it('ConsumerManager → 0 route chunks ($msg->get() is AMQP metadata, not HTTP routes)', () => {
        expect(routeChunks(extractChunks(consumerManagerSrc, 'src/Consumer/ConsumerManager.php'))).toHaveLength(0);
    });

    it('ConsumerManager method chunks have no ::__route_handler suffix', () => {
        const chunks = extractChunks(consumerManagerSrc, 'src/Consumer/ConsumerManager.php');
        expect(chunks.map(c => c.name)).not.toContain(expect.stringContaining('__route_handler'));
    });
});
