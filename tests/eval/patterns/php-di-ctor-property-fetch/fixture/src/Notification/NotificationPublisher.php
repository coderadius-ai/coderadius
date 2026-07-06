<?php

declare(strict_types=1);

namespace Acme\Inventory\Notification;

use Acme\Inventory\Notification\Transport\AmqpClient;

final class NotificationPublisher
{
    private AmqpClient $client;

    public function __construct()
    {
        $this->client = new AmqpClient();
    }

    public function publish(array $payload): void
    {
        $this->client->basic_publish($payload, 'orders.notifications.exchange', 'orders.notifications');
    }
}
