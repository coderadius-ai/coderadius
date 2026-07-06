<?php

declare(strict_types=1);

namespace Logistics\Messenger\Message;

/**
 * Message dispatched when an logistics quotation has been saved successfully.
 * Routes to the physical queue via Symfony Messenger transport configuration.
 */
final class ShipmentSavedMessage
{
    public function __construct(
        private readonly int $shipmentId,
        private readonly string $partnerCode,
    ) {}

    public function getShipmentId(): int
    {
        return $this->shipmentId;
    }

    public function getPartnerCode(): string
    {
        return $this->partnerCode;
    }
}
