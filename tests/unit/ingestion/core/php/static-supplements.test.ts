import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PHPPlugin } from '../../../../../src/ingestion/core/languages/php.js';
import { extractPhpStaticSupplements } from '../../../../../src/ingestion/core/languages/php/static-supplements.js';
import {
    clearGraphQLClientDecorators,
    registerGraphQLClientDecorator,
} from '../../../../../src/ingestion/core/graphql-client-registry.js';
import type { CodeChunk } from '../../../../../src/graph/types.js';

const plugin = new PHPPlugin();
const parser = plugin.createParser();

function parse(source: string) {
    return parser.parse(source);
}

function chunkOf(source: string, methodName: string, filepath = 'src/Inventory/InventoryAdapter.php'): { rootNode: import('tree-sitter').SyntaxNode; chunk: CodeChunk } {
    const tree = parse(source);
    const chunks = plugin.extractFunctions(tree, source, filepath);
    const chunk = chunks.find(c => c.name.endsWith(`.${methodName}`) || c.name === methodName);
    if (!chunk) throw new Error(`chunk for method ${methodName} not found in: ${chunks.map(c => c.name).join(', ')}`);
    return { rootNode: tree.rootNode, chunk };
}

beforeEach(() => clearGraphQLClientDecorators());
afterEach(() => clearGraphQLClientDecorators());

