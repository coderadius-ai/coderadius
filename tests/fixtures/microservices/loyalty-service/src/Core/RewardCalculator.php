<?php

namespace App\Service;

use PDO;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

class RewardCalculator
{
    private PDO $db;
    private AMQPStreamConnection $rabbitConnection;

    public function __construct(PDO $db, AMQPStreamConnection $rabbitConnection)
    {
        $this->db = $db;
        $this->rabbitConnection = $rabbitConnection;
    }

    /**
     * Calculates the loyalty discount by querying MySQL for reward factors
     * and applying the pricing model.
     */
    public function calculateDiscount(string $orderType, array $cartData, array $customerData): float
    {
        // Query MySQL for base reward factors
        $stmt = $this->db->prepare(
            'SELECT base_rate, risk_multiplier FROM risk_factors WHERE order_type = :type AND region = :region'
        );
        $stmt->execute([
            'type' => $orderType,
            'region' => $customerData['region'] ?? 'IT-DEFAULT',
        ]);
        $riskFactors = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$riskFactors) {
            throw new \RuntimeException("No reward factors found for order type: {$orderType}");
        }

        $baseRate = (float) $riskFactors['base_rate'];
        $riskMultiplier = (float) $riskFactors['risk_multiplier'];

        // Calculate discount based on cart and customer data
        $cartAge = date('Y') - ($cartData['year'] ?? date('Y'));
        $customerAge = $customerData['age'] ?? 30;
        $discount = $baseRate * $riskMultiplier * (1 + $cartAge * 0.02) * (1 + max(0, 25 - $customerAge) * 0.05);

        return round($discount, 2);
    }

    /**
     * Processes payment via HTTP POST to external payment gateway.
     */
    public function processPayment(string $memberNumber, float $amount, string $currency = 'EUR'): array
    {
        $gatewayUrl = getenv('PAYMENT_GATEWAY_URL') ?: 'https://gateway.payments.example.com';

        $ch = curl_init("{$gatewayUrl}/api/v1/charge");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode([
                'memberNumber' => $memberNumber,
                'amount' => $amount,
                'currency' => $currency,
                'merchantId' => getenv('MERCHANT_ID'),
            ]),
            CURLOPT_TIMEOUT => 30,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200) {
            throw new \RuntimeException("Payment gateway error: HTTP {$httpCode}");
        }

        return json_decode($response, true);
    }

    /**
     * Publishes a reward event to RabbitMQ loyalty_events exchange.
     */
    public function publishRewardEvent(string $eventType, array $eventData): void
    {
        $channel = $this->rabbitConnection->channel();
        $channel->exchange_declare('loyalty_events', 'topic', false, true, false);

        $message = new AMQPMessage(
            json_encode([
                'type' => $eventType,
                'data' => $eventData,
                'timestamp' => (new \DateTime())->format(\DateTime::ISO8601),
            ]),
            ['content_type' => 'application/json', 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT]
        );

        $channel->basic_publish($message, 'loyalty_events', "loyalty.{$eventType}");
        $channel->close();
    }

    /**
     * Internal helper to format currency — no external I/O, should be filtered out.
     */
    private function formatCurrency(float $amount, string $currency): string
    {
        return number_format($amount, 2, '.', ',') . " {$currency}";
    }

    /**
     * Saves a reward audit to the database using JSON mutation.
     * Tests LLM schema extraction of dynamic JSON fields.
     */
    public function saveRewardAudit(string $orderType, array $auditData): void
    {
        // The audit_log column is a JSON type where keys depend on runtime variable $orderType
        $stmt = $this->db->prepare(
            "UPDATE loyalty_audits SET audit_log = JSON_SET(COALESCE(audit_log, '{}'), CONCAT('$.', :dynamicType), :data) WHERE id = :id"
        );
        $stmt->execute([
            'dynamicType' => $orderType,
            'data' => json_encode($auditData),
            'id' => $auditData['id'] ?? 0,
        ]);
    }

    /**
     * Useless pure function to test LLM pruning:
     * Calculates a dummy hash from reward features.
     */
    public function calculateDummyHash(array $features): string
    {
        $hash = 0;
        foreach ($features as $feature) {
            $hash += crc32((string) $feature);
        }
        return (string) $hash;
    }

    /**
     * Checks if the risk multiplier is within bounds, purely in-memory.
     */
    private function isMultiplierValid(float $multiplier): bool
    {
        return $multiplier >= 0.5 && $multiplier <= 3.0;
    }

    /**
     * Returns a static string for the reward engine.
     */
    public function getEngineVersion(): string
    {
        return "1.0.42-mock";
    }
}

// trigger re-ingest

// force change
