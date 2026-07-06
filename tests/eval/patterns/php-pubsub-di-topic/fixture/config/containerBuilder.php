<?php

declare(strict_types=1);

use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

return static function (ContainerInterface $container) {
    $containerBuilder = $container->get('builder');

    $containerBuilder->addDefinitions([
        'dwh.publisher' => static function (ContainerInterface $container) {
            return new \Acme\Inventory\Streaming\DwhPublisher(
                new \Google\Cloud\PubSub\PubSubClient([
                    'projectId' => $container->get('config')['google']['projectId'],
                ]),
                'acme-inventory-dwh-streaming',
                $container->get(LoggerInterface::class)
            );
        },
    ]);

    return $containerBuilder;
};
