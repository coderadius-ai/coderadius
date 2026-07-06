<?php

namespace TravelApp\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Doctrine entity for the `trips` table.
 *
 * IMPORTANT: This is the ORM definition for the SAME table that
 * skyfly_common.php and oceanic_common.php query with raw SQL.
 * The coupling is invisible without graph analysis:
 * - This entity uses Doctrine (structured, typed)
 * - The scrapers use raw mysqli queries (unstructured, stringly-typed)
 *
 * CodeRadius must detect BOTH as touching the same `trips` DataContainer.
 */
#[ORM\Entity(repositoryClass: 'TravelApp\Repository\TripRepository')]
#[ORM\Table(name: 'trips')]
#[ORM\Index(columns: ['user_id'], name: 'idx_trips_user')]
#[ORM\Index(columns: ['status', 'departure_date'], name: 'idx_trips_status_departure')]
class Trip
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(type: 'integer')]
    private int $userId;

    #[ORM\Column(type: 'string', length: 50)]
    private string $status = 'PENDING';

    #[ORM\Column(type: 'date')]
    private \DateTimeInterface $departureDate;

    #[ORM\Column(type: 'date', nullable: true)]
    private ?\DateTimeInterface $returnDate = null;

    #[ORM\Column(type: 'string', length: 100)]
    private string $destination;

    #[ORM\Column(type: 'string', length: 10, nullable: true)]
    private ?string $departureAirport = null;

    #[ORM\Column(type: 'string', length: 10, nullable: true)]
    private ?string $arrivalAirport = null;

    #[ORM\Column(type: 'decimal', precision: 10, scale: 2, nullable: true)]
    private ?float $totalPrice = null;

    #[ORM\Column(type: 'string', length: 100, nullable: true)]
    private ?string $externalId = null;

    #[ORM\Column(type: 'json')]
    private array $sessionData = [];

    #[ORM\Column(type: 'datetime')]
    private \DateTimeInterface $createdAt;

    #[ORM\Column(type: 'datetime', nullable: true)]
    private ?\DateTimeInterface $updatedAt = null;

    public function __construct()
    {
        $this->createdAt = new \DateTime();
    }

    public function getId(): ?int { return $this->id; }
    public function getUserId(): int { return $this->userId; }
    public function setUserId(int $userId): self { $this->userId = $userId; return $this; }
    public function getStatus(): string { return $this->status; }
    public function setStatus(string $status): self { $this->status = $status; return $this; }
    public function getDestination(): string { return $this->destination; }
    public function setDestination(string $dest): self { $this->destination = $dest; return $this; }
    public function getDepartureDate(): \DateTimeInterface { return $this->departureDate; }
    public function setDepartureDate(\DateTimeInterface $date): self { $this->departureDate = $date; return $this; }
    public function getReturnDate(): ?\DateTimeInterface { return $this->returnDate; }
    public function setReturnDate(?\DateTimeInterface $date): self { $this->returnDate = $date; return $this; }
    public function getTotalPrice(): ?float { return $this->totalPrice; }
    public function setTotalPrice(?float $price): self { $this->totalPrice = $price; return $this; }
    public function getExternalId(): ?string { return $this->externalId; }
    public function setExternalId(?string $id): self { $this->externalId = $id; return $this; }
    public function getSessionData(): array { return $this->sessionData; }
    public function setSessionData(array $data): self { $this->sessionData = $data; return $this; }
}
