<?php

namespace App\Service;

/**
 * Delivery tracking result writer — simulates a pattern
 * where PHP code builds table names dynamically from a $type variable.
 *
 * This file tests dynamic table name template pollution:
 * The LLM sees `'delivery_history_' . $type` and cannot resolve $type.
 * Common hallucinations include:
 *   - delivery_history_{type}       (curly-brace template variable)
 *   - delivery_history_$type        (PHP variable in name)
 *   - delivery_history_             (trailing underscore stub)
 *
 * The graph-writer filter should reject ALL of these.
 *
 * The method `getLatestExpressDelivery()` references `delivery_history_express`
 * as a literal string — that IS a real table and should be kept.
 *
 * Expected graph outcome:
 *   - DataContainer `delivery_history_express` → EXISTS (static SQL)
 *   - DataContainer `delivery_history_{type}` → FILTERED (template variable)
 *   - DataContainer `delivery_history_` → FILTERED (trailing underscore)
 */
class DynamicTableLogger
{
    private \PDO $db;

    public function __construct(\PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Writes delivery results to a table determined at runtime.
     * The actual table is one of: delivery_history_express, delivery_history_standard, delivery_history_freight
     * but the LLM cannot know that from the source code alone.
     */
    public function saveDeliveryResult(string $type, int $deliveryId, array $data): void
    {
        $table = 'delivery_history_' . $type;

        $columns = implode(', ', array_keys($data));
        $placeholders = implode(', ', array_fill(0, count($data), '?'));

        $stmt = $this->db->prepare(
            "INSERT INTO {$table} (delivery_id, {$columns}) VALUES (?, {$placeholders})"
        );
        $stmt->execute(array_merge([$deliveryId], array_values($data)));
    }

    /**
     * Reads previous tracking results from a dynamic table.
     * Same pattern: table = 'delivery_history_' . $shippingMethod
     */
    public function getPreviousResults(string $shippingMethod, int $registryId): array
    {
        $table = 'delivery_history_' . $shippingMethod;

        $stmt = $this->db->prepare(
            "SELECT * FROM {$table} WHERE registry_id = ? ORDER BY created_at DESC LIMIT 10"
        );
        $stmt->execute([$registryId]);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    /**
     * Reads from the CONCRETE table delivery_history_express — a static reference.
     * This table name IS visible in the source code and should be extracted.
     */
    public function getLatestExpressDelivery(int $registryId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM delivery_history_express WHERE registry_id = ? ORDER BY created_at DESC LIMIT 1"
        );
        $stmt->execute([$registryId]);
        $result = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $result ?: null;
    }

    /**
     * Deletes old results from all three tracking tables.
     * Table names are hardcoded as strings in an array — the LLM can see them.
     */
    public function purgeOldResults(int $daysOld): int
    {
        $tables = ['delivery_history_express', 'delivery_history_standard', 'delivery_history_freight'];
        $totalDeleted = 0;

        foreach ($tables as $table) {
            $stmt = $this->db->prepare(
                "DELETE FROM {$table} WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)"
            );
            $stmt->execute([$daysOld]);
            $totalDeleted += $stmt->rowCount();
        }

        return $totalDeleted;
    }
}
