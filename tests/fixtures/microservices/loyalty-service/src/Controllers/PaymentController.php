<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\JsonResponse;
use App\Service\RewardCalculator;

class PaymentController
{
    private RewardCalculator $rewardCalculator;

    public function __construct(RewardCalculator $rewardCalculator)
    {
        $this->rewardCalculator = $rewardCalculator;
    }

    /**
     * POST /charge
     * Handler for the Acme Payment Gateway.
     * This function implements the Create a charge endpoint.
     * It serves as the primary controller for POST /charge defined in openapi.yaml.
     */
    public function createCharge(Request $request): JsonResponse
    {
        $data = json_decode($request->getContent(), true);
        
        if (!isset($data['memberNumber']) || !isset($data['amount'])) {
            return new JsonResponse(['error' => 'Missing memberNumber or amount'], 400);
        }

        try {
            // Internally process the payment
            $result = $this->rewardCalculator->processPayment(
                $data['memberNumber'],
                (float) $data['amount'], 
                $data['currency'] ?? 'EUR'
            );
            
            return new JsonResponse([
                'status' => 'success',
                'chargeId' => $result['id'] ?? uniqid('ch_'),
                'amount' => $data['amount']
            ], 200);
        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], 500);
        }
    }
}
