<?php

namespace App\Service;

use PDO;

/**
 * Fixture: Simulates Bug 1 — Ghost table from bare prefix truncation.
 *
 * The LLM (pre-fix) would truncate 'booking_slot_' . $type to 'booking_slot',
 * creating a phantom DataContainer node. Post-fix, the LLM must emit
 * 'booking_slot_{type}' (template form), which the sanitizer passes through
 * as a stub and the DataEntityPostProcessor expands to concrete variants.
 *
 * Concrete variants that must exist in the graph:
 *   - booking_slot_hotel  (written by DynamicTableWriter below)
 *   - booking_slot_flight (written by DynamicTableWriter below)
 */
class DynamicTableReader
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Reads from a dynamically-named table by concatenating a prefix with a type.
     * Bug 1 regression: must NOT create a phantom 'booking_slot' DataContainer node.
     * Must instead create edges to 'booking_slot_hotel' and 'booking_slot_flight'.
     */
    public function getSlotById(int $id, string $type): array
    {
        $tableName = 'booking_slot_' . $type;
        $stmt = $this->db->prepare(
            "SELECT s.*, v.code FROM {$tableName} AS s
             JOIN slot_variants AS v ON s.variant_id = v.id
             WHERE s.id = :id AND s.active = 1"
        );
        $stmt->execute(['id' => $id]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    /**
     * Counts active slots across a type — also uses dynamic table name.
     */
    public function countActiveSlots(string $type): int
    {
        $tableName = 'booking_slot_' . $type;
        $stmt = $this->db->query("SELECT COUNT(*) FROM {$tableName} WHERE active = 1");
        return (int) $stmt->fetchColumn();
    }
}
