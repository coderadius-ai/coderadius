import { describe, it, expect } from 'vitest';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { PythonPlugin } from '../../../../src/ingestion/core/languages/python.js';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { GoPlugin } from '../../../../src/ingestion/core/languages/go.js';

// ═════════════════════════════════════════════════════════════════════════════
// validateInboundPath() — Language Plugin Strategy Pattern Tests
//
// These tests verify that each LanguagePlugin implements language-specific
// INBOUND path evidence rules, replacing the generic polyglot isInboundPathEvident()
// fallback for all known languages.
//
// Key design invariants tested:
//   - PHP/TS/Go: Pass 2 requires LEADING SLASH (false-positive safety guard)
//   - Python:    Pass 2 accepts optional leading slash (Django has none)
//   - All:       length > 0 filter — no arbitrary >= 4 cutoff breaking /pay, /faq
//   - All:       returns false for fully generic/empty source (no evidence)
// ═════════════════════════════════════════════════════════════════════════════

// ─── PHP Plugin ───────────────────────────────────────────────────────────────

describe('PHPPlugin.validateInboundPath', () => {
    const php = new PHPPlugin();

    // Pass 1: full path literal
    it('accepts full Slim route path in source', () => {
        expect(php.validateInboundPath('/api/v1/records/archive', `$app->post('/api/v1/records/archive', ArchiveHandler::class);`)).toBe(true);
    });

    it('accepts Symfony attribute route', () => {
        expect(php.validateInboundPath('/api/users', `#[Route('/api/users', methods: ['GET'])]`)).toBe(true);
    });

    // Pass 2: last segment with leading slash
    it('accepts Slim group pattern — last segment /archive has leading slash', () => {
        const src = `$app->group('/api/v1/records', function (RouteCollectorProxy $group) {
    $group->post('/archive', ArchiveHandler::class);
});`;
        expect(php.validateInboundPath('/api/v1/records/archive', src)).toBe(true);
    });

    it('accepts short route /pay — length > 0, leading slash is the guard', () => {
        expect(php.validateInboundPath('/pay', `$app->get('/pay', PayHandler::class);`)).toBe(true);
    });

    it('accepts /faq — 3 chars, would fail the old >= 4 filter', () => {
        expect(php.validateInboundPath('/faq', `$app->get('/faq', FaqController::class);`)).toBe(true);
    });

    // Leading slash required — the critical false-positive guard
    it('rejects /ORDER_REF — query-string key has no leading slash in source', () => {
        const src = `if ($request->has('ORDER_REF')) { $this->setOrderRef((int)$request->get('ORDER_REF')); }`;
        expect(php.validateInboundPath('/ORDER_REF', src)).toBe(false);
    });

    it('rejects /channel — AMQP property access, no leading slash in source', () => {
        const src = `$channel = $msg->get('channel');`;
        expect(php.validateInboundPath('/channel', src)).toBe(false);
    });

    it('rejects /routing_key — AMQP accessor, no leading slash in source', () => {
        const src = `$routingKey = $msg->get('routing_key');`;
        expect(php.validateInboundPath('/routing_key', src)).toBe(false);
    });

    it('rejects path with no evidence at all in source', () => {
        expect(php.validateInboundPath('/api/ghost', `return new Response('ok');`)).toBe(false);
    });

    // Dynamic route patterns
    it('accepts prefix+literal: ROUTE_PREFIX . "/archive" — leading slash present', () => {
        expect(php.validateInboundPath('/api/archive', `$app->get(ROUTE_PREFIX . '/archive', handler);`)).toBe(true);
    });

    // ── False-positive boundary test (the /pay_attention regression) ──
    it('rejects /pay when source has "/pay_attention" — lookahead prevents prefix match', () => {
        // [^"']* would wrongly match '/pay_attention_to_this_warning'. Lookahead rejects it.
        expect(php.validateInboundPath('/pay', `$logger->info('/pay_attention_to_this_warning');`)).toBe(false);
    });

    it('accepts /users from source with /users/{id} — brace param is valid boundary', () => {
        expect(php.validateInboundPath('/api/users', `$app->get('/users/{id}', UserHandler::class);`)).toBe(true);
    });
});

