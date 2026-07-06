<?php

declare(strict_types=1);

namespace Acme\Inventory\Messaging\Message;

final class OrderShipped
{
    public function __construct(
        public readonly string $orderId,
        public readonly string $carrier,
    ) {
    }
}
