<?php

declare(strict_types=1);

/**
 * Laminas Symfony-Messenger bridge expressed as a PHP array. The `async`
 * transport carries a LITERAL amqp DSN (host + vhost recoverable) plus an
 * exchange and a queue; the `sync` transport is a bare string and is skipped.
 */
return [
    'symfony' => [
        'messenger' => [
            'transports' => [
                'async' => [
                    'dsn'     => 'amqp://bus.acme.internal:5672/acme%2Fevents',
                    'options' => [
                        'exchange' => ['name' => 'acme.events'],
                        'queues'   => ['acme.events' => []],
                    ],
                ],
                'sync' => 'sync://',
            ],
        ],
    ],
];
