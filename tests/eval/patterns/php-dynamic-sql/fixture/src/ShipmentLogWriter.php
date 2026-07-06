<?php

namespace App\Service;

use PDO;

/**
 * Fixture: Simulates dynamic SQL table concatenation — DYNAMIC SQL only.
 *
 * This class builds table names at runtime via string concatenation:
 *   $table = 'shipment_log_' . $carrierType;  // → shipment_log_express, shipment_log_freight
 *
 * There are NO static/literal table references in this file.
 * The LLM will emit the placeholder form: shipment_log_{carrierType} (or similar).
 *
 * TDD purpose:
 *   The DataEntityPostProcessor must rewire WRITES edges from this function
 *   to the concrete tables `shipment_log_express` and `shipment_log_freight`
 *   (seeded by ShipmentLogReader.php).
 *
 *   Pipeline flow: the sanitizer preserves the stub (isDynamicTableStub),
 *   graph-writer writes it, then the post-processor expands it and
 *   persistTracking() gets WRITES edges to both concrete tables.
 */
class ShipmentLogWriter
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Persists shipment tracking data into a table determined at runtime.
     * The actual table is one of: shipment_log_express, shipment_log_freight
     * but the codebase resolves this only at runtime.
     *
     * Target: WRITES to shipment_log_{carrierType}
     */
    public function persistTracking(string $carrierType, int $trackingId, array $trackingData): void
    {
        $table = 'shipment_log_' . $carrierType;

        $stmt = $this->db->prepare(
            "INSERT INTO {$table} (tracking_id, origin, destination, weight_kg, shipped_at)
             VALUES (:tracking_id, :origin, :destination, :weight_kg, NOW())"
        );
        $stmt->execute([
            'tracking_id'  => $trackingId,
            'origin'       => $trackingData['origin'],
            'destination'  => $trackingData['destination'],
            'weight_kg'    => $trackingData['weight_kg'],
        ]);
    }

    /**
     * Archives old shipment logs from a dynamically-named table into history.
     * Same pattern: table = 'shipment_log_' . $carrierType
     *
     * Target: READS from shipment_log_{carrierType}, WRITES to shipment_log_archive
     */
    public function archiveOldLogs(string $carrierType, string $cutoffDate): int
    {
        $table = 'shipment_log_' . $carrierType;

        // Copy to archive
        $this->db->prepare(
            "INSERT INTO shipment_log_archive
             SELECT *, :cutoff as archived_at FROM {$table}
             WHERE shipped_at < :cutoff"
        )->execute(['cutoff' => $cutoffDate]);

        // Purge originals
        $stmt = $this->db->prepare(
            "DELETE FROM {$table} WHERE shipped_at < :cutoff"
        );
        $stmt->execute(['cutoff' => $cutoffDate]);
        return $stmt->rowCount();
    }
}
