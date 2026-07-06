<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification\Transport;

final class AmqpClient
{
    public function basic_publish(array $payload, string $exchange, string $routingKey): void
    {
    }
}
