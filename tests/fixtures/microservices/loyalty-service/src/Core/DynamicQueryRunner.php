<?php

namespace App\Service;

/**
 * Dynamic query runner that wraps fully dynamic SQL execution.
 *
 * This file tests Bug 2 (polluted DataContainer names):
 * The table names are NEVER visible in the source code — they come from
 * runtime variables, method parameters, or config. The LLM should NOT
 * hallucinate "database-unknown-db" or "mysql-unknown-db" as table names.
 *
 * The graph-writer filter should also reject any DataContainer node with
 * "unknown" in its name as a Layer 2 defense.
 *
 * Expected LLM Output:
 * - infrastructure should be EMPTY or contain only resolvable table names
 * - The LLM should NOT return "database-unknown-db", "mysql-unknown-db", etc.
 */
class DynamicQueryRunner
{
    private \PDO $db;

    public function __construct(\PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Runs a fully dynamic query — table name comes from parameter.
     * The LLM cannot determine the table name from the source code.
     */
    public function executeQuery(string $tableName, array $conditions): array
    {
        $where = [];
        $params = [];
        foreach ($conditions as $field => $value) {
            $where[] = "{$field} = ?";
            $params[] = $value;
        }

        $sql = "SELECT * FROM " . $tableName;
        if (!empty($where)) {
            $sql .= " WHERE " . implode(' AND ', $where);
        }

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    /**
     * Inserts a row into a dynamic table — table name from parameter.
     */
    public function dynamicInsert(string $table, array $data): int
    {
        $columns = implode(', ', array_keys($data));
        $placeholders = implode(', ', array_fill(0, count($data), '?'));

        $stmt = $this->db->prepare("INSERT INTO {$table} ({$columns}) VALUES ({$placeholders})");
        $stmt->execute(array_values($data));
        return (int) $this->db->lastInsertId();
    }

    /**
     * Deletes rows from a configurable table — table name from config.
     */
    public function purgeOldRecords(string $configuredTable, int $daysOld): int
    {
        $stmt = $this->db->prepare(
            "DELETE FROM {$configuredTable} WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)"
        );
        $stmt->execute([$daysOld]);
        return $stmt->rowCount();
    }

    /**
     * Pure helper — builds a WHERE clause. No I/O.
     */
    private function buildWhereClause(array $conditions): string
    {
        return implode(' AND ', array_map(fn($k) => "{$k} = ?", array_keys($conditions)));
    }
}
