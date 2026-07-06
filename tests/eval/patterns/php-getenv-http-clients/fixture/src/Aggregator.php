<?php
namespace Acme\Orders;

use GuzzleHttp\Client;

final class Aggregator
{
    public function __construct(
        private readonly Client $http,
        private readonly array $config,
    ) {}

    public function quote(string $sku, int $quantity): array
    {
        $ordersUrl = $this->config['clients']['orders']['url'];
        $paymentUrl = $this->config['clients']['payment']['url'];
        $inventoryHost = $this->config['clients']['inventory']['host'];

        $this->http->post($ordersUrl . '/quote', [
            'json' => ['sku' => $sku, 'quantity' => $quantity],
        ]);
        $this->http->post($paymentUrl . '/authorize', [
            'json' => ['sku' => $sku],
            'headers' => ['X-Api-Key' => $this->config['clients']['payment']['apikey']],
        ]);
        $this->http->get('https://' . $inventoryHost . '/level/' . $sku);

        return ['status' => 'ok'];
    }
}
