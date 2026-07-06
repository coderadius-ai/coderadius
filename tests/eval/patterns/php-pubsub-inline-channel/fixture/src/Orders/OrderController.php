<?php

declare(strict_types=1);

namespace Acme\Inventory\Orders;

use Psr\Container\ContainerInterface;
use Acme\Inventory\Streaming\StreamingPublisher;

/**
 * Pulls the publisher from the container inside the method body (Pattern A:
 * local-var alias), so the DI bypass resolves the cross-file channel emitted
 * by StreamingPublisher::publishStreamingEvent.
 */
final class OrderController
{
    public function __construct(private ContainerInterface $container) {}

    public function placeOrder(array $payload): void
    {
        $publisher = $this->container->get(StreamingPublisher::class);
        $publisher->publishStreamingEvent($payload);
    }
}