// ─── Python Plugin ────────────────────────────────────────────────────────────

describe('PythonPlugin.validateInboundPath', () => {
    const py = new PythonPlugin();

    // Pass 1: full path literal
    it('accepts full Flask path in source', () => {
        expect(py.validateInboundPath('/api/calculate', `@app.route('/api/calculate', methods=['POST'])`)).toBe(true);
    });

    // Pass 2: Django — no leading slash, trailing slash
    it('accepts Django path() without leading slash: path("calculate/", view)', () => {
        expect(py.validateInboundPath('/api/calculate', `path('calculate/', CalculateView.as_view(), name='calculate'),`)).toBe(true);
    });

    it('accepts short Django route: path("pay/", view) — 3 chars, no length cutoff', () => {
        expect(py.validateInboundPath('/pay', `path('pay/', PayView.as_view()),`)).toBe(true);
    });

    // Pass 2: Flask — with leading slash
    it('accepts Flask route with leading slash: @app.route("/calculate")', () => {
        expect(py.validateInboundPath('/api/calculate', `@app.route('/calculate')`)).toBe(true);
    });

    // FastAPI
    it('accepts FastAPI router: @router.post("/items")', () => {
        expect(py.validateInboundPath('/api/items', `@router.post('/items')`)).toBe(true);
    });

    it('rejects path with no evidence at all', () => {
        expect(py.validateInboundPath('/api/ghost', `def handle(request): return Response()`)).toBe(false);
    });

    // Dynamic route: prefix + literal (in source as quoted string)
    it('accepts prefix+literal: BASE_URL + "calculate/" — segment still quoted', () => {
        expect(py.validateInboundPath('/api/calculate', `path(BASE_URL + 'calculate/', view),`)).toBe(true);
    });

    // ── Mounted router limitation (documented known behavior) ──
    it('drops /users when prefix is in separate APIRouter file — correct V1 behavior', () => {
        // FastAPI: router = APIRouter(prefix="/users") in router.py
        //          @router.get("/") in handlers.py  ← this is the chunk source
        // The chunk source has no '/users' evidence — correct to drop.
        // Static extractor is responsible for cross-file route resolution.
        const handlerOnlySource = `@router.get("/")\ndef get_users(): return db.query(User).all()`;
        expect(py.validateInboundPath('/users', handlerOnlySource)).toBe(false);
    });

    // ── False-positive boundary test ──
    it('rejects /pay when source has "/payment" — lookahead prevents prefix match', () => {
        expect(py.validateInboundPath('/pay', `path('payment/', PaymentView.as_view()),`)).toBe(false);
    });
});

// ─── TypeScript Plugin ────────────────────────────────────────────────────────

describe('TypeScriptPlugin.validateInboundPath', () => {
    const ts = new TypeScriptPlugin();

    it('accepts Express route: router.get("/pay", handler)', () => {
        expect(ts.validateInboundPath('/api/pay', `router.get('/pay', PayHandler);`)).toBe(true);
    });

    it('accepts Hono route: app.get("/users", c => ...)', () => {
        expect(ts.validateInboundPath('/users', `app.get('/users', (c) => c.json(users));`)).toBe(true);
    });

    it('accepts short route /me — 2 chars, no arbitrary length cutoff', () => {
        expect(ts.validateInboundPath('/me', `router.get('/me', getMeHandler);`)).toBe(true);
    });

    it('accepts Fastify route with full path', () => {
        expect(ts.validateInboundPath('/api/v1/health', `fastify.get('/api/v1/health', healthHandler);`)).toBe(true);
    });

    it('rejects path with no routing evidence in source', () => {
        expect(ts.validateInboundPath('/api/ghost', `const result = await db.query('SELECT * FROM users');`)).toBe(false);
    });

    it('accepts backtick template route — TS plugin accepts backtick quotes', () => {
        // Tagged template route definitions: route`/pay`
        expect(ts.validateInboundPath('/api/pay', `router.get(\`/pay\`, handler);`)).toBe(true);
    });

    it('rejects route when segment is not preceded by a slash in source', () => {
        // 'pay' appears unquoted with no slash context
        expect(ts.validateInboundPath('/pay', `const pay = db.getPayment();`)).toBe(false);
    });

    // ── False-positive boundary test (the /pay_attention regression) ──
    it('rejects /pay when source has "/pay_attention" — segment not at word boundary', () => {
        // [^"']* would wrongly match this. Lookahead (?=[/"'`:{<]) correctly rejects it.
        expect(ts.validateInboundPath('/pay', `logger.info('/pay_attention_to_this_warning');`)).toBe(false);
    });

    it('accepts /users from source with /users/:id — slash after segment is valid boundary', () => {
        expect(ts.validateInboundPath('/api/users', `router.get('/users/:id', handler);`)).toBe(true);
    });
});

