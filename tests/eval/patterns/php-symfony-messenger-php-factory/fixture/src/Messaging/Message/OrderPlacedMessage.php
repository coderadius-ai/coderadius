<?php

declare(strict_types=1);

namespace Acme\Inventory\Messaging\Message;

final class OrderPlaced
{
    public function __construct(
        public readonly string $orderId,
        public readonly int $quantity,
    ) {
    }
}
