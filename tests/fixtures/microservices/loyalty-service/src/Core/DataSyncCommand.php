<?php

namespace App\Command;

use PDO;
use DateTimeInterface;
use DateTime;

/**
 * Fixture: Simulates Bug 3 — Per-infra READS vs WRITES directionality.
 *
 * syncFromAuditLog does TWO things:
 *   1. READs from the audit_log table (SELECT via PDO)
 *   2. WRITEs to the sync_checkpoints table (INSERT via PDO)
 *   3. Sends data to an external partner API (not a DB write)
 *
 * Pre-fix: because the function was tagged as 'database-writer' globally,
 * the graph-writer set dbOperation = 'WRITES' for ALL infra including
 * audit_log, which is a read-only operation in this function.
 *
 * Post-fix: the LLM emits operation='READS' for audit_log and
 * operation='WRITES' for sync_checkpoints. The graph-writer uses
 * infra.operation per-entry, creating the correct READS/WRITES edges.
 *
 * Expected graph after ingestion:
 *   - DataSyncCommand.syncFromAuditLog -[:READS]->> audit_log
 *   - DataSyncCommand.syncFromAuditLog -[:WRITES]->> sync_checkpoints
 *   - DataSyncCommand.syncFromAuditLog -[:CALLS]->> /api/v1/partner/push (external)
 */
class DataSyncCommand
{
    private PDO $db;
    private string $partnerApiUrl;

    public function __construct(PDO $db, string $partnerApiUrl = '')
    {
        $this->db = $db;
        $this->partnerApiUrl = $partnerApiUrl ?: getenv('PARTNER_API_URL') ?: 'https://partner.internal.example.com';
    }

    /**
     * Fetches pending audit records and forwards them to the partner API,
     * then saves the last-synced timestamp.
     *
     * READ: audit_log (direct SQL SELECT)
     * WRITE: sync_checkpoints (direct SQL INSERT)
     * EXTERNAL: POST /api/v1/partner/push (ExternalAPI, NOT a DB write)
     */
    public function syncFromAuditLog(int $tenantId, DateTimeInterface $since): void
    {
        // READ from audit_log — this is a SELECT, operation=READS
        $stmt = $this->db->prepare(
            'SELECT id, payload, created_at FROM audit_log
             WHERE tenant_id = :tenant_id AND created_at > :since AND synced = 0
             ORDER BY created_at ASC'
        );
        $stmt->execute(['tenant_id' => $tenantId, 'since' => $since->format('Y-m-d H:i:s')]);
        $records = $stmt->fetchAll(\PDO::FETCH_ASSOC);

        if (empty($records)) {
            return;
        }

        // External push — appears as [:CALLS] APIEndpoint, NOT as WRITES to any table
        $ch = curl_init("{$this->partnerApiUrl}/api/v1/partner/push");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode(['records' => $records]),
        ]);
        curl_exec($ch);
        curl_close($ch);

        // WRITE to sync_checkpoints to record the last successful sync — operation=WRITES
        $insertStmt = $this->db->prepare(
            'INSERT INTO sync_checkpoints (tenant_id, last_synced_at, record_count)
             VALUES (:tenant_id, NOW(), :count)
             ON DUPLICATE KEY UPDATE last_synced_at = NOW(), record_count = :count'
        );
        $insertStmt->execute(['tenant_id' => $tenantId, 'count' => count($records)]);
    }

    /**
     * Public entry point — schedules syncFromAuditLog for all active tenants.
     */
    public function execute(): void
    {
        $tenantStmt = $this->db->query('SELECT DISTINCT tenant_id FROM audit_log WHERE synced = 0');
        $tenants = $tenantStmt->fetchAll(\PDO::FETCH_COLUMN);
        $since = new DateTime('-1 hour');

        foreach ($tenants as $tenantId) {
            $this->syncFromAuditLog((int)$tenantId, $since);
        }
    }
}
