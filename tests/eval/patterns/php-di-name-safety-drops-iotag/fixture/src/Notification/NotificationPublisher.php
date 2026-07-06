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

    /**
     * The literal routing key passed to basic_publish is in NOISY_BROKER_NAMES.
     * The static-bypass validation (isNoisyBrokerName) must drop the ioTag
     * before it reaches the graph; the consumer falls back to LLM.
     */
    public function publish(array $payload): void
    {
        $this->client->basic_publish($payload, 'configuration', 'configuration');
    }
}
