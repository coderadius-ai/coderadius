<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Psr\Container\ContainerInterface;
use Acme\Inventory\Streaming\StreamingPublisher;

return static function (array $config): ContainerBuilder {
    $builder = new ContainerBuilder();

    $builder->addDefinitions([
        StreamingPublisher::class => static function (ContainerInterface $c): StreamingPublisher {
            return new StreamingPublisher();
        },
    ]);

    return $builder;
};
