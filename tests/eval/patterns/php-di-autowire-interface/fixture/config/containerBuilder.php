<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\AmqpNotificationPublisher;

return static function (array $config): ContainerBuilder {
    $builder = new ContainerBuilder();
    $builder->useAutowiring(true);

    $builder->addDefinitions([
        AmqpNotificationPublisher::class => static function (ContainerInterface $c): AmqpNotificationPublisher {
            return new AmqpNotificationPublisher();
        },
    ]);

    return $builder;
};
