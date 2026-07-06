<?php

declare(strict_types=1);

namespace Acme\Inventory;

use GuzzleHttp\Client;
use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Message\AMQPMessage;
use PDO;

/**
 * Synchronises stock levels between the warehouse and the storefront.
 *
 * Five methods sharing one constructor's DI context: three perform external
 * I/O (database write, broker publish, outbound HTTP), two are pure helpers.
 */
final class InventorySyncService
{
    public function __construct(
        private readonly PDO $connection,
        private readonly AMQPChannel $publisher,
        private readonly Client $httpClient,
    ) {
    }

    public function reserveStock(string $sku, int $quantity): bool
    {
        $statement = $this->connection->prepare(
            'INSERT INTO inventory_reservations (sku, quantity, reserved_at) VALUES (:sku, :quantity, NOW())'
        );

        return $statement->execute([
            'sku' => $this->formatSku($sku),
            'quantity' => $quantity,
        ]);
    }

    public function publishLowStock(string $sku, int $remaining): void
    {
        $payload = json_encode([
            'sku' => $sku,
            'remaining' => $remaining,
        ], JSON_THROW_ON_ERROR);

        $this->publisher->basic_publish(
            new AMQPMessage($payload),
            'inventory',
            'inventory.low_stock'
        );
    }

    public function fetchSupplierPrice(string $sku): float
    {
        $response = $this->httpClient->get('/api/v1/suppliers/prices/' . $this->formatSku($sku));
        $body = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);

        return (float) $body['price'];
    }

    public function formatSku(string $sku): string
    {
        return strtoupper(trim($sku));
    }

    public function validateQuantity(int $quantity): bool
    {
        return $quantity > 0 && $quantity <= 10000;
    }
}
