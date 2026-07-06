<?php

declare(strict_types=1);

use Acme\Platform\EnvVault;

/**
 * oldsound/laminas RabbitMqModule config. Three connections on distinct vhosts
 * plus producer/consumer sections each pinned to a named connection via the
 * 'connection' key. Hosts/ports are accessor-wrapped; vhosts are literals so
 * the per-vhost identity of every channel is deterministic.
 */
return [
    'rabbitmq' => [
        'connection' => [
            'default' => [
                'host'  => EnvVault::fetch('BUS_HOST', 'rabbitmq'),
                'port'  => EnvVault::fetch('BUS_PORT', 5672),
                'vhost' => 'acme',
            ],
            'notifications' => [
                'host'  => EnvVault::fetch('BUS_HOST', 'rabbitmq'),
                'vhost' => 'acme/notifications',
            ],
            'payments' => [
                'host'  => EnvVault::fetch('PAYMENTS_BUS_HOST', 'rabbitmq'),
                'vhost' => '/',
            ],
        ],
        'producer' => [
            'order_events' => [
                'connection' => 'default',
                'exchange' => ['name' => 'acme.order-events', 'type' => 'fanout'],
                'queue'    => ['name' => 'acme.order-events'],
            ],
            'notify_out' => [
                'connection' => 'notifications',
                'exchange' => ['name' => 'acme.notifications', 'type' => 'topic'],
            ],
        ],
        'consumer' => [
            'shipment_import' => [
                'connection' => 'default',
                'exchange' => ['name' => 'acme.shipment-import', 'type' => 'direct'],
                'queue'    => ['name' => 'acme.shipment-import'],
            ],
        ],
    ],
];
