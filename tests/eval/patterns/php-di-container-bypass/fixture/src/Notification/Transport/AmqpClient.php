<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification\Transport;

final class AmqpClient
{
    public function basic_publish(string $topic, array $payload): void
    {
        // pretend AMQP basic_publish — only the call site matters for the
        // critical-invocation extractor.
    }
}
