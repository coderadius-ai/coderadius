<?php

namespace App;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

// Held-out: different resource, different channel names, and different verbs
// (->send() for WRITES, ->subscribe() for READS) to exercise the full pub/sub
// verb set, not just publish/consume.
class ShippingNotifier
{
    public function __construct(
        #[Autowire(service: 'shipping_updates_topic')]
        private readonly object $updatesTopic,
    ) {
    }

    public function announceDispatch(array $payload): void
    {
        $this->updatesTopic->send($payload);
    }
}

class ShippingListener
{
    public function __construct(
        #[Autowire(service: 'shipping_events_subscription')]
        private readonly object $eventsSubscription,
    ) {
    }

    public function listen(): void
    {
        $this->eventsSubscription->subscribe();
    }
}
