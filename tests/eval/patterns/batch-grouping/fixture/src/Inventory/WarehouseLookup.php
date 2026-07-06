<?php

declare(strict_types=1);

namespace Acme\Inventory;

use PDO;

/** Singleton-class fixture: one I/O method, merged into a MIXED batch (R2). */
final class WarehouseLookup
{
    public function __construct(private readonly PDO $connection)
    {
    }

    public function findNearestWarehouse(string $postcode): ?array
    {
        $statement = $this->connection->prepare(
            'SELECT id, name FROM warehouse_locations WHERE postcode_prefix = :prefix ORDER BY capacity DESC LIMIT 1'
        );
        $statement->execute(['prefix' => substr($postcode, 0, 3)]);

        return $statement->fetch(PDO::FETCH_ASSOC) ?: null;
    }
}
