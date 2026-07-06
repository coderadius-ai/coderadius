<?php

namespace Acme\Inventory\Client;

/**
 * Customer-style raw GraphQL transport: a thin wrapper that POSTs JSON
 * `{query, variables}` to the provider's HTTP endpoint. No Apollo, no
 * webonyx/graphql-php client, no apollo-client SDK — just Guzzle / PSR-18
 * with a string `query` argument.
 *
 * This fixture exercises Phases B (synthetic `.gql` index → injected
 * graphQLDocumentContext) and C (sanitizer/prompt body-shape rule)
 * end-to-end through the LLM.
 */
class OrderRawAdapter
{
    public function __construct(private \GuzzleHttp\ClientInterface $http) {}

    /**
     * Phase B test — operation document is loaded from a `.gql` file.
     * The eval test injects graphQLDocumentContext for `CreateOrder` so
     * the LLM emits the canonical GraphQL endpoint deterministically.
     */
    public function createOrder(array $orderInput): array
    {
        $token = $this->fetchToken();
        $query = file_get_contents(__DIR__ . '/Mutation/CreateOrder.gql');
        $response = $this->http->request('POST', 'https://inventory-graphql.acme.com/api', [
            'headers' => ['Authorization' => 'Bearer ' . $token],
            'json'    => ['query' => $query, 'variables' => ['input' => $orderInput]],
        ]);
        return json_decode((string) $response->getBody(), true);
    }

    /**
     * Phase C test — operation declared inline as a string literal. The
     * body-shape rule in the prompt + sanitizer must classify this as
     * GraphQL even without a `.gql` document context.
     */
    public function cancelOrder(string $orderId): array
    {
        $token = $this->fetchToken();
        $query = "mutation CancelOrder(\$id: ID!) { cancelOrder(id: \$id) { id status } }";
        $response = $this->http->request('POST', 'https://inventory-graphql.acme.com/api', [
            'headers' => ['Authorization' => 'Bearer ' . $token],
            'json'    => ['query' => $query, 'variables' => ['id' => $orderId]],
        ]);
        return json_decode((string) $response->getBody(), true);
    }

    /**
     * Edge — a subscription operation. `method` must be null on the emitted
     * endpoint (transport is WebSocket, stored as 'WS' in the graph).
     */
    public function subscribeOrderUpdates(): void
    {
        $token = $this->fetchToken();
        $query = "subscription OrderUpdates { orderUpdated { id status } }";
        $this->http->request('POST', 'https://inventory-graphql.acme.com/api', [
            'headers' => ['Authorization' => 'Bearer ' . $token],
            'json'    => ['query' => $query, 'variables' => []],
        ]);
    }

    /**
     * Edge / negative — a REST search endpoint where `query` is a URL query
     * parameter, NOT a body GraphQL field. The body-shape rule must NOT
     * trigger here.
     */
    public function fetchSearch(string $term): array
    {
        $url = 'https://inventory.acme.com/api/search?query=' . urlencode($term);
        $response = $this->http->request('GET', $url);
        return json_decode((string) $response->getBody(), true);
    }

    private function fetchToken(): string
    {
        return 'tok';
    }
}
