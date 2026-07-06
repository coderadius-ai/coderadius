<?php
namespace Acme\Inventory;

use Symfony\Component\Messenger\MessageBusInterface;

/**
 * Customer-style message routing config:
 *   - Method name is NOT `getMessageMap` (extractor must not depend on it)
 *   - Some entries use `queue_name`, some use `routing_key`, some use both
 *     (extractor must not depend on inner key name)
 *   - One routing key uses an `$envSuffix` placeholder (sanitizer must
 *     stem-normalize)
 */
class AmqpConfig
{
    public function buildRoutingTable(): array
    {
        $envSuffix = $this->getEnvSuffix();
        return [
            QuoteMessage::class => [
                'queue_name'  => 'acme.inventory.quote.requested',
                'handle'      => true,
            ],
            ProductQuoteMessage::class => [
                'routing_key' => 'acme.inventory' . $envSuffix . '.quote.product.requested',
            ],
            // Negative: entry whose value is a handler class reference, not a topic
            NotificationDispatcher::class => [
                'handler' => NotificationHandler::class,
            ],
        ];
    }

    private function getEnvSuffix(): string
    {
        return '-prod';
    }
}
