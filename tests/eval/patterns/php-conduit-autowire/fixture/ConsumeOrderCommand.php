<?php
namespace Acme\Orders;

use Acme\Conduit\ConduitSubscription;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

class ConsumeOrderCommand {
    public function __construct(
        #[Autowire(service: 'conduit.subscriptions.order_created')]
        private ConduitSubscription $subscription,
    ) {}

    public function handle(): void {
        foreach ($this->subscription->pull() as $envelope) {
            $this->processEvent($envelope);
            $this->subscription->ack($envelope);
        }
    }

    private function processEvent(object $envelope): void {
        // business logic
    }
}
