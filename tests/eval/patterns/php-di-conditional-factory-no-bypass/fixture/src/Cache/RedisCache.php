<?php

declare(strict_types=1);

namespace Acme\Inventory\Cache;

final class RedisCache implements CacheInterface
{
    public function read(string $key): ?string
    {
        return null;
    }
}
