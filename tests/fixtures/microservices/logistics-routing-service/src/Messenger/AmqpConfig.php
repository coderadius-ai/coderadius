<?php

declare(strict_types=1);

namespace Fulfillment\Messenger;

use Fulfillment\Messenger\Message\ShipmentSavedMessage;
use Fulfillment\Messenger\Message\ShipmentUpdatedMessage;
use Fulfillment\Messenger\Message\SaveRequestedMessage;
use Fulfillment\Messenger\Message\PartnerShipmentMessage;
use Fulfillment\Messenger\Message\NotificationSendMessage;

/**
 * Defines the mapping between message classes and their physical AMQP transports.
 *
 * This is the canonical source of truth for Symfony Messenger routing.
 * The AmqpRoutingMiddleware reads thgsis map at dispatch time to stamp the
 * correct routing_key onto each AMQP envelope.
 *
 * NOTE: queue_name values include an optional $envSuffix ('-canary', '-mock', '')
 * which is empty on production. The ConfigSymbolExtractor should extract
 * the base routing key with a {ENV} template placeholder for the dynamic suffix.
 *
 * @see AmqpRoutingMiddleware
 */
class AmqpConfig
{
    private string $environment;

    public function __construct(string $environment)
    {
        $this->environment = $environment;
    }

    /**
     * @return array<class-string, array{queue_name?: string, routing_key: string, handle: bool}>
     */
    public function getMessageMap(): array
    {
        $envSuffix = $this->getEnvSuffix();

        return [
            // Inbound messages: consumed by this service
            SaveRequestedMessage::class => [
                'queue_name' => 'fulfillment.shipment' . $envSuffix . '.save.requested',
                'routing_key' => 'fulfillment.shipment' . $envSuffix . '.save.requested',
                'handle' => true,
            ],
            PartnerShipmentMessage::class => [
                'queue_name' => 'fulfillment.shipment' . $envSuffix . '.partner.requested',
                'routing_key' => 'fulfillment.shipment' . $envSuffix . '.partner.requested',
                'handle' => true,
            ],
            NotificationSendMessage::class => [
                'queue_name' => 'fulfillment.shipment' . $envSuffix . '.notification.send',
                'routing_key' => 'fulfillment.shipment' . $envSuffix . '.notification.send',
                'handle' => true,
            ],

            // Outbound messages: published by this service, NOT consumed here
            ShipmentSavedMessage::class => [
                'routing_key' => 'logistics.fulfillment' . $envSuffix . '.shipment.saved',
                'handle' => false,
            ],
            ShipmentUpdatedMessage::class => [
                'routing_key' => 'logistics.fulfillment' . $envSuffix . '.shipment.updated',
                'handle' => false,
            ],
        ];
    }

    public function getEnvSuffix(): string
    {
        switch ($this->environment) {
            case 'canary':
            case 'mock':
                return '-' . $this->environment;
            default:
                return '';
        }
    }
}