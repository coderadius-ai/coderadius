<?php

namespace Acme\Inventory;

class InventoryAdapter
{
    private InventoryGqlClient $client;

    private string $token;

    public function __construct(InventoryGqlClient $client)
    {
        $this->client = $client;
    }

    public function createOrder(array $variables): array
    {
        $token = $this->client->getToken();
        $this->token = json_decode($token, true)['token'];

        $response = json_decode(
            $this->client->post(
                $this->token,
                file_get_contents(__DIR__ . '/Mutation/createOrder.gql'),
                $variables
            ),
            true
        );

        if (empty($response['data']['createOrder']['id'])) {
            throw new \Exception('createOrder failed: ' . ($response['errors'][0]['message'] ?? 'unknown'));
        }

        return [
            'id' => $response['data']['createOrder']['id'],
            'status' => $response['data']['createOrder']['status'],
        ];
    }

    public function cancelOrder(array $variables): array
    {
        $response = json_decode(
            $this->client->post(
                $this->token,
                file_get_contents(__DIR__ . '/Mutation/cancelOrder.gql'),
                $variables
            ),
            true
        );

        if (empty($response['data']['cancelOrder']['id'])) {
            throw new \Exception('cancelOrder failed');
        }

        return [
            'id' => (int)$response['data']['cancelOrder']['id'],
            'status' => $response['data']['cancelOrder']['status'],
        ];
    }
}
