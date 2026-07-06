<?php
namespace Acme\Orders;

use Acme\Conduit\ConduitClient;

class OrderService {
    private ConduitClient $relay;

    public function __construct(ConduitClient $relay) {
        $this->relay = $relay;
    }

    public function finalizeOrder(string $orderId, array $payload): void {
        $data = array_merge(['orderId' => $orderId], $payload);
        $this->relay->dispatch('Platform-OrderCreated', $data, 'com.acme.events');
    }

    public function calculateDiscount(float $amount): float {
        return $amount * 0.1;
    }
}
