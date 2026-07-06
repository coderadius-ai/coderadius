<?php

declare(strict_types=1);

namespace Acme\Inventory\Streaming;

use Google\Cloud\PubSub\PubSubClient;
use Psr\Log\LoggerInterface;

/**
 * Pub/Sub wrapper whose topic NAME is NOT in this file: it is injected
 * positionally via the DI container (see config/containerBuilder.php) and
 * stored on $this->topic with a classic ctor-body assignment. publish() uses
 * the standard Google client accessor `->topic($this->topic)->publish(...)`.
 */
final class DwhPublisher
{
    private PubSubClient $pubSubClient;

    private string $topic;

    private LoggerInterface $logger;

    public function __construct(PubSubClient $pubSubClient, string $topic, LoggerInterface $logger)
    {
        $this->pubSubClient = $pubSubClient;
        $this->topic = $topic;
        $this->logger = $logger;
    }

    public function publish(array $payload): void
    {
        $topic = $this->pubSubClient->topic($this->topic);
        $topic->publish(['data' => json_encode($payload)]);
    }
}
