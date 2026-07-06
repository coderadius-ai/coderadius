<?php
return [
    'environment' => \getenv('APP_ENV'),
    'clients' => [
        'orders' => [
            'url' => \getenv('ORDERS_URL'),
        ],
        'payment' => [
            'url' => \getenv('PAYMENT_URL'),
            'apikey' => \getenv('PAYMENT_APIKEY'),
        ],
        // INVENTORY_HOST has no scheme — we expect the synthesizer to infer https://.
        'inventory' => [
            'host' => \getenv('INVENTORY_HOST'),
        ],
    ],
];