// ─── Go Plugin ────────────────────────────────────────────────────────────────

describe('GoPlugin.validateInboundPath', () => {
    const go = new GoPlugin();

    it('accepts Gin route: r.GET("/pay", handler)', () => {
        expect(go.validateInboundPath('/api/pay', `r.GET("/pay", PayHandler)`)).toBe(true);
    });

    it('accepts Echo route: e.POST("/users", createUser)', () => {
        expect(go.validateInboundPath('/users', `e.POST("/users", createUser)`)).toBe(true);
    });

    it('accepts http.HandleFunc: http.HandleFunc("/faq", faqHandler)', () => {
        expect(go.validateInboundPath('/faq', `http.HandleFunc("/faq", faqHandler)`)).toBe(true);
    });

    it('accepts short route /me — no arbitrary length cutoff', () => {
        expect(go.validateInboundPath('/me', `r.GET("/me", getMeHandler)`)).toBe(true);
    });

    it('rejects path with no routing evidence', () => {
        expect(go.validateInboundPath('/api/ghost', `db.Query("SELECT * FROM orders")`)).toBe(false);
    });

    // Go chi router uses `:param` style (not `{param}`) — test colon params are filtered
    it('accepts path with chi-style :param segment — last literal segment matches', () => {
        // /users/:id → segments: ['users'] → search for '/users/{id}' in source
        expect(go.validateInboundPath('/users/:id', `r.Get("/users/{id}", getUserHandler)`)).toBe(true);
    });

    // ── False-positive boundary test (the /pay_attention regression) ──
    it('rejects /pay when source has "/pay_attention" — lookahead prevents prefix match', () => {
        // [^"']* would wrongly match "/pay_attention_to_this_warning". Lookahead rejects it.
        expect(go.validateInboundPath('/pay', `logger.Info("/pay_attention_to_this_warning")`)).toBe(false);
    });

    it('accepts /users/{id} where {id} is the boundary delimiting the segment', () => {
        expect(go.validateInboundPath('/api/users', `r.GET("/users/{id}", getUserHandler)`)).toBe(true);
    });
});

// ─── Cross-plugin consistency ─────────────────────────────────────────────────

describe('validateInboundPath — cross-plugin consistency', () => {
    it('all plugins: returns false for empty source', () => {
        const plugins = [new PHPPlugin(), new PythonPlugin(), new TypeScriptPlugin(), new GoPlugin()];
        for (const p of plugins) {
            expect(p.validateInboundPath('/api/test', '')).toBe(false);
        }
    });

    it('PHP/TS/Go: all require leading slash in Pass 2 — pure unslashed segment rejected', () => {
        // 'archive' appears in source without a leading slash
        const src = `const archive = getArchive(); processArchive(archive);`;
        const leadingSlashPlugins = [new PHPPlugin(), new TypeScriptPlugin(), new GoPlugin()];
        for (const p of leadingSlashPlugins) {
            expect(p.validateInboundPath('/archive', src)).toBe(false);
        }
    });

    it('Python: optional leading slash — "archive/" (Django trailing slash) is accepted', () => {
        // Django source has 'archive/' — no leading slash, but trailing slash
        const src = `path('archive/', ArchiveView.as_view()),`;
        const py = new PythonPlugin();
        expect(py.validateInboundPath('/archive', src)).toBe(true);
    });
});
