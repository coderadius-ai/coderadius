<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification;

final class RabbitNotificationPublisher implements NotificationPublisherInterface
{
    public function publish(array $payload): void
    {
    }
}
