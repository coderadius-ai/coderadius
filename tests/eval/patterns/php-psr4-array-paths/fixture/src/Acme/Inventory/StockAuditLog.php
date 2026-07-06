<?php

namespace Acme\Inventory;

class StockAuditLog
{
    private $entries = [];

    public function record(string $sku): void
    {
        $this->entries[] = $sku;
    }
}
