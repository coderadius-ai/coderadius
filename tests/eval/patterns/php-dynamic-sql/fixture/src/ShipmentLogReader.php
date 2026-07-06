<?php

namespace App\Service;

use PDO;

/**
 * Fixture: Reads from CONCRETE shipment_log_* tables — static SQL only.
 *
 * This class provides the literal table name references that seed
 * `shipment_log_express` and `shipment_log_freight` as DataContainer nodes.
 * The DataEntityPostProcessor uses these concrete nodes as targets
 * when rewiring edges from the dynamic stubs in ShipmentLogWriter.
 *
 * TDD purpose:
 *   These concrete table references MUST exist in the graph for the
 *   post-processor's STARTS WITH matching to work.
 */
class ShipmentLogReader
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Reads the latest express shipment log entry.
     * Static SQL: SELECT FROM shipment_log_express
     */
    public function getLatestExpressLog(int $trackingId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM shipment_log_express
             WHERE tracking_id = :tracking_id
             ORDER BY shipped_at DESC LIMIT 1"
        );
        $stmt->execute(['tracking_id' => $trackingId]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);
        return $result ?: null;
    }

    /**
     * Reads the latest freight shipment log entry.
     * Static SQL: SELECT FROM shipment_log_freight
     */
    public function getLatestFreightLog(int $trackingId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM shipment_log_freight
             WHERE tracking_id = :tracking_id
             ORDER BY shipped_at DESC LIMIT 1"
        );
        $stmt->execute(['tracking_id' => $trackingId]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);
        return $result ?: null;
    }

    /**
     * Aggregates logs across both concrete tables.
     * Static SQL: SELECT FROM shipment_log_express UNION SELECT FROM shipment_log_freight
     */
    public function getAllLogs(int $trackingId): array
    {
        $stmt = $this->db->prepare(
            "SELECT *, 'express' as carrier_type FROM shipment_log_express WHERE tracking_id = :tid
             UNION ALL
             SELECT *, 'freight' as carrier_type FROM shipment_log_freight WHERE tracking_id = :tid
             ORDER BY shipped_at DESC"
        );
        $stmt->execute(['tid' => $trackingId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
}
