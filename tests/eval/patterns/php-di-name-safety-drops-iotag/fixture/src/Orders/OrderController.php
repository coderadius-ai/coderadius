<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Acme\Inventory\Notification\NotificationPublisher;

final class OrderController
{
    public function __construct(private NotificationPublisher $publisher) {}

    public function placeOrder(array $payload): void
    {
        $this->publisher->publish($payload);
    }
}
