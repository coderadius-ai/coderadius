<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Acme\Inventory\Notification\NotificationPublisherInterface;

final class OrderController
{
    public function __construct(private NotificationPublisherInterface $publisher) {}

    public function placeOrder(array $payload): void
    {
        $this->publisher->publish($payload);
    }
}
