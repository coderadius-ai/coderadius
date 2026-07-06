<?php

namespace TravelApp\Message;

/**
 * Symfony Messenger message dispatched when a booking is confirmed.
 *
 * This message is handled asynchronously via the message bus.
 * The handler (BookingConfirmedHandler) will:
 *   1. Update the trip status in DB
 *   2. Dispatch a follow-up notification message
 *   3. Call an external webhook
 * 
 *
 * The LLM should detect this as an async message schema, similar to
 * how it detects RabbitMQ/PubSub messages.
 */
final class BookingConfirmedMessage
{
    public function __construct(
        private readonly int $tripId,
        private readonly int $bookingId,
        private readonly int $providerId,
        private readonly float $pricePaid,
        private readonly string $currency = 'EUR',
        private readonly ?string $customerEmail = null,
    ) {}

    public function getTripId(): int { return $this->tripId; }
    public function getBookingId(): int { return $this->bookingId; }
    public function getProviderId(): int { return $this->providerId; }
    public function getPricePaid(): float { return $this->pricePaid; }
    public function getCurrency(): string { return $this->currency; }
    public function getCustomerEmail(): ?string { return $this->customerEmail; }
}
