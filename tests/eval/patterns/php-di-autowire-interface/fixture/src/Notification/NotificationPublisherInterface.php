<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification;

interface NotificationPublisherInterface
{
    public function publish(array $payload): void;
}
