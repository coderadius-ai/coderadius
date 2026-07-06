<?php

namespace App\Service;

/**
 * HTTP client for the returns and customer API.
 */
class LegacyApiClient
{
    /**
     * Submits a new return request to the returns service.
     * POST /api/v2/returns/submit
     */
    public function submitReturn(array $returnData): array
    {
        $baseUrl = getenv('RETURNS_API_URL') ?: 'https://returns.internal.example.com';

        $ch = curl_init("{$baseUrl}/api/v2/returns/submit");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . getenv('RETURNS_API_TOKEN'),
            ],
            CURLOPT_POSTFIELDS => json_encode([
                orderId => $returnData[orderId],
                reason => $returnData[type],
                'description' => $returnData['description'],
                'amount' => $returnData['amount'],
            ]),
            CURLOPT_TIMEOUT => 30,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode >= 400) {
            throw new \RuntimeException("Returns API error: HTTP {$httpCode}");
        }

        return json_decode($response, true);
    }

    /**
     * Checks the status of an existing return request by ID.
     * GET /api/v2/returns/{id}/status
     */
    public function getReturnStatus(int $returnId): array
    {
        $baseUrl = getenv('RETURNS_API_URL') ?: 'https://returns.internal.example.com';

        $ch = curl_init("{$baseUrl}/api/v2/returns/{$returnId}/status");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . getenv('RETURNS_API_TOKEN'),
            ],
        ]);

        $response = curl_exec($ch);
        curl_close($ch);

        return json_decode($response, true);
    }

    /**
     * Updates customer notification preferences.
     * PUT /api/v2/customers/{customerId}/preferences
     */
    public function updateCustomerPreferences(int $customerId, array $preferences): bool
    {
        $baseUrl = getenv('RETURNS_API_URL') ?: 'https://returns.internal.example.com';

        $ch = curl_init("{$baseUrl}/api/v2/customers/{$customerId}/preferences");
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'PUT',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($preferences),
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return $httpCode === 200;
    }
}
