<?php

declare(strict_types=1);

namespace Acme\Inventory\Cache;

final class NullCache implements CacheInterface
{
    public function read(string $key): ?string
    {
        return null;
    }
}
