<?php

namespace TravelApp\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Doctrine entity for the `bookings` table.
 * Created when a trip is successfully booked with a provider.
 */
#[ORM\Entity]
#[ORM\Table(name: 'bookings')]
class Booking
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(type: 'integer')]
    private int $tripId;

    #[ORM\Column(type: 'integer')]
    private int $providerId;

    #[ORM\Column(type: 'string', length: 100)]
    private string $externalBookingId;

    #[ORM\Column(type: 'string', length: 30)]
    private string $status = 'CONFIRMED';

    #[ORM\Column(type: 'decimal', precision: 10, scale: 2)]
    private float $pricePaid;

    #[ORM\Column(type: 'string', length: 3)]
    private string $currency = 'EUR';

    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $providerResponse = null;

    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $errorMessage = null;

    #[ORM\Column(type: 'datetime')]
    private \DateTimeInterface $bookedAt;

    public function __construct()
    {
        $this->bookedAt = new \DateTime();
    }

    public function getId(): ?int { return $this->id; }
    public function getTripId(): int { return $this->tripId; }
    public function setTripId(int $tripId): self { $this->tripId = $tripId; return $this; }
    public function getProviderId(): int { return $this->providerId; }
    public function setProviderId(int $id): self { $this->providerId = $id; return $this; }
    public function getExternalBookingId(): string { return $this->externalBookingId; }
    public function setExternalBookingId(string $id): self { $this->externalBookingId = $id; return $this; }
    public function getStatus(): string { return $this->status; }
    public function setStatus(string $status): self { $this->status = $status; return $this; }
    public function getPricePaid(): float { return $this->pricePaid; }
    public function setPricePaid(float $price): self { $this->pricePaid = $price; return $this; }
    public function getProviderResponse(): ?array { return $this->providerResponse; }
    public function setProviderResponse(?array $resp): self { $this->providerResponse = $resp; return $this; }
}