<?php

namespace App\Consumer;

use PhpAmqpLib\Connection\AMQPStreamConnection;

class NotificationConsumer
{
    private AMQPStreamConnection $rabbitConnection;

    public function __construct(AMQPStreamConnection $rabbitConnection)
    {
        $this->rabbitConnection = $rabbitConnection;
    }

    /**
     * Consumes messages from the orders_exchange RabbitMQ queue.
     * Listens for order.created events published by order-service.
     */
    public function consumeOrderEvents(): void
    {
        $channel = $this->rabbitConnection->channel();
        $channel->queue_declare('order_notifications', false, true, false, false);
        $channel->queue_bind('order_notifications', 'orders_exchange', 'order.created');

        $channel->basic_consume('order_notifications', '', false, true, false, false,
            function ($msg) {
                $data = json_decode($msg->body, true);
                $this->processOrderNotification($data);
            }
        );

        while ($channel->is_open()) {
            $channel->wait();
        }
    }

    /**
     * Consumes reward events from the loyalty_events RabbitMQ exchange.
     * Shared resource with loyalty-service (publisher side).
     */
    public function consumeRewardEvents(): void
    {
        $channel = $this->rabbitConnection->channel();
        $channel->queue_declare('loyalty_notifications', false, true, false, false);
        $channel->queue_bind('loyalty_notifications', 'loyalty_events', 'loyalty.*');

        $channel->basic_consume('loyalty_notifications', '', false, true, false, false,
            function ($msg) {
                $data = json_decode($msg->body, true);
                $this->processRewardNotification($data);
            }
        );

        while ($channel->is_open()) {
            $channel->wait();
        }
    }

    /**
     * Processes an order notification by sending an email via HTTP API.
     */
    private function processOrderNotification(array $data): void
    {
        $customerId = $data['customerId'] ?? 'unknown';

        // Query the shared postgres database for user preferences
        $db = new \PDO(getenv('POSTGRES_DB_DSN'));
        $stmt = $db->prepare('SELECT email, phone_number, notification_preferences FROM users WHERE id = :id');
        $stmt->execute(['id' => $customerId]);
        $user = $stmt->fetch(\PDO::FETCH_ASSOC);

        if (!$user) {
            error_log("User {$customerId} not found for notification");
            return;
        }

        // Metaprogramming/Dynamic mapping test: iterate and build keys dynamically
        $flattenedPayload = [
            'to' => $user['email'],
            'phone' => $user['phone_number'],
            'preferences' => $user['notification_preferences'],
            'template' => 'order_confirmation',
        ];
        
        foreach ($data as $key => $value) {
            if (is_scalar($value)) {
                $dynamicKey = 'ext_' . $key;
                $flattenedPayload[$dynamicKey] = $value;
            }
        }

        $emailServiceUrl = getenv('EMAIL_SERVICE_URL') ?: 'https://api.email.acme.com';
        $ch = curl_init("{$emailServiceUrl}/api/send");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($flattenedPayload),
        ]);
        curl_exec($ch);
        curl_close($ch);
    }

    /**
     * Processes a reward notification (stub).
     */
    private function processRewardNotification(array $data): void
    {
        error_log("Reward event received: " . json_encode($data));
    }
}
// touch
// bust2
