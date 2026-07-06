import { describe, it, expect } from 'vitest';
import { isInboundPathEvident } from '../../../src/ai/workflows/sanitizer.js';

/**
 * Unit tests for the Evidence-Based INBOUND endpoint guard.
 *
 * Invariant: a path claimed as INBOUND by the LLM must be physically present
 * in the function's sourceCode as a quoted string literal.
 */
describe('isInboundPathEvident', () => {
    // ── Positive cases (should return true = PASS) ────────────────────────

    it('exact match — single quotes', () => {
        expect(isInboundPathEvident('/archive', `$app->post('/archive', ArchiveHandler::class);`)).toBe(true);
    });

    it('exact match — double quotes', () => {
        expect(isInboundPathEvident('/archive', `router.get("/archive", handler);`)).toBe(true);
    });

    it('exact match — full path with group prefix present verbatim', () => {
        // In some frameworks the full path appears directly
        expect(isInboundPathEvident(
            '/api/v1/records/archive',
            `#[Route('/api/v1/records/archive', methods: ['POST'])]`,
        )).toBe(true);
    });

    it('pass 2 — last segment match for Slim-style route groups', () => {
        // The full path /api/v1/records/archive is split:
        //   $app->group('/api/v1/records', ...) + $group->post('/archive', ...)
        // sourceCode of the routes file contains '/archive'
        const routesPhpSource = `
$app->group('/api/v1/records', function (RouteCollectorProxy $group) {
    $group->post('/archive', ArchiveHandler::class);
});`;
        expect(isInboundPathEvident('/api/v1/records/archive', routesPhpSource)).toBe(true);
    });

    it('pass 2 — Express .use() style', () => {
        expect(isInboundPathEvident('/users/profile', `router.use('/profile', profileRouter);`)).toBe(true);
    });

    it('pass 2 — Django-style path() with real syntax (no leading slash)', () => {
        // Django urls.py standard: NO leading slash. path('/calculate/') would raise a warning.
        // Real Django: path('calculate/', CalculateView.as_view(), name='calculate')
        expect(isInboundPathEvident('/api/calculate', `path('calculate/', CalculateView.as_view()),`)).toBe(true);
    });

    it('pass 2 — Django-style path() non-standard with leading slash also works', () => {
        // Some Django tutorials incorrectly show path('/calculate/') — test both are handled
        expect(isInboundPathEvident('/api/calculate', `path('/calculate/', CalculateView.as_view()),`)).toBe(true);
    });

    it('pass 2 — GetMapping annotation (Java-style)', () => {
        expect(isInboundPathEvident('/api/archive', `@GetMapping("/archive")`)).toBe(true);
    });

    // ── Negative cases (should return false = DROP) ────────────────────────

    it('drops ArchiveHandler.__invoke — path deduced from class name only', () => {
        // Real ArchiveHandler source: no /archive string anywhere
        const archiveInvokeSource = `
public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
{
    $data = (array) $request->getParsedBody();
    $id = (int) ($data['id'] ?? 0);
    $this->logger->info(sprintf('Archiving record %d', $id));
    $this->orchestrator->orchestrate($id, 'ARCHIVE', $data);
    $response->getBody()->write(json_encode(['status' => 'Record archived', 'id' => $id]));
    return $response->withHeader('Content-Type', 'application/json')->withStatus(200);
}`;
        expect(isInboundPathEvident('/archive', archiveInvokeSource)).toBe(false);
    });

    it('drops CalculateHandler.__invoke — CALCULATE in uppercase string does not match /calculate', () => {
        const calculateInvokeSource = `
public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
{
    $type = (string) ($data['type'] ?? 'DEFAULT');
    $this->orchestrator->orchestrate($id, $type, $data);
    $response->getBody()->write(json_encode(['status' => 'Calculation task triggered']));
    return $response->withStatus(202);
}`;
        expect(isInboundPathEvident('/calculate', calculateInvokeSource)).toBe(false);
    });

    it('drops when path not in source at all', () => {
        expect(isInboundPathEvident('/users', `$this->db->query("SELECT * FROM orders");`)).toBe(false);
    });

    it('drops when class name appears unquoted but path never does', () => {
        // "ArchiveService" in source should not match '/archive'
        expect(isInboundPathEvident('/archive', `class ArchiveService implements ServiceInterface {}`)).toBe(false);
    });

    // ── Min-length guard on segments ──────────────────────────────────────

    it('does not trigger pass-2 for short segments like /v1 (3 chars)', () => {
        // /v1 → segment 'v1' (2 chars) → skipped by min-length guard
        // The source has 'v1' everywhere, but guard prevents false positive
        const source = `$api = new Api('v1'); $api->register('/v2/ping');`;
        // /v1 has no exact match and 'v1' is too short → false
        expect(isInboundPathEvident('/v1', source)).toBe(false);
    });

    it('handles path with only param segments gracefully', () => {
        // /{param} → no significant segments after filtering → false
        expect(isInboundPathEvident('/{param}', `$handler->handle($request);`)).toBe(false);
    });

    it('OUTBOUND exemption is enforced at the callsite (sanitizer level), not in isInboundPathEvident', () => {
        // isInboundPathEvident itself has no direction awareness — it just checks evidence
        // The direction guard is in sanitizeAnalysis. This is by design.
        // Verify: even if path is not in source, isInboundPathEvident returns false
        // (the caller will decide whether to DROP based on direction).
        expect(isInboundPathEvident('/outbound-path', `$client->get('/other-path');`)).toBe(false);
    });
});
