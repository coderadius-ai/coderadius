<?php
namespace App\Consumers;

use Acme\Conduit\ConduitSubscription;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

class RewardEventConsumer {
    public function __construct(
        #[Autowire(service: 'conduit.subscriptions.reward_created')]
        private ConduitSubscription $subscription,
    ) {}

    public function consume(): void {
        foreach ($this->subscription->pull() as $envelope) {
            $this->subscription->ack($envelope);
        }
    }
}
