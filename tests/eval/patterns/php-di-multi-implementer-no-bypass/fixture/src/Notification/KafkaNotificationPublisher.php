<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification;

final class KafkaNotificationPublisher implements NotificationPublisherInterface
{
    public function publish(array $payload): void
    {
    }
}
