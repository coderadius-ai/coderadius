<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Acme\Inventory\Cache\CacheInterface;

final class OrderController
{
    public function __construct(private CacheInterface $cache) {}

    public function getOrder(string $id): ?string
    {
        return $this->cache->read($id);
    }
}
