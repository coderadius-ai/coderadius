<?php

namespace App\Service;

use PDO;

/**
 * Fixture: Simulates Bug 2 — Blind spot for DELETE on dynamic table.
 *
 * This class WRITES to dynamically-named tables. Pre-fix, the sanitizer
 * would drop 'booking_slot_{type}' entirely, making backupAndPurgeSlots
 * invisible in the graph (no WRITES edge). Post-fix, the stub node is
 * written to the DB and expanded by DataEntityPostProcessor to
 * 'booking_slot_hotel' and 'booking_slot_flight'.
 *
 * Also provides the concrete inserts that seed the real table names into
 * the graph so the post-processor has something to expand to.
 */
class DynamicTableWriter
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Inserts a new slot into the concrete hotel variant table.
     * This seeds 'booking_slot_hotel' as a real DataContainer node in the graph.
     */
    public function insertHotelSlot(array $slotData): int
    {
        $stmt = $this->db->prepare(
            'INSERT INTO booking_slot_hotel (vendor_id, date, capacity, price, active)
             VALUES (:vendor_id, :date, :capacity, :price, 1)'
        );
        $stmt->execute([
            'vendor_id' => $slotData['vendor_id'],
            'date'      => $slotData['date'],
            'capacity'  => $slotData['capacity'],
            'price'     => $slotData['price'],
        ]);
        return (int) $this->db->lastInsertId();
    }

    /**
     * Inserts a new slot into the concrete flight variant table.
     * This seeds 'booking_slot_flight' as a real DataContainer node in the graph.
     */
    public function insertFlightSlot(array $slotData): int
    {
        $stmt = $this->db->prepare(
            'INSERT INTO booking_slot_flight (carrier_id, departure_date, seats, fare, active)
             VALUES (:carrier_id, :departure_date, :seats, :fare, 1)'
        );
        $stmt->execute([
            'carrier_id'       => $slotData['carrier_id'],
            'departure_date'   => $slotData['departure_date'],
            'seats'            => $slotData['seats'],
            'fare'             => $slotData['fare'],
        ]);
        return (int) $this->db->lastInsertId();
    }

    /**
     * Purges expired slots from a dynamically-named table.
     * Bug 2 regression: this DELETE must appear in the graph as a WRITES edge
     * to 'booking_slot_hotel' and 'booking_slot_flight' after post-processing.
     * Pre-fix: was silently dropped (no edge at all).
     */
    public function backupAndPurgeSlots(string $type, string $cutoffDate): int
    {
        $tableName = 'booking_slot_' . $type;

        // Archive to backup first
        $archive = $this->db->prepare(
            "INSERT INTO booking_slot_archive SELECT *, :cutoff as archived_at FROM {$tableName}
             WHERE date < :cutoff AND active = 0"
        );
        $archive->execute(['cutoff' => $cutoffDate]);

        // Then delete the expired rows
        $delete = $this->db->prepare(
            "DELETE FROM {$tableName} WHERE date < :cutoff AND active = 0"
        );
        $delete->execute(['cutoff' => $cutoffDate]);
        return $delete->rowCount();
    }
}
