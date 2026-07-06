<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Loyalty rewards earned by customers.
 *
 * @ORM\Table(name="loyalty_rewards", indexes={
 *     @ORM\Index(name="idx_status", columns={"status"}),
 *     @ORM\Index(name="idx_customer", columns={"customer_id"})
 * })
 * @ORM\Entity(repositoryClass="App\Repository\LoyaltyRewardRepository")
 * @ORM\HasLifecycleCallbacks()
 */
class LoyaltyReward
{
    const STATUS_PENDING = 'pending';
    const STATUS_APPROVED = 'approved';
    const STATUS_REJECTED = 'rejected';

    /**
     * @ORM\Id
     * @ORM\Column(name="id", type="bigint", nullable=false)
     * @ORM\GeneratedValue(strategy="AUTO")
     */
    protected $id;

    /**
     * @ORM\Column(name="customer_id", type="integer", nullable=false)
     */
    protected $customerId;

    /**
     * @ORM\Column(name="member_number", type="string", length=50, nullable=false)
     */
    protected $memberNumber;

    /**
     * @ORM\Column(name="reward_amount", type="decimal", precision=10, scale=2, nullable=false)
     */
    protected $rewardAmount;

    /**
     * @ORM\Column(name="status", type="string", length=20, nullable=false)
     */
    protected $status = self::STATUS_PENDING;

    /**
     * @ORM\Column(name="description", type="text", nullable=true)
     */
    protected $description;

    /**
     * @ORM\Column(name="created_at", type="datetime")
     */
    protected $createdAt;

    /**
     * @ORM\Column(name="updated_at", type="datetime")
     */
    protected $updatedAt;

    public function __construct()
    {
        $this->createdAt = new \DateTime('now');
        $this->updatedAt = new \DateTime('now');
    }

    public function getId()
    {
        return $this->id;
    }

    public function getCustomerId()
    {
        return $this->customerId;
    }

    public function setCustomerId($customerId)
    {
        $this->customerId = $customerId;
    }

    public function getMemberNumber()
    {
        return $this->memberNumber;
    }

    public function setMemberNumber($memberNumber)
    {
        $this->memberNumber = $memberNumber;
    }

    public function getRewardAmount()
    {
        return $this->rewardAmount;
    }

    public function setRewardAmount($rewardAmount)
    {
        $this->rewardAmount = $rewardAmount;
    }

    public function getStatus()
    {
        return $this->status;
    }

    public function setStatus($status)
    {
        $this->status = $status;
    }

    public function getDescription()
    {
        return $this->description;
    }

    public function setDescription($description)
    {
        $this->description = $description;
    }

    public function isApproved()
    {
        return $this->status === self::STATUS_APPROVED;
    }

    /**
     * @ORM\PrePersist
     * @ORM\PreUpdate
     */
    public function onPrePersist()
    {
        $this->updatedAt = new \DateTime('now');
    }
}
