<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\NotificationPublisherInterface;

/**
 * Uses the container directly with the INTERFACE class constant
 * (Pattern C). The DiBindingResolver Phase 3 (autowiring interface) has
 * registered NotificationPublisherInterface → AmqpNotificationPublisher;
 * the bypass follows that alias to the concrete's ioTags.
 */
final class OrderController
{
    public function __construct(private ContainerInterface $container) {}

    public function placeOrder(array $payload): void
    {
        $this->container->get(NotificationPublisherInterface::class)->publish($payload);
    }
}
