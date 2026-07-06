<?php

namespace Payment\Consumer;

/**
 * Listens for incoming order events and writes payment records to the database.
 * Reads from a DI-configured consumer queue; writes to the payment_queue table.
 */
class OrderEventsHandler
{
    private $container;
    private \PDO $db;

    public function __construct(\Psr\Container\ContainerInterface $container, \PDO $db)
    {
        $this->container = $container;
        $this->db = $db;
    }

    /**
     * Receive an order event from the DI consumer and persist a pending payment.
     *
     * Reads from: DI consumer key 'order.events.consumer' (message queue)
     * Writes to:  payment_queue table (database INSERT)
     */
    public function handleIncomingOrders(): void
    {
        $consumer = $this->container->get('order.events.consumer');
        $message = $consumer->receive();

        if ($message === null) {
            return;
        }

        $orderId    = $message['orderId'];
        $customerId = $message['customerId'];
        $total      = $message['totalAmount'];

        // Persist the pending payment in the payment_queue table
        $stmt = $this->db->prepare(
            "INSERT INTO payment_queue (order_id, customer_id, amount, status, queued_at)
             VALUES (:order_id, :customer_id, :amount, 'pending', NOW())"
        );
        $stmt->execute([
            'order_id'    => $orderId,
            'customer_id' => $customerId,
            'amount'      => $total,
        ]);

        $consumer->acknowledge($message);
    }

    /**
     * Mark a voucher as not redeemable via the dedicated publisher.
     */
    public function rejectUnredeemableVoucher(string $memberNumber, string $reason): void
    {
        $publisher = $this->container->get('notredeemable.publisher');
        $publisher->publish(json_encode([
            'memberNumber' => $memberNumber,
            'reason'       => $reason,
            'rejectedAt'   => date('c'),
        ]));
    }
}