describe('extractPhpStaticSupplements (graphql-client decorator path)', () => {
    // ─── Case 1: same-namespace, bare property type (regression) ─────────────
    it('matches when caller and wrapper are in the same namespace and property uses bare classname', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post', ['query', 'variables']);

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private InventoryGqlClient $client;
    private string $token;

    public function __construct(InventoryGqlClient $client)
    {
        $this->client = $client;
    }

    public function init(array $vars): array
    {
        return json_decode($this->client->post($this->token, file_get_contents(__DIR__ . '/Mutation/createOrder.gql'), $vars), true);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);

        expect(result).not.toBeNull();
        expect(result!.clientBindings).toHaveLength(1);
        expect(result!.clientBindings![0]).toMatchObject({
            token: 'Acme\\Inventory\\InventoryGqlClient',
            clientKind: 'sdk',
            protocol: 'graphql',
            evidence: 'coderadius.yaml:graphql-client',
            typeName: 'Acme\\Inventory\\InventoryGqlClient',
        });
    });

    // ─── Case 2: different namespace + use statement (regression) ────────────
    it('matches when caller imports wrapper via `use` from a different namespace', () => {
        registerGraphQLClientDecorator('Foo\\Bar\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

use Foo\\Bar\\InventoryGqlClient;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Foo\\Bar\\InventoryGqlClient');
    });

    // ─── Case 3: aliased use ─────────────────────────────────────────────────
    it('matches when wrapper is imported with `use ... as Alias` and property uses the alias', () => {
        registerGraphQLClientDecorator('Foo\\Bar\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

use Foo\\Bar\\InventoryGqlClient as IGC;

class InventoryAdapter
{
    private IGC $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Foo\\Bar\\InventoryGqlClient');
    });

    // ─── Case 4: FQCN type-hint with leading backslash, no use ───────────────
    it('matches when property is typed with a leading-backslash FQCN', () => {
        registerGraphQLClientDecorator('Foo\\Bar\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private \\Foo\\Bar\\InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Foo\\Bar\\InventoryGqlClient');
    });

    // ─── Case 5: bare classname configured (regression of existing path) ─────
    it('matches a configured bare classname against any receiver short-name', () => {
        registerGraphQLClientDecorator('InventoryGqlClient::post');

        const adapter = `<?php
namespace Some\\Other\\Place;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).not.toBeNull();
        expect(result!.clientBindings![0].token.endsWith('InventoryGqlClient')).toBe(true);
    });

    // ─── Case 6: inline `(new X())->post()` ──────────────────────────────────
    it('matches inline (new InventoryGqlClient())->post()', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function init(array $vars): array
    {
        return (new InventoryGqlClient())->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Acme\\Inventory\\InventoryGqlClient');
    });

    // ─── Case 7: static call X::post() ───────────────────────────────────────
    it('matches static call InventoryGqlClient::post()', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function init(array $vars): array
    {
        return InventoryGqlClient::post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Acme\\Inventory\\InventoryGqlClient');
    });

    // ─── Case 8: parameter typed with the wrapper class ──────────────────────
    it('matches when receiver is a method parameter typed as the wrapper class', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function init(InventoryGqlClient $param, array $vars): array
    {
        return $param->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Acme\\Inventory\\InventoryGqlClient');
    });

    // ─── Case 9: method name mismatch — must not emit ────────────────────────
    it('does not emit when the called method name is different', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->send('tok', 'query', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 10: receiver typed to a different class in same namespace ──────
    it('does not emit when receiver type is a different class in the same namespace (fail-closed)', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private SomethingElse $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 11: untyped receiver — must not emit ───────────────────────────
    it('does not emit when receiver type is unresolvable (fail-closed)', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function init($client, array $vars): array
    {
        return $client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 12: wrapper's own implementation chunk — no false positive ─────
    it('does not emit a binding for the wrapper class implementation itself', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const wrapper = `<?php
namespace Acme\\Inventory;

class InventoryGqlClient
{
    private string $uri;

    public function post(string $token, string $query, array $vars): string
    {
        return file_get_contents($this->uri . '/api');
    }
}
`;
        const { rootNode, chunk } = chunkOf(wrapper, 'post', 'src/Inventory/InventoryGqlClient.php');
        const result = extractPhpStaticSupplements(rootNode, wrapper, 'src/Inventory/InventoryGqlClient.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 13: dedup multiple call-sites of the same decorator ────────────
    it('emits a single ClientBinding per receiver type even with multiple call-sites', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        $a = $this->client->post('tok', 'mutation { a }', $vars);
        $b = $this->client->post('tok', 'mutation { b }', $vars);
        return [$a, $b];
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings).toHaveLength(1);
    });

    // ─── Case 14: no decorator registered — early null ───────────────────────
    it('returns null when no graphql-client decorators are registered', () => {
        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 16: PHP 8 constructor property promotion ───────────────────────
    it('matches when the wrapper is injected via PHP 8 constructor property promotion', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function __construct(private InventoryGqlClient $client) {}

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result?.clientBindings?.[0]?.token).toBe('Acme\\Inventory\\InventoryGqlClient');
    });

    // ─── Case 17: inherited property — fail-closed (documented limitation) ───
    it('does NOT emit for properties only declared on a parent class (inheritance fail-closed)', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        // The file declares only InventoryAdapter, with no explicit property
        // declaration for $client. PHP would resolve $this->client through
        // BaseAdapter at runtime, but we don't resolve cross-file.
        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter extends BaseAdapter
{
    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 18: local-var assignment — fail-closed ─────────────────────────
    it('does NOT emit when receiver comes from a previous-line $var = new X() assignment', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    public function init(array $vars): array
    {
        $client = new InventoryGqlClient();
        return $client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        // Tracking $client back to its assignment is data-flow analysis, not
        // chunk-local AST resolution. Fail-closed by design.
        expect(result).toBeNull();
    });

    // ─── Case 19: factory-returned receiver — fail-closed ────────────────────
    it('does NOT emit when receiver comes from a factory call', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory;

class InventoryAdapter
{
    private ClientFactory $factory;

    public function init(array $vars): array
    {
        $client = $this->factory->createInventoryClient();
        return $client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        expect(result).toBeNull();
    });

    // ─── Case 15: nested namespace, no use — must NOT match ──────────────────
    it('does not match when caller is in a sub-namespace of the wrapper without a `use`', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const adapter = `<?php
namespace Acme\\Inventory\\Sub;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    public function init(array $vars): array
    {
        return $this->client->post('tok', 'mutation { x }', $vars);
    }
}
`;
        const { rootNode, chunk } = chunkOf(adapter, 'init');
        const result = extractPhpStaticSupplements(rootNode, adapter, 'src/Inventory/InventoryAdapter.php', chunk);
        // `InventoryGqlClient` resolves to `Acme\Inventory\Sub\InventoryGqlClient`,
        // which does NOT match the configured `Acme\Inventory\InventoryGqlClient`.
        expect(result).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Wrapper-implementation suppression — a class registered as a graphql-client
// (or http-client) decorator IS the SDK boundary CodeRadius already models.
// Its internal HTTP plumbing (PSR-18 sendRequest/createRequest on its own
// injected Psr\Http\* properties) is an implementation detail of that
// boundary, NOT a separate outbound dependency. Without suppression the
// wrapper's own chunks emit psr18-ast ClientBindings on themselves.
// ═════════════════════════════════════════════════════════════════════════════

describe('extractPhpStaticSupplements (wrapper-implementation suppression)', () => {
    const WRAPPER_WITH_PSR18 = `<?php
namespace Acme\\Inventory;

use Psr\\Http\\Client\\ClientInterface;
use Psr\\Http\\Message\\RequestFactoryInterface;

class InventoryGqlClient
{
    private ClientInterface $httpClient;
    private RequestFactoryInterface $httpRequestFactory;
    private string $uri;

    public function getToken(): string
    {
        $request = $this->httpRequestFactory->createRequest('POST', $this->uri);
        $response = $this->httpClient->sendRequest($request);
        return (string) $response->getBody();
    }
}
`;

    it('suppresses PSR-18 bindings inside a registered graphql-client wrapper class', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const { rootNode, chunk } = chunkOf(WRAPPER_WITH_PSR18, 'getToken', 'src/Inventory/InventoryGqlClient.php');
        const result = extractPhpStaticSupplements(rootNode, WRAPPER_WITH_PSR18, 'src/Inventory/InventoryGqlClient.php', chunk);
        expect(result).toBeNull();
    });

    it('still emits PSR-18 bindings when the same class is NOT a registered wrapper', () => {
        // No decorator registered → PSR-18 AST detection works as designed.
        const { rootNode, chunk } = chunkOf(WRAPPER_WITH_PSR18, 'getToken', 'src/Inventory/InventoryGqlClient.php');
        const result = extractPhpStaticSupplements(rootNode, WRAPPER_WITH_PSR18, 'src/Inventory/InventoryGqlClient.php', chunk);
        expect(result).not.toBeNull();
        expect(result!.clientBindings!.map(b => b.token).sort()).toEqual([
            'Psr\\Http\\Client\\ClientInterface',
            'Psr\\Http\\Message\\RequestFactoryInterface',
        ]);
    });

    it('suppression is per-chunk: a different class in the same file still emits', () => {
        registerGraphQLClientDecorator('Acme\\Inventory\\InventoryGqlClient::post');

        const multiClass = `<?php
namespace Acme\\Inventory;

use Psr\\Http\\Client\\ClientInterface;

class InventoryGqlClient
{
    private ClientInterface $httpClient;

    public function getToken(): string
    {
        return (string) $this->httpClient->sendRequest($r)->getBody();
    }
}

class UnrelatedNotifier
{
    private ClientInterface $httpClient;

    public function notify(): void
    {
        $this->httpClient->sendRequest($r);
    }
}
`;
        // Wrapper chunk → suppressed.
        const wrapper = chunkOf(multiClass, 'getToken', 'src/Inventory/Mixed.php');
        expect(extractPhpStaticSupplements(wrapper.rootNode, multiClass, 'src/Inventory/Mixed.php', wrapper.chunk)).toBeNull();

        // Unrelated class chunk in the same file → still emits.
        const other = chunkOf(multiClass, 'notify', 'src/Inventory/Mixed.php');
        const result = extractPhpStaticSupplements(other.rootNode, multiClass, 'src/Inventory/Mixed.php', other.chunk);
        expect(result).not.toBeNull();
        expect(result!.clientBindings![0].token).toBe('Psr\\Http\\Client\\ClientInterface');
    });
});
