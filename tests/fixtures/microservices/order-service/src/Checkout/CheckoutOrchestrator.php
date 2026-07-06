<?php

namespace App\Checkout;

use App\Messaging\CartFinalizedMessage;
use App\Messaging\ProductReservedMessage;
use App\Messaging\OrderConfirmationMessage;

/**
 * Orchestrates the checkout flow: reads from real SQL tables and publishes
 * messages to RabbitMQ queues.
 *
 * This fixture simulates Bug 5 — "Class-name broker hallucination":
 * the LLM sees PHP Message class names (CartFinalizedMessage, etc.)
 * and may hallucinate them as broker topic names, when the real topic
 * names are the string literals passed to ->publish().
 */
class CheckoutOrchestrator
{
    private $db;
    private $messageBus;
    private $logger;

    public function __construct($db, $messageBus, $logger)
    {
        $this->db = $db;
        $this->messageBus = $messageBus;
        $this->logger = $logger;
    }

    /**
     * Processes a checkout: reads order data from real tables,
     * publishes messages to actual routing keys.
     */
    public function processCheckout(int $orderId, array $items): void
    {
        // REAL SQL query — "ordini" IS a real table name (Italian for "orders")
        $stmt = $this->db->prepare(
            "SELECT o.*, c.email FROM ordini o
             JOIN clienti c ON c.id = o.cliente_id
             WHERE o.id = :orderId"
        );
        $stmt->execute(['orderId' => $orderId]);
        $order = $stmt->fetch();

        if (!$order) {
            throw new \RuntimeException("Order $orderId not found");
        }

        // Update stock levels — "magazzino" IS a real table (Italian for "warehouse")
        foreach ($items as $item) {
            $this->db->prepare(
                "UPDATE magazzino SET quantita = quantita - :qty WHERE prodotto_id = :pid"
            )->execute(['qty' => $item['quantity'], 'pid' => $item['product_id']]);
        }

        // BUG 5 TRIGGER: The LLM sees CartFinalizedMessage and ProductReservedMessage
        // as class names in the `use` imports and may hallucinate them as broker topics.
        // The REAL topic names are 'checkout.finalized' and 'stock.reserved' (string literals).
        $msg = new CartFinalizedMessage($orderId, $order['email'], $items);
        $this->messageBus->publish('checkout.finalized', $msg);

        $reservationMsg = new ProductReservedMessage($orderId, $items);
        $this->messageBus->publish('stock.reserved', $reservationMsg);

        $this->logger->info("Checkout completed for order $orderId");
    }
}
