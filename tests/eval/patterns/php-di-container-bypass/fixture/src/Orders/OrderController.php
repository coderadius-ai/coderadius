<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\NotificationPublisher;

final class OrderController
{
    public function __construct(private ContainerInterface $container) {}

    public function placeOrder(array $payload): void
    {
        $this->container->get(NotificationPublisher::class)->publish($payload);
    }
}
