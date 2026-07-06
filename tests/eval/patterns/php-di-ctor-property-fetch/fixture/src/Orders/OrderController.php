<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\NotificationPublisher;

/**
 * Realistic shape: the controller pulls the publisher from the container
 * INSIDE the method body (Pattern A: local-var alias). Pure ctor-injection
 * without an explicit container lookup does not currently engage the DI
 * bypass — the upstream PHP `publish`-method handler in value-resolution.ts
 * returns before the DI binding fallback can co-emit a serviceId fact,
 * and Pattern B emit-new was rolled back after it caused a recall
 * regression on real codebases (only ~10% of bound components have
 * extractable ioTags, so emitting facts for every `$this->prop->method()`
 * promoted thousands of consumers through Gate 5 without ever producing
 * a bypass).
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
