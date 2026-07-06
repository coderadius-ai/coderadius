<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\NotificationPublisher;

/**
 * Uses Pattern A (local-var alias) so the DI bypass engages via the
 * Symfony YAML-registered binding. Pure ctor-injection without a
 * container lookup does not currently fire the bypass for `publish`-method
 * receivers (see php-di-ctor-property-fetch for the rationale).
 */
final class OrderController
{
    public function __construct(private ContainerInterface $container) {}

    public function placeOrder(array $payload): void
    {
        $publisher = $this->container->get(NotificationPublisher::class);
        $publisher->publish($payload);
    }
}
