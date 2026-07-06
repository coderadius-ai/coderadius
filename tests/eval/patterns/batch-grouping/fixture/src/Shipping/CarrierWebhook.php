<?php

declare(strict_types=1);

namespace Acme\Shipping;

use GuzzleHttp\Client;

/** Singleton-class fixture: one I/O method, merged into a MIXED batch (R2). */
final class CarrierWebhook
{
    public function __construct(private readonly Client $httpClient)
    {
    }

    public function notifyCarrier(string $trackingCode): void
    {
        $this->httpClient->post('/api/v2/shipments/notifications', [
            'json' => ['trackingCode' => $trackingCode],
        ]);
    }
}
