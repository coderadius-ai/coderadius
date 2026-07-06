<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Psr\Container\ContainerInterface;
use Acme\Inventory\Notification\NotificationPublisher;

return static function (array $config): ContainerBuilder {
    $builder = new ContainerBuilder();

    $builder->addDefinitions([
        NotificationPublisher::class => static function (ContainerInterface $c): NotificationPublisher {
            return new NotificationPublisher();
        },
    ]);

    return $builder;
};
