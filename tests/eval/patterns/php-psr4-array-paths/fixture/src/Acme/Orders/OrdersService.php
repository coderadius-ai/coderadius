<?php

namespace Acme\Orders;

use Acme\Inventory\LegacyStockClient;

class OrdersService
{
    private $stockClient;

    public function __construct(LegacyStockClient $stockClient)
    {
        $this->stockClient = $stockClient;
    }

    public function canFulfil(string $sku, int $quantity): bool
    {
        return $this->stockClient->fetchStockLevel($sku) >= $quantity;
    }
}
