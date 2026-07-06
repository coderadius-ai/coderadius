<?php

namespace Acme\Cache;

/**
 * Memcached wrapper. The ext-memcached client is constructed and its server is
 * registered entirely inside the constructor — the cache I/O sink. Constructors
 * are dropped by the taint gate, so this never reaches the per-function binding
 * loop and no :Datastore is created from code. The declared `ext-memcached`
 * client library is what lets standalone promotion recover it.
 */
final class Cache
{
    private \Memcached $connection;

    public function __construct(string $host, int $port)
    {
        $this->connection = new \Memcached();
        $this->connection->addServer($host, $port);
    }

    public function get(string $key): mixed
    {
        return $this->connection->get($key);
    }
}
