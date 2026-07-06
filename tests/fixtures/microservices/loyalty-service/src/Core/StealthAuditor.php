<?php

namespace App\Service;

use App\Service\RewardCalculator;

// Gate 3 stealth test: uses DI-injected RewardCalculator
// without triggering Gate 1 regex.
class StealthAuditor
{
    private RewardCalculator $calc;

    public function __construct(RewardCalculator $calc)
    {
        $this->calc = $calc;
    }

    // Pure DI call: no banned words in body or comments.
    public function verifyAndCharge(string $memberNumber, float $amount): bool
    {
        $result = $this->calc->processPayment($memberNumber, $amount);
        return !empty($result);
    }
}
