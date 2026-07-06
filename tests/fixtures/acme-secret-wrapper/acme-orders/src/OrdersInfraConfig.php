<?php

declare(strict_types=1);

namespace Acme\Orders\Infrastructure;

use Acme\Platform\EnvVault;

final class OrdersInfraConfig
{
    public function brokerHost(): string
    {
        return EnvVault::fetch('RABBITMQ_HOST', 'mq.acme-internal.consul');
    }

    public function dbHost(): string
    {
        return EnvVault::fetch('MYSQL_HOST', 'db.acme-prod.internal');
    }

    public function dbName(): string
    {
        return \Acme\Platform\EnvVault::fetch('MYSQL_DATABASE', 'orders');
    }

    public function debugEnabled(): bool
    {
        // The single literal getenv() in this repo: it turns the
        // code-referenced filter ON, which is exactly the failure shape this
        // fixture pins (wrapper-read keys invisible -> helm values dropped).
        return (bool) \getenv('APP_DEBUG');
    }
}
