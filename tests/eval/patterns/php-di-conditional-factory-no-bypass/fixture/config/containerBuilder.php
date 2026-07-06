<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Psr\Container\ContainerInterface;
use Acme\Inventory\Cache\CacheInterface;
use Acme\Inventory\Cache\RedisCache;
use Acme\Inventory\Cache\NullCache;

return static function (array $config): ContainerBuilder {
    $builder = new ContainerBuilder();

    $builder->addDefinitions([
        CacheInterface::class => static function (ContainerInterface $c) {
            if ($c->get('config')['cache']['enabled']) {
                return new RedisCache();
            }
            return new NullCache();
        },
    ]);

    return $builder;
};
