<?php

declare(strict_types=1);

namespace TravelApp\Events;

class TripIdentifier {
    public function __construct(public string $id) {}
}

class ProviderId {
    public function __construct(public int $id) {}
}

abstract class BookingResult extends Message {
    public function __construct(
        public TripIdentifier $tripIdentifier,
        public ProviderId $providerId,
        public float $executionTimeSeconds
    ) {}
}

final class SuccessfulBooking extends BookingResult
{
    public function __construct(
        TripIdentifier $tripIdentifier,
        ProviderId $providerId,
        float $executionTimeSeconds,
        public readonly int $bookingId
    ) {
        parent::__construct($tripIdentifier, $providerId, $executionTimeSeconds);
    }
}
