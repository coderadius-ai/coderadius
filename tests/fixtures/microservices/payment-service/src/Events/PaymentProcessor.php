<?php

namespace Payment\Events;

/**
 * Publishes payment completion events via DI-injected publisher.
 *
 * The actual routing key is defined in config/services.php:
 *   'payment.completed.publisher' → exchange: payments_exchange, routing_key: payment.completed.v2
 *
 * ⚠️ CodeRadius Challenge: The LLM sees $container->get('payment.completed.publisher')
 * and must NOT use "payment.completed.publisher" as the broker name. The SymbolRegistry
 * should resolve it to "payment.completed.v2".
 */
class PaymentProcessor
{
    private $container;
    private $db;

    public function __construct(\Psr\Container\ContainerInterface $container, \PDO $db)
    {
        $this->container = $container;
        $this->db = $db;
    }

    /**
     * Process a payment and publish a completion event.
     */
    public function processPayment(array $paymentData): array
    {
        // Write to the payments table
        $stmt = $this->db->prepare(
            "INSERT INTO payments (order_id, amount, currency, status, created_at)
             VALUES (:order_id, :amount, :currency, 'completed', NOW())"
        );
        $stmt->execute([
            'order_id' => $paymentData['orderId'],
            'amount' => $paymentData['amount'],
            'currency' => $paymentData['currency'],
        ]);

        $paymentId = $this->db->lastInsertId();

        // Publish completion event via DI container
        $publisher = $this->container->get('payment.completed.publisher');
        $publisher->publish(json_encode([
            'paymentId' => $paymentId,
            'orderId' => $paymentData['orderId'],
            'amount' => $paymentData['amount'],
            'completedAt' => date('c'),
        ]));

        return ['paymentId' => $paymentId, 'status' => 'completed'];
    }

    /**
     * Initiate a refund and publish refund event.
     */
    public function initiateRefund(string $paymentId, float $amount): void
    {
        $stmt = $this->db->prepare(
            "UPDATE payments SET status = 'refunded', refund_amount = :amount WHERE id = :id"
        );
        $stmt->execute(['id' => $paymentId, 'amount' => $amount]);

        // Publish refund event via DI container
        $refundPublisher = $this->container->get('refund.initiated.publisher');
        $refundPublisher->publish(json_encode([
            'paymentId' => $paymentId,
            'refundAmount' => $amount,
            'initiatedAt' => date('c'),
        ]));
    }
}
