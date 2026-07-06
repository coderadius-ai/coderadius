<?php

declare(strict_types=1);

namespace Acme\Inventory\Cache;

interface CacheInterface
{
    public function read(string $key): ?string;
}
