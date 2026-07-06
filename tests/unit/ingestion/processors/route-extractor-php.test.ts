import { describe, it, expect } from 'vitest';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import {
    normalizePhpPath,
    concatPaths,
    extractPhpRoutes,
    extractCallExpressionRoutes,
    extractAttributeRoutes,
    extractDocBlockRoutes,
    extractConventionRoutes,
    extractLegacyFilesystemRoute,
    type PhpRoute,
} from '../../../../src/ingestion/processors/route-extractor-php.js';

// ─── Parser bootstrap ─────────────────────────────────────────────────────────

const plugin = new PHPPlugin();
const _parser = plugin.createParser();

function parse(src: string) {
    return _parser.parse(src).rootNode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// normalizePhpPath()
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizePhpPath()', () => {
    it('returns / for empty string', () => expect(normalizePhpPath('')).toBe('/'));
    it('returns / for bare /', () => expect(normalizePhpPath('/')).toBe('/'));
    it('strips trailing slash', () => expect(normalizePhpPath('/users/')).toBe('/users'));
    it('adds leading slash if missing', () => expect(normalizePhpPath('users')).toBe('/users'));
    it('normalizes double slashes', () => expect(normalizePhpPath('/api//v1')).toBe('/api/v1'));
    it('{id} preserved (lossless)', () => expect(normalizePhpPath('/users/{id}')).toBe('/users/{id}'));
    it('{slug} preserved (lossless)', () => expect(normalizePhpPath('/posts/{slug}')).toBe('/posts/{slug}'));
    it('{id:\\d+} Slim inline regex → {id} (constraint stripped, name kept)', () => expect(normalizePhpPath('/users/{id:\\d+}')).toBe('/users/{id}'));
    it(':id colon param → {id} (preserve name)', () => expect(normalizePhpPath('/users/:id')).toBe('/users/{id}'));
    it('wildcard * → {splat}', () => expect(normalizePhpPath('/files/*')).toBe('/files/{splat}'));
    it('[optional] CI4 segment → stripped', () => expect(normalizePhpPath('/users[/create]')).toBe('/users'));
    it('multiple params keep distinct names', () => expect(normalizePhpPath('/orgs/{org}/repos/{repo}')).toBe('/orgs/{org}/repos/{repo}'));
    it('strips surrounding quotes', () => expect(normalizePhpPath("'/users'")).toBe('/users'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// concatPaths()
// ═══════════════════════════════════════════════════════════════════════════════

describe('concatPaths()', () => {
    it('prefix + suffix', () => expect(concatPaths('/api', '/users')).toBe('/api/users'));
    it('root prefix + nested', () => expect(concatPaths('/', '/ping')).toBe('/ping'));
    it('prefix + /', () => expect(concatPaths('/api', '/')).toBe('/api'));
    it('with params (var name preserved)', () => expect(concatPaths('/api/v1/records', '/update/{id}')).toBe('/api/v1/records/update/{id}'));
    it('normalizes double slash on join', () => expect(concatPaths('/api/', '/users')).toBe('/api/users'));
    it('empty prefix', () => expect(concatPaths('', '/users')).toBe('/users'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Slim 4 / anonymised real-world fixture (acme.example)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Slim 4 / acme.example fixture', () => {
    // This is the actual index.php from the test-env
    const src = `<?php
use Slim\\Factory\\AppFactory;
use Slim\\Routing\\RouteCollectorProxy;

require_once __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

/**
 * Health check endpoint
 */
$app->get('/ping', function ($request, $response) {
    $response->getBody()->write('Pong');
    return $response;
});

/**
 * Acme Resource Management API
 */
$app->group('/api/v1/records', function (RouteCollectorProxy $group) {
    $group->post('/calculate', \\Acme\\Handler\\CalculateHandler::class);
    $group->post('/submit', \\Acme\\Handler\\SubmitHandler::class);
    $group->post('/archive', \\Acme\\Handler\\ArchiveHandler::class);
    $group->patch('/update/{id}', \\Acme\\Handler\\UpdateHandler::class);
});

$app->run();`;

    let routes: PhpRoute[];
    it('setup: parses without error', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toBeDefined();
    });

    it('extracts 5 routes total', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toHaveLength(5);
    });

    it('GET /ping health check', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/ping', framework: 'slim' }));
    });

    it('POST /api/v1/records/calculate (group prefix applied)', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v1/records/calculate' }));
    });

    it('POST /api/v1/records/submit', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v1/records/submit' }));
    });

    it('POST /api/v1/records/archive', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v1/records/archive' }));
    });

    it('PATCH /api/v1/records/update/{id} (dynamic segment, var name preserved)', () => {
        routes = extractPhpRoutes(parse(src), src, 'src/index.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/api/v1/records/update/{id}' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Slim 4 — Additional patterns
// ═══════════════════════════════════════════════════════════════════════════════

describe('Slim — additional patterns', () => {
    it('$app->map() multi-method route', () => {
        const src = `<?php
$app->map(['GET', 'POST'], '/search', $handler);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/search' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/search' }));
        expect(routes).toHaveLength(2);
    });

    it('$app->any() expands to all 5 methods', () => {
        const src = `<?php $app->any('/catch-all', $handler);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes.php');
        expect(routes).toHaveLength(5);
        for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(routes).toContainEqual(expect.objectContaining({ method: m, path: '/catch-all' }));
        }
    });

    it('nested group with param', () => {
        const src = `<?php
$app->group('/api', function ($group) {
    $group->group('/users/{id}', function ($g) {
        $g->get('/profile', $handler);
        $g->post('/orders', $handler);
    });
});`;
        const routes = extractPhpRoutes(parse(src), src, 'routes.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/users/{id}/profile' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/users/{id}/orders' }));
    });

    it('zero routes for non-routing PHP file', () => {
        const src = `<?php
class UserService {
    public function getUser(int $id): User {
        return $this->repo->find($id);
    }
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Service/UserService.php');
        expect(routes).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Laravel
// ═══════════════════════════════════════════════════════════════════════════════

describe('Laravel — Route facade', () => {
    it('Route::get() and Route::post()', () => {
        const src = `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users', framework: 'laravel' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users', framework: 'laravel' }));
    });

    it('Route::put(), patch(), delete()', () => {
        const src = `<?php
Route::put('/users/{id}', [UserController::class, 'update']);
Route::patch('/users/{id}', [UserController::class, 'patch']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/users/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/users/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/users/{id}' }));
    });

    it('Route::resource() expands to 5 endpoints', () => {
        const src = `<?php Route::resource('/orders', OrderController::class);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toHaveLength(5);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/orders/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/orders/{id}' }));
    });

    it('Route::apiResource() expands to 5 endpoints', () => {
        const src = `<?php Route::apiResource('/products', ProductController::class);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toHaveLength(5);
    });

    it('Route::any() expands to all methods', () => {
        const src = `<?php Route::any('/admin', AdminController::class);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toHaveLength(5);
    });

    it('Route::match() multi-method', () => {
        const src = `<?php Route::match(['get', 'post'], '/search', SearchController::class);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes/api.php');
        expect(routes).toHaveLength(2);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/search' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/search' }));
    });

    it('unknown static call class → not extracted', () => {
        const src = `<?php DB::table('users')->get();`;
        const routes = extractCallExpressionRoutes(parse(src), src);
        expect(routes).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Symfony — PHP 8 Attributes
// ═══════════════════════════════════════════════════════════════════════════════

describe('Symfony — PHP 8 #[Route] attributes', () => {
    it('method-level Route with methods: GET', () => {
        const src = `<?php
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users', framework: 'symfony' }));
    });

    it('method-level Route with multiple methods', () => {
        const src = `<?php
class UserController {
    #[Route('/users', methods: ['GET', 'HEAD'])]
    public function index() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users' }));
    });

    it('class-level prefix + method-level Route', () => {
        const src = `<?php
#[Route('/api/v1')]
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index() {}

    #[Route('/users', methods: ['POST'])]
    public function create() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/v1/users' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v1/users' }));
    });

    it('Route without methods: → defaults to GET', () => {
        const src = `<?php
class UserController {
    #[Route('/health')]
    public function health() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
    });

    it('{id} param preserved verbatim', () => {
        const src = `<?php
class UserController {
    #[Route('/users/{id}', methods: ['GET'])]
    public function show() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/users/{id}' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Symfony — DocBlock @Route annotations
// ═══════════════════════════════════════════════════════════════════════════════

describe('Symfony — DocBlock @Route annotations', () => {
    it('@Route with methods={"GET"}', () => {
        const src = `<?php
/**
 * @Route("/products", methods={"GET"})
 */
public function listProducts() {}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/products', framework: 'symfony' }));
    });

    it('@Route with multiple methods', () => {
        const src = `<?php
/**
 * @Route("/products", methods={"GET","POST"})
 */
public function products() {}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/products' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/products' }));
        expect(routes).toHaveLength(2);
    });

    it('@Route without methods → GET', () => {
        const src = `<?php
/**
 * @Route("/api/health")
 */
public function health() {}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/health' }));
    });

    it('@Route with {id} param preserved verbatim', () => {
        const src = `<?php /** @Route("/orders/{id}", methods={"PUT"}) */ public function update() {}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/orders/{id}' }));
    });

    it('multiple @Route in same file', () => {
        const src = `<?php
/** @Route("/users", methods={"GET"}) */
public function list() {}

/** @Route("/users", methods={"POST"}) */
public function create() {}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toHaveLength(2);
    });

    // ── Enterprise patterns (Bug Fix: name= before path=) ────────────────────

    it('[BUG FIX] name= first, path= second → extracts correct path', () => {
        // Before fix: would incorrectly extract "user_list" as the path.
        const src = `/** @Route(name="user_list", path="/api/users", methods={"GET"}) */`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toHaveLength(1);
        expect(routes[0].path).toBe('/api/users');
        expect(routes[0].method).toBe('GET');
    });

    it('[BUG FIX] name= first, path= second, POST method', () => {
        const src = `/** @Route(name="order_create", path="/api/orders", methods={"POST"}) */`;
        const routes = extractDocBlockRoutes(src);
        expect(routes[0].path).toBe('/api/orders');
        expect(routes[0].method).toBe('POST');
    });

    it('path= only (no positional) → extracts path', () => {
        const src = `/** @Route(path="/api/health", methods={"GET"}) */`;
        const routes = extractDocBlockRoutes(src);
        expect(routes[0].path).toBe('/api/health');
    });

    it('positional path + later name= → extracts positional path correctly', () => {
        const src = `/** @Route("/api/items", name="item_list", methods={"GET"}) */`;
        const routes = extractDocBlockRoutes(src);
        expect(routes[0].path).toBe('/api/items');
    });

    it('name= first with {id} in path preserves the var name', () => {
        const src = `/** @Route(name="user_show", path="/api/users/{id}", methods={"GET"}) */`;
        const routes = extractDocBlockRoutes(src);
        expect(routes[0].path).toBe('/api/users/{id}');
    });

    it('multiple enterprise routes in same controller', () => {
        const src = `<?php
class OrderController {
    /**
     * @Route(name="order_list", path="/orders", methods={"GET"})
     */
    public function list() {}

    /**
     * @Route(name="order_create", path="/orders", methods={"POST"})
     */
    public function create() {}

    /**
     * @Route(name="order_show", path="/orders/{id}", methods={"GET"})
     */
    public function show() {}
}`;
        const routes = extractDocBlockRoutes(src);
        expect(routes).toHaveLength(3);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders/{id}' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Platform
// ═══════════════════════════════════════════════════════════════════════════════

describe('API Platform — #[ApiResource]', () => {
    it('generates all 6 REST endpoints', () => {
        const src = `<?php
namespace App\\Entity;
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Order {
    public int $id;
    public string $status;
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Entity/Order.php');
        expect(routes.filter(r => r.framework === 'api-platform')).toHaveLength(6);
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/orders/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/orders/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/orders/{id}' }));
        expect(routes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/orders/{id}' }));
    });

    it('Entity suffix stripped: OrderItem → /order-items', () => {
        const src = `<?php #[ApiResource] class OrderItemEntity {}`;
        const routes = extractAttributeRoutes(parse(src), src);
        expect(routes[0].path).toBe('/order-items');
    });

    it('compound name: BlogPost → /blog-posts', () => {
        const src = `<?php #[ApiResource] class BlogPost {}`;
        const routes = extractAttributeRoutes(parse(src), src);
        expect(routes.some(r => r.path === '/blog-posts')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WordPress REST API
// ═══════════════════════════════════════════════════════════════════════════════

describe('WordPress REST — register_rest_route()', () => {
    it('namespace + path + methods array', () => {
        const src = `<?php
register_rest_route('myplugin/v1', '/data', [
    'methods' => ['GET', 'POST'],
    'callback' => 'my_callback',
]);`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({
            method: 'GET', path: '/wp-json/myplugin/v1/data', framework: 'wordpress-rest',
        }));
        expect(routes).toContainEqual(expect.objectContaining({
            method: 'POST', path: '/wp-json/myplugin/v1/data', framework: 'wordpress-rest',
        }));
    });

    it('namespace + path + single method string', () => {
        const src = `<?php
register_rest_route('acme/v2', '/health', [
    'methods' => 'GET',
    'callback' => 'health_check',
]);`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/wp-json/acme/v2/health' }));
    });

    it('no methods key → defaults to GET + POST', () => {
        const src = `<?php register_rest_route('ns/v1', '/endpoint', ['callback' => 'fn']);`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toHaveLength(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Yii 2 Convention
// ═══════════════════════════════════════════════════════════════════════════════

describe('Yii 2 — action method convention', () => {
    const src = `<?php
namespace app\\controllers;
use yii\\web\\Controller;

class UserController extends Controller {
    public function actionIndex() { return $this->render('index'); }
    public function actionCreate() { return $this->render('create'); }
    public function actionView($id) { return $this->render('view'); }
    public function actionUpdate($id) { $this->loadModel($id)->update(); }
    public function actionDelete($id) { $this->loadModel($id)->delete(); }
    // Private helper — NOT a route
    private function loadModel($id) {}
}`;

    it('extracts routes only from public actionXxx() methods', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/UserController.php');
        expect(routes.length).toBeGreaterThan(0);
    });

    it('actionIndex → GET /user/index', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/user/index' }));
    });

    it('actionCreate → POST /user/create', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/user/create' }));
    });

    it('actionView → GET /user/view', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/UserController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/user/view' }));
    });

    it('non-controller file → no convention routes', () => {
        const routes = extractConventionRoutes(parse(src), 'src/Service/UserService.php');
        expect(routes).toHaveLength(0);
    });
});

// ─── Yii 2 — CamelCase action names (Bug Fix) ────────────────────────────────

describe('Yii 2 — CamelCase action kebab-case conversion', () => {
    const src = `<?php
namespace app\\controllers;
use yii\\web\\Controller;

class ReportController extends Controller {
    public function actionCreateUser() {}
    public function actionViewOrderDetails() {}
    public function actionListPendingItems() {}
    public function actionDeleteById() {}
    public function actionIndex() {}
}`;

    it('[BUG FIX] actionCreateUser → POST /report/create-user (not createuser)', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/ReportController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/report/create-user' }));
        // Ensure the broken form is NOT present
        expect(routes).not.toContainEqual(expect.objectContaining({ path: '/report/createuser' }));
    });

    it('[BUG FIX] actionViewOrderDetails → GET /report/view-order-details', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/ReportController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/report/view-order-details' }));
    });

    it('[BUG FIX] actionListPendingItems → GET /report/list-pending-items', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/ReportController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/report/list-pending-items' }));
    });

    it('single-word actionDeleteById → /report/delete-by-id', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/ReportController.php');
        expect(routes).toContainEqual(expect.objectContaining({ path: '/report/delete-by-id' }));
    });

    it('actionIndex remains GET (not affected by kebab fix)', () => {
        const routes = extractConventionRoutes(parse(src), 'app/controllers/ReportController.php');
        expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/report/index' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Zero pollution — files that must produce ZERO routes
// ═══════════════════════════════════════════════════════════════════════════════

describe('Zero pollution — non-route PHP files', () => {
    const cases: Array<{ label: string; src: string; fp: string }> = [
        {
            label: 'Doctrine ORM entity',
            src: `<?php
/** @ORM\\Entity @ORM\\Table(name="orders") */
class Order {
    /** @ORM\\Id @ORM\\Column */ protected $id;
    public function getId() { return $this->id; }
}`,
            fp: 'src/Entity/Order.php',
        },
        {
            label: 'service class with DI',
            src: `<?php
class PaymentService {
    public function __construct(
        private readonly GatewayClient $client
    ) {}
    public function charge(int $amount): bool {
        return $this->client->charge($amount);
    }
}`,
            fp: 'src/Service/PaymentService.php',
        },
        {
            label: 'PHP config file',
            src: `<?php return ['debug' => true, 'db_host' => env('DB_HOST')];`,
            fp: 'config/app.php',
        },
        {
            label: 'middleware class',
            src: `<?php
class AuthMiddleware {
    public function process(Request $request, RequestHandler $handler): Response {
        if (!$request->hasHeader('Authorization')) {
            return new Response(401);
        }
        return $handler->handle($request);
    }
}`,
            fp: 'src/Middleware/AuthMiddleware.php',
        },
        {
            label: 'Eloquent model (non-ORM-route)',
            src: `<?php
class User extends Model {
    protected $table = 'users';
    protected $fillable = ['name', 'email'];
}`,
            fp: 'app/Models/User.php',
        },
    ];

    for (const { label, src, fp } of cases) {
        it(`${label} → 0 routes`, () => {
            const routes = extractPhpRoutes(parse(src), src, fp);
            expect(routes).toHaveLength(0);
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Deduplication
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deduplication', () => {
    it('same route in both attribute and docblock → deduplicated', () => {
        const src = `<?php
/**
 * @Route("/users", methods={"GET"})
 */
class UserController {
    #[Route('/users', methods: ['GET'])]
    public function index() {}
}`;
        const routes = extractPhpRoutes(parse(src), src, 'src/Controller/UserController.php');
        const getUsers = routes.filter(r => r.method === 'GET' && r.path === '/users');
        expect(getUsers).toHaveLength(1); // deduplicated
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Dynamic path → skip
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dynamic/variable paths → skip', () => {
    it('$path variable in route → not extracted', () => {
        const src = `<?php $app->get($path, $handler);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes.php');
        expect(routes).toHaveLength(0);
    });

    it('concatenated string path → not extracted', () => {
        const src = `<?php $app->get('/api/' . $version . '/users', $handler);`;
        const routes = extractPhpRoutes(parse(src), src, 'routes.php');
        expect(routes).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WordPress AJAX — add_action hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('WordPress AJAX — add_action hook', () => {
    it('wp_ajax_my_action → POST /wp-admin/admin-ajax.php?action=my_action', () => {
        const src = `<?php add_action('wp_ajax_my_action', 'my_callback');`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({
            method: 'POST',
            path: '/wp-admin/admin-ajax.php?action=my_action',
            framework: 'wordpress-ajax',
        }));
    });

    it('wp_ajax_nopriv_my_action → same path (deduped)', () => {
        // Both logged-in and anonymous variants resolve to the same endpoint
        const src = `<?php
add_action('wp_ajax_my_action', 'my_callback');
add_action('wp_ajax_nopriv_my_action', 'my_callback');`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        const hits = routes.filter(r => r.path === '/wp-admin/admin-ajax.php?action=my_action');
        expect(hits).toHaveLength(1); // deduplicated
    });

    it('add_action with a non-AJAX hook → 0 routes', () => {
        const src = `<?php add_action('init', 'my_init_callback');`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toHaveLength(0);
    });

    it('add_action with wp_ajax_nopriv_ prefix only → extracts route', () => {
        const src = `<?php add_action('wp_ajax_nopriv_get_data', 'get_data_callback');`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({
            method: 'POST',
            path: '/wp-admin/admin-ajax.php?action=get_data',
        }));
    });

    it('action slug with underscores is preserved', () => {
        const src = `<?php add_action('wp_ajax_save_user_profile', $cb);`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({
            path: '/wp-admin/admin-ajax.php?action=save_user_profile',
        }));
    });

    it('multiple add_action calls → multiple distinct routes', () => {
        const src = `<?php
add_action('wp_ajax_load_orders', 'load_orders');
add_action('wp_ajax_save_order', 'save_order');
add_action('wp_ajax_delete_order', 'delete_order');`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toHaveLength(3);
        expect(routes).toContainEqual(expect.objectContaining({ path: '/wp-admin/admin-ajax.php?action=load_orders' }));
        expect(routes).toContainEqual(expect.objectContaining({ path: '/wp-admin/admin-ajax.php?action=save_order' }));
        expect(routes).toContainEqual(expect.objectContaining({ path: '/wp-admin/admin-ajax.php?action=delete_order' }));
    });

    it('add_action with static method callback array → still extracts route', () => {
        // The callback is irrelevant to route extraction; we only care about the hook name
        const src = `<?php add_action('wp_ajax_process_payment', [PaymentHandler::class, 'process']);`;
        const routes = extractPhpRoutes(parse(src), src, 'plugin.php');
        expect(routes).toContainEqual(expect.objectContaining({
            path: '/wp-admin/admin-ajax.php?action=process_payment',
        }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy Filesystem Routing — extractLegacyFilesystemRoute()
// ═══════════════════════════════════════════════════════════════════════════════

describe('Legacy Filesystem Routing — extractLegacyFilesystemRoute()', () => {
    // ── POSITIVE: files that SHOULD emit a route ──────────────────────────────────

    it('catalogo.php with $_GET + echo → GET /catalogo.php', () => {
        const src = `<?php
$id = $_GET['id'];
echo '<h1>Catalogo</h1>';`;
        expect(extractLegacyFilesystemRoute(src, 'catalogo.php'))
            .toEqual([{ method: 'GET', path: '/catalogo.php', framework: 'legacy-php' }]);
    });

    it('nested page script keeps its full repo-relative path', () => {
        const src = `<?php
$id = $_GET['id'];
echo '<h1>Items</h1>';`;
        expect(extractLegacyFilesystemRoute(src, 'pages/inventory/items/add.php'))
            .toEqual([{ method: 'GET', path: '/pages/inventory/items/add.php', framework: 'legacy-php' }]);
    });

    it('two files with the same basename in different dirs → distinct paths', () => {
        const src = `<?php echo $_GET['id'];`;
        const a = extractLegacyFilesystemRoute(src, 'pages/inventory/items/add.php');
        const b = extractLegacyFilesystemRoute(src, 'pages/shipping/slots/add.php');
        expect(a[0].path).toBe('/pages/inventory/items/add.php');
        expect(b[0].path).toBe('/pages/shipping/slots/add.php');
    });

    it('contatti.php with $_POST → emits GET + POST /contatti.php', () => {
        const src = `<?php
$name = $_POST['name'];
mysql_query('INSERT INTO contacts VALUES ...');`;
        expect(extractLegacyFilesystemRoute(src, 'contatti.php')).toEqual([
            { method: 'GET', path: '/contatti.php', framework: 'legacy-php' },
            { method: 'POST', path: '/contatti.php', framework: 'legacy-php' },
        ]);
    });

    it('$_FILES upload target → emits GET + POST', () => {
        const src = `<?php
$file = $_FILES['document'];
move_uploaded_file($file['tmp_name'], '/uploads/' . $file['name']);
echo 'ok';`;
        const routes = extractLegacyFilesystemRoute(src, 'pages/orders/upload.php');
        expect(routes.map(r => r.method)).toEqual(['GET', 'POST']);
        expect(routes.every(r => r.path === '/pages/orders/upload.php')).toBe(true);
    });

    it('$_POST mentioned only in a string literal does NOT add POST', () => {
        const src = `<?php
$doc = 'Reads $_POST when submitted';
echo $_GET['id'];`;
        expect(extractLegacyFilesystemRoute(src, 'view.php').map(r => r.method)).toEqual(['GET']);
    });

    it('header( output signal alone → emits route', () => {
        const src = `<?php header('Content-Type: application/json'); echo json_encode($data);`;
        expect(extractLegacyFilesystemRoute(src, 'api.php')).not.toHaveLength(0);
    });

    it('php://input read → emits route', () => {
        const src = `<?php $body = file_get_contents('php://input'); $data = json_decode($body);`;
        expect(extractLegacyFilesystemRoute(src, 'webhook.php')).not.toHaveLength(0);
    });

    it('$_SERVER superglobal → emits route', () => {
        const src = `<?php $method = $_SERVER['REQUEST_METHOD'];`;
        expect(extractLegacyFilesystemRoute(src, 'router.php')).not.toHaveLength(0);
    });

    it('readfile( output → emits route', () => {
        const src = `<?php readfile('/var/exports/report.pdf');`;
        expect(extractLegacyFilesystemRoute(src, 'download.php')).not.toHaveLength(0);
    });

    // ── NEGATIVE: files that must NOT emit a route (no FP) ────────────────────────

    it('[ZERO FP] functions.php with no HTTP signals → no route', () => {
        const src = `<?php
function formatDate($date) { return date('Y-m-d', $date); }
function sendEmail($to, $msg) { mail($to, 'Subject', $msg); }`;
        expect(extractLegacyFilesystemRoute(src, 'functions.php')).toEqual([]);
    });

    it('[ZERO FP] config.php with define() only → no route', () => {
        const src = `<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'mydb');
define('DB_PASS', 'secret');`;
        expect(extractLegacyFilesystemRoute(src, 'config.php')).toEqual([]);
    });

    it('[ZERO FP] db.php with connection setup only → no route', () => {
        const src = `<?php
$conn = mysql_connect('localhost', 'user', 'pass');
mysql_select_db('mydb', $conn);`;
        // mysql_connect/mysql_select_db are NOT HTTP signals
        expect(extractLegacyFilesystemRoute(src, 'db.php')).toEqual([]);
    });

    it('[ZERO FP] file in src/ directory → no route even with echo', () => {
        const src = `<?php echo 'hello';`;
        expect(extractLegacyFilesystemRoute(src, '/var/www/src/Util/Helper.php')).toEqual([]);
    });

    it('[ZERO FP] repo-relative path starting with an excluded dir → no route', () => {
        // Relative paths have no leading slash: the exclusion must match at
        // string start too, not only after a '/'.
        const src = `<?php echo $_GET['x'];`;
        expect(extractLegacyFilesystemRoute(src, 'src/Service/Helper.php')).toEqual([]);
    });

    it('[ZERO FP] file in app/ directory → no route', () => {
        const src = `<?php echo $_GET['x'];`;
        expect(extractLegacyFilesystemRoute(src, '/var/www/app/Controllers/UserController.php')).toEqual([]);
    });

    it('[ZERO FP] file in vendor/ → no route regardless of content', () => {
        const src = `<?php echo 'vendor output';`;
        expect(extractLegacyFilesystemRoute(src, '/var/www/vendor/guzzlehttp/guzzle/src/Handler.php')).toEqual([]);
    });

    // ── CLI script guard — $argv presence means CLI entry point, NOT web endpoint ──
    //
    // Regression: legacy_vendor_migration.php (a migration runner) was classified as
    // GET /legacy_vendor_migration.php because it reads $_REQUEST, but $_REQUEST is
    // populated FROM $argv for CLI invocation. Web PHP never has $argv set.

    it('[ZERO FP] CLI migration script with $argv + $_REQUEST → null', () => {
        // Reproduces the legacy_vendor_migration.php false positive exactly
        const src = `<?php
require_once __DIR__ . '/../autoload.php';
require_once __DIR__ . '/legacy_migration.php';

$configParams = (require __DIR__ . '/../config/config.php')(require __DIR__ . '/../config/values.php');
$container = (require __DIR__ . '/../config/container.php')($configParams);

if (isset($argv)) {
    $_REQUEST["ORDER_REF"] = $argv[1];
    $_REQUEST["SAVEDRAFT"] = $argv[3];
}
$orderRef = $_REQUEST["ORDER_REF"];

runLegacyMigration($container, $configParams, $orderRef, SomeScraper::class);`;
        expect(extractLegacyFilesystemRoute(src, 'legacy_vendor_migration.php')).toEqual([]);
    });

    it('[ZERO FP] CLI scraper launcher with $argv only → no route', () => {
        const src = `<?php
require_once __DIR__ . '/../autoload.php';
$class = $argv[1];
$scraper = new $class();
$scraper->run();`;
        expect(extractLegacyFilesystemRoute(src, 'run_scraper.php')).toEqual([]);
    });

    it('[ZERO FP] dual web/CLI script: $argv always wins over $_REQUEST signals → no route', () => {
        // Even if the script has both web signals AND $argv, CLI wins:
        // a script aware of $argv is designed for CLI use.
        const src = `<?php
if (php_sapi_name() === 'cli') {
    $_GET['action'] = $argv[1];
}
echo processAction($_GET['action']);`;
        expect(extractLegacyFilesystemRoute(src, 'batch.php')).toEqual([]);
    });

    it('[POSITIVE] legacy web script without $argv is still detected', () => {
        // Regression guard: the $argv fix must NOT break detection of real web scripts
        const src = `<?php
$id = $_GET['id'];
echo '<h1>Product: ' . htmlspecialchars($id) . '</h1>';`;
        expect(extractLegacyFilesystemRoute(src, 'product.php'))
            .toEqual([{ method: 'GET', path: '/product.php', framework: 'legacy-php' }]);
    });

    // ── Signal tokens inside strings/comments must NOT count as evidence ──────────
    //
    // Regression: a Laminas navigation config (config/autoload/*.global.php, a pure
    // `return [...]` array) was classified as GET /navigation.global.php because an
    // icon token in a string literal ('icon-print') matched the \bprint\b output
    // signal. Signals are code evidence: they must be tested on string/comment-masked
    // source, never on raw text.

    it('[ZERO FP] config-array file with signal word inside a string → null', () => {
        const src = `<?php

return [
    'navigation' => [
        'default' => [
            [
                'uri' => '/orders/list.html',
                'label' => 'Orders',
                'icon' => 'icon-folder',
            ],
            [
                'uri' => '/orders/invoices.html',
                'label' => 'Invoices',
                'icon' => 'icon-print',
            ],
        ],
    ],
];`;
        expect(extractLegacyFilesystemRoute(src, 'config/autoload/navigation.global.php')).toEqual([]);
    });

    it('[ZERO FP] signal tokens only in comments → no route', () => {
        const src = `<?php
// This helper used to echo debug output and read $_GET directly.
/* header( was removed in the refactor */
function formatLabel($label) { return strtoupper($label); }`;
        expect(extractLegacyFilesystemRoute(src, 'helpers.php')).toEqual([]);
    });

    it('[ZERO FP] $argv mentioned in a string must not veto, but string signals must not detect either → no route', () => {
        // Both the veto and the signals read masked source: a doc string mentioning
        // them is inert in both directions.
        const src = `<?php
$usage = 'Run via web; $argv is never populated. Use echo for output.';
return $usage;`;
        expect(extractLegacyFilesystemRoute(src, 'notes.php')).toEqual([]);
    });

    it('[POSITIVE] real print statement with string payload is still detected', () => {
        // Masking removes string CONTENT, not the statement: \bprint\b still matches.
        const src = `<?php print '<html><body>Order list</body></html>';`;
        expect(extractLegacyFilesystemRoute(src, 'orders.php'))
            .toEqual([{ method: 'GET', path: '/orders.php', framework: 'legacy-php' }]);
    });

    it('[POSITIVE] php://input inside a string literal is still a valid input signal', () => {
        // php://input only ever appears as a string argument — it is exempt from masking.
        const src = `<?php $body = file_get_contents('php://input'); process($body);`;
        expect(extractLegacyFilesystemRoute(src, 'hook.php')).not.toHaveLength(0);
    });
});
