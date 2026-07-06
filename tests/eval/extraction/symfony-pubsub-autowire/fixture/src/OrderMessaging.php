<?php

namespace App;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

// Symfony Autowire-bound Pub/Sub: the #[Autowire(service: ...)] service id names
// the physical channel; the method call (publish vs consume) gives the direction.
class OrderPublisher
{
    public function __construct(
        #[Autowire(service: 'order_events_topic')]
        private readonly object $orderTopic,
    ) {
    }

    public function publishOrderCreated(array $payload): void
    {
        $this->orderTopic->publish($payload);
    }
}

class OrderConsumer
{
    public function __construct(
        #[Autowire(service: 'order_events_subscription')]
        private readonly object $orderSubscription,
    ) {
    }

    public function handle(): void
    {
        $this->orderSubscription->consume();
    }
}
