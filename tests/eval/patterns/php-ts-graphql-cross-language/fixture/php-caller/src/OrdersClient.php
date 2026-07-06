<?php
namespace Acme\Orders;

use GuzzleHttp\Client;

final class OrdersClient
{
    public function __construct(private readonly Client $http) {}

    public function initOrder(string $sku, int $quantity): array
    {
        $response = $this->http->post(\getenv('ORDERS_API_URL') . '/graphql', [
            'json' => [
                'query' => 'mutation InitOrder($sku: String!, $quantity: Int!) {
                    initOrder(sku: $sku, quantity: $quantity) { id status }
                }',
                'variables' => [
                    'sku' => $sku,
                    'quantity' => $quantity,
                ],
            ],
        ]);

        return \json_decode((string) $response->getBody(), true);
    }
}
