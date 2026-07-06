<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Table(name: "loyalty_rewards")]
#[ORM\Entity(repositoryClass: LoyaltyRewardRepository::class)]
#[ORM\HasLifecycleCallbacks]
class LoyaltyRewardModern
{
    #[ORM\Id]
    #[ORM\Column(name: "id", type: "bigint")]
    #[ORM\GeneratedValue(strategy: "AUTO")]
    protected int $id;

    #[ORM\Column(name: "customer_id", type: "integer")]
    protected int $customerId;

    #[ORM\Column(name: "member_number", type: "string", length: 50)]
    protected string $memberNumber;

    #[ORM\Column(name: "reward_amount", type: "decimal", precision: 10, scale: 2)]
    protected float $rewardAmount;

    #[ORM\Column(name: "status", type: "string", length: 20)]
    protected string $status = 'pending';

    #[ORM\Column(name: "notes", type: "json", nullable: true)]
    protected ?array $notes = null;

    public function getId(): int
    {
        return $this->id;
    }

    public function getCustomerId(): int
    {
        return $this->customerId;
    }

    public function setCustomerId(int $customerId): void
    {
        $this->customerId = $customerId;
    }

    public function getMemberNumber(): string
    {
        return $this->memberNumber;
    }

    public function setMemberNumber(string $memberNumber): void
    {
        $this->memberNumber = $memberNumber;
    }

    public function getRewardAmount(): float
    {
        return $this->rewardAmount;
    }

    public function setRewardAmount(float $rewardAmount): void
    {
        $this->rewardAmount = $rewardAmount;
    }

    public function getStatus(): string
    {
        return $this->status;
    }

    public function setStatus(string $status): void
    {
        $this->status = $status;
    }

    public function isApproved(): bool
    {
        return $this->status === 'approved';
    }

    #[ORM\PrePersist]
    public function onPrePersist(): void
    {
        $this->updatedAt = new \DateTime('now');
    }
}
