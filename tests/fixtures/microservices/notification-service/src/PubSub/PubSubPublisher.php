<?php

namespace App\PubSub;

use Google\Cloud\PubSub\PubSubClient;

class PubSubPublisher
{
    private PubSubClient $pubsub;

    public function __construct()
    {
        $this->pubsub = new PubSubClient([
            'projectId' => getenv('GCP_PROJECT_ID')
        ]);
    }

    /**
     * Publishes a notification event to the Google Pub/Sub topic 'notification-events'.
     */
    public function publishNotificationEvent(string $eventType, array $payload): void
    {
        $topic = $this->pubsub->topic('notification-events');
        $topic->publish([
            'data' => json_encode([
                'type' => $eventType,
                'payload' => $payload,
                'timestamp' => date('c'),
            ]),
            'attributes' => [
                'eventType' => $eventType,
            ],
        ]);
    }

    /**
     * Subscribes to the 'order-updates' Pub/Sub subscription and processes messages.
     */
    public function listenForOrderUpdates(): void
    {
        $subscription = $this->pubsub->subscription('order-updates-sub');
        $messages = $subscription->pull(['maxMessages' => 10]);

        foreach ($messages as $message) {
            $data = json_decode($message->data(), true);
            $this->handleOrderUpdate($data);
            $subscription->acknowledge($message);
        }
    }

    /**
     * Handles an order update received from Pub/Sub.
     */
    private function handleOrderUpdate(array $data): void
    {
        error_log("Order update via PubSub: " . json_encode($data));
    }
}
// bust
