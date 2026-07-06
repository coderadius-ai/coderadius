<?php

declare(strict_types=1);

use DI\ContainerBuilder;

return static function (array $config): ContainerBuilder {
    $builder = new ContainerBuilder();
    $builder->useAutowiring(true);
    // Intentionally NO addDefinitions entry for NotificationPublisherInterface.
    // The container is expected to fail at runtime; static analysis must
    // mirror that uncertainty and fall back to the LLM path.
    return $builder;
};
