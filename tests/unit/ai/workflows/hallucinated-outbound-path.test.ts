/**
 * Unit test — `isHallucinatedOutboundPath` MUST drop OUTBOUND emergent paths
 * whose shape is a class/method identifier from the source rather than a real
 * HTTP route.
 *
 * Root cause (LLM hallucination chain):
 *   - PSR-18 HTTP wrappers like `Client::get($uri)` fail the static gates
 *     because the gate logic targets Guzzle short-form / `fetch` / `axios` /
 *     `curl_exec`. The functions that hold the real path literal are dropped.
 *   - The thin delegation wrapper (Adapter.verify, Adapter.init) passes the
 *     `DI Alias` gate via a tainted property, reaches the LLM with NO path
 *     literal in its source code.
 *   - The LLM then emits the wrapper class/method name as the path:
 *       `/<WrapperClass>`, `/<WrapperClass>.<method>`, `/<Service>:{method}`,
 *       `/<host.tld>/...` (when it forgets to strip the hostname).
 *
 * The existing `isInboundPathEvident` guard is explicitly INBOUND-only.
 * `isHallucinatedOutboundPath` is the symmetric OUTBOUND defense.
 *
 * Test fixtures use the `acme` vocabulary per CLAUDE.md anonymisation rule.
 */

import { describe, it, expect } from 'vitest';
import { isHallucinatedOutboundPath } from '../../../../src/ai/workflows/sanitizer.js';

