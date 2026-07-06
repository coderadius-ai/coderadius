<?php

declare(strict_types=1);

namespace Acme\Inventory\Streaming;

use Google\Cloud\PubSub\PubSubClient;

/**
 * Thin wrapper over the Google Cloud Pub/Sub PHP SDK. The topic and
 * subscription NAMES are inline string literals on the standard client
 * accessors (`->topic('...')`, `->subscription('...')`). The handle is
 * stored in a local var before the publish()/pull() I/O — the canonical
 * SDK usage.
 */
final class StreamingPublisher
{
    private PubSubClient $pubSub;

    public function __construct()
    {
        $this->pubSub = new PubSubClient([
            'projectId' => getenv('GCP_PROJECT_ID'),
        ]);
    }

    public function publishStreamingEvent(array $payload): void
    {
        $topic = $this->pubSub->topic('acme-inventory-streaming');
        $topic->publish([
            'data' => json_encode($payload),
        ]);
    }

    public function readOrderUpdates(): void
    {
        $subscription = $this->pubSub->subscription('acme-inventory-updates-sub');
        $messages = $subscription->pull(['maxMessages' => 10]);

        foreach ($messages as $message) {
            $subscription->acknowledge($message);
        }
    }
}
