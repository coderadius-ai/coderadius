<?php

declare(strict_types=1);

namespace Fulfillment\Messenger;

use Fulfillment\Messenger\Message\ShipmentSavedMessage;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\MessageBusInterface;
use Throwable;

/**
 * Domain publisher for ShipmentSavedMessage.
 *
 * This is NOT a generic wrapper — it has a single, specific responsibility:
 * dispatching ShipmentSavedMessage events when an logistics shipment has been saved.
 *
 * The physical AMQP routing key for ShipmentSavedMessage is defined in
 * AmqpConfig::getMessageMap() → 'logistics.fulfillment.shipment.saved'.
 * It is resolved at dispatch time by AmqpRoutingMiddleware.
 */
class ShipmentSavedMessagePublisher
{
    private MessageBusInterface $messageBus;
    private LoggerInterface $logger;

    public function __construct(MessageBusInterface $messageBus, LoggerInterface $logger)
    {
        $this->messageBus = $messageBus;
        $this->logger = $logger;
    }

    public function publish(int $shipmentId, string $partnerCode): void
    {
        try {
            $this->messageBus->dispatch(new ShipmentSavedMessage($shipmentId, $partnerCode));
        } catch (Throwable $e) {
            $this->logger->error(
                '[ShipmentSavedMessagePublisher] Failed to dispatch ShipmentSavedMessage - ' . $e->getMessage(),
                ['shipmentId' => $shipmentId, 'partnerCode' => $partnerCode]
            );
        }
    }
}
