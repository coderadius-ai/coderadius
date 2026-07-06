<?php

namespace App\Eligibility;

use App\Repository\CartRepository;

/**
 * Checks if a customer's cart qualifies for loyalty tier discounts.
 *
 * This fixture simulates the "ghost table" bug: the code uses a local
 * variable $carrello (Italian for "cart") obtained from a repository,
 * but there is NO SQL query — the repository handles DB access internally.
 * The LLM must NOT hallucinate "carrello" as a table name.
 */
class LoyaltyTierChecker
{
    private CartRepository $cartRepository;
    private $featureFlags;
    private $logger;
    private $db;

    public function __construct(
        CartRepository $cartRepository,
        $featureFlags,
        $logger,
        $db
    ) {
        $this->cartRepository = $cartRepository;
        $this->featureFlags = $featureFlags;
        $this->logger = $logger;
        $this->db = $db;
    }

    /**
     * Determines if the given cart qualifies for loyalty discount.
     */
    public function isEligible(CartIdentifier $cartIdentifier): bool
    {
        $cartId = $cartIdentifier->getId();
        $cartType = $cartIdentifier->getType();

        if (!$this->featureFlags->isActiveFeatureBoolean(self::FEATURE_FLAG_NAME)) {
            $this->logger->debug(
                sprintf('[Loyalty] Cart not eligible: feature flag %s inactive', self::FEATURE_FLAG_NAME),
                ['cartId' => $cartId, 'cartType' => $cartType]
            );
            return false;
        }

        // BUG TRIGGER: $carrello is a local variable obtained from a repository.
        // The LLM sees "$carrello" and may hallucinate "carrello" as a database table.
        // There is NO SQL query here — only repository method calls.
        $carrello = $this->cartRepository->getCart($cartId, $cartType);
        if (!$carrello->isValid()) {
            $this->logger->debug(
                '[Loyalty] Cart not eligible: cart not found or invalid',
                ['cartId' => $cartId, 'cartType' => $cartType]
            );
            return false;
        }

        $userId = $carrello->getUser();
        if (!User::isPremiumMember($userId)) {
            $this->logger->debug(
                '[Loyalty] Cart not eligible: user is not premium',
                ['cartId' => $cartId, 'userId' => $userId]
            );
            return false;
        }

        $enabledTiers = $this->db->getEnabledLoyaltyTiers($userId);
        if (!isset($enabledTiers[GoldTier::slug()])) {
            $this->logger->debug(
                '[Loyalty] Cart not eligible: user not enabled for Gold tier',
                ['cartId' => $cartId, 'userId' => $userId, 'tierSlug' => GoldTier::slug()]
            );
            return false;
        }

        return true;
    }
}
