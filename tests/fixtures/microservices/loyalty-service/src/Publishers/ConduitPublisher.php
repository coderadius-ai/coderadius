<?php
namespace Acme\LoyaltyService\Publishers;

class ConduitPublisher {
    private $relayClient;

    public function __construct($relayClient) {
        $this->relayClient = $relayClient;
    }

    public function publishRewardCreated(string $memberNumber, array $details): void {
        $data = array_merge(['memberNumber' => $memberNumber], $details);
        // Taint extraction: topic should be extracted as Reward-Created
        $this->relayClient->dispatch('Reward-Created', $data, 'com.acme.logistics.loyalty');
    }
}