describe('isHallucinatedOutboundPath', () => {
    describe('drops class-name hallucinations (single PascalCase segment)', () => {
        it('drops `/OrderClient` when not present in source', () => {
            const source = `return $this->orderClient->get($id);`;
            expect(isHallucinatedOutboundPath('/OrderClient', source, [])).toBe(true);
        });

        it('drops `/ShipmentAdapter` when not present in source', () => {
            const source = `public function verify(...) { return $this->shipmentClient->get(...); }`;
            expect(isHallucinatedOutboundPath('/ShipmentAdapter', source, [])).toBe(true);
        });

        it('keeps `/OrderClient` when it appears as quoted literal in source (legit REST path)', () => {
            const source = `$response = $http->get('/OrderClient');`;
            expect(isHallucinatedOutboundPath('/OrderClient', source, [])).toBe(false);
        });

        it('keeps short single segments (avoid catching legit `/Users`-style paths)', () => {
            const source = `fetch('/api');`; // path itself not in source
            expect(isHallucinatedOutboundPath('/Users', source, [])).toBe(false);
        });
    });

    describe('drops class.method hallucinations (PascalCase.lowerCamelCase)', () => {
        it('drops `/OrderServiceAdapter.create`', () => {
            const source = `$this->orderServiceAdapter->create($payload);`;
            expect(isHallucinatedOutboundPath('/OrderServiceAdapter.create', source, [])).toBe(true);
        });

        it('drops `/PaymentClientAdapter.send`', () => {
            const source = `$this->paymentClientAdapter->send($data);`;
            expect(isHallucinatedOutboundPath('/PaymentClientAdapter.send', source, [])).toBe(true);
        });

        it('drops `/InventoryClient.initSave` (multi-word lowerCamelCase method)', () => {
            const source = `$this->inventoryClient->initSave($args);`;
            expect(isHallucinatedOutboundPath('/InventoryClient.initSave', source, [])).toBe(true);
        });

        it('keeps `/api/v1.0/orders` (dot inside multi-segment path with version)', () => {
            const source = `fetch('/api/v1.0/orders');`;
            expect(isHallucinatedOutboundPath('/api/v1.0/orders', source, [])).toBe(false);
        });

        it('keeps `/users/{id}.json` (file extension, not class.method)', () => {
            const source = `axios.get('/users/{id}.json')`;
            expect(isHallucinatedOutboundPath('/users/{id}.json', source, [])).toBe(false);
        });
    });

    describe('drops class:{method} template hallucinations', () => {
        it('drops `/NotificationService:{publish}`', () => {
            const source = `$service = $container->get('notification-service'); $service->publish($evt);`;
            expect(isHallucinatedOutboundPath('/NotificationService:{publish}', source, [])).toBe(true);
        });

        it('drops `/InventoryService:{reserve}`', () => {
            const source = `$inv->reserve($qty);`;
            expect(isHallucinatedOutboundPath('/InventoryService:{reserve}', source, [])).toBe(true);
        });
    });

    describe('drops hostname-in-first-segment hallucinations', () => {
        it('drops `/api.acme.com/v2/orders` (host kept after protocol strip)', () => {
            const source = `curl_setopt($ch, CURLOPT_URL, 'https://api.acme.com/v2/orders');`;
            expect(isHallucinatedOutboundPath('/api.acme.com/v2/orders', source, [])).toBe(true);
        });

        it('drops `/www.acme.com/services/2011/01/IOrderService/PlaceOrder` (SOAP host kept)', () => {
            const source = `$client = new SoapClient('https://www.acme.com/services/2011/01/IOrderService?wsdl');`;
            expect(isHallucinatedOutboundPath('/www.acme.com/services/2011/01/IOrderService/PlaceOrder', source, [])).toBe(true);
        });

        it('keeps `/api/users` (no TLD-like first segment)', () => {
            const source = `fetch('/api/users');`;
            expect(isHallucinatedOutboundPath('/api/users', source, [])).toBe(false);
        });

        it('keeps `/v1/charges` (numeric version, no TLD pattern)', () => {
            const source = `axios.post('/v1/charges', body);`;
            expect(isHallucinatedOutboundPath('/v1/charges', source, [])).toBe(false);
        });
    });

    describe('cross-check against infrastructure[] ExternalAPI names', () => {
        it('drops path whose first segment matches an ExternalAPI infra name', () => {
            const source = `return $this->orderClient->get();`;
            const infra = [{ name: 'OrderClient', type: 'ExternalAPI' as const, operation: 'READS' as const }];
            expect(isHallucinatedOutboundPath('/OrderClient', source, infra)).toBe(true);
        });

        it('drops path whose first segment matches an ExternalAPI even with method tail', () => {
            const source = `$this->client->init($id);`;
            const infra = [{ name: 'OrderClient', type: 'ExternalAPI' as const, operation: 'READS' as const }];
            expect(isHallucinatedOutboundPath('/OrderClient.init', source, infra)).toBe(true);
        });

        it('does NOT drop legit path even if infra has same-named ExternalAPI', () => {
            // Real path `/api/orders` happens to be hosted by an ExternalAPI named "OrderClient".
            // The first segment `api` does not match `OrderClient`, so we keep.
            const source = `fetch('/api/orders');`;
            const infra = [{ name: 'OrderClient', type: 'ExternalAPI' as const, operation: 'READS' as const }];
            expect(isHallucinatedOutboundPath('/api/orders', source, infra)).toBe(false);
        });

        it('does NOT drop when infra entry has non-ExternalAPI type', () => {
            // A Database named "OrderClient" should not affect the API guard.
            const source = `fetch('/OrderClient');`; // path literally in source
            const infra = [{ name: 'OrderClient', type: 'Database' as const, operation: 'READS' as const }];
            expect(isHallucinatedOutboundPath('/OrderClient', source, infra)).toBe(false);
        });
    });

    describe('preserves legitimate REST paths (no false positives)', () => {
        it('keeps `/api/orders/{orderId}`', () => {
            const source = `fetch(\`/api/orders/\${id}\`)`;
            expect(isHallucinatedOutboundPath('/api/orders/{orderId}', source, [])).toBe(false);
        });

        it('keeps `/health`', () => {
            expect(isHallucinatedOutboundPath('/health', `axios.get('/health')`, [])).toBe(false);
        });

        it('keeps `/v1/customers/{customerId}/invoices`', () => {
            const source = `client.get('/v1/customers/X/invoices')`;
            expect(isHallucinatedOutboundPath('/v1/customers/{customerId}/invoices', source, [])).toBe(false);
        });

        it('keeps `/api/v1/payment-methods` (kebab-case)', () => {
            const source = `fetch('/api/v1/payment-methods')`;
            expect(isHallucinatedOutboundPath('/api/v1/payment-methods', source, [])).toBe(false);
        });

        it('keeps GraphQL canonical paths (already caught by isNoisyEndpoint, never reaches us)', () => {
            // GraphQL paths contain a space. The contract is: this guard is only invoked
            // for non-GraphQL OUTBOUND HTTP paths. Defensive return false.
            expect(isHallucinatedOutboundPath('GRAPHQL QUERY orders', '', [])).toBe(false);
        });
    });
});
