<?php

namespace Acme\Monitoring;

use InfluxDB\Client;
use InfluxDB\Database;

/**
 * Thin monitoring wrapper around the InfluxDB client. The write happens here,
 * one call hop from the constructed client — there is no ORM entity / table, so
 * the datastore can only be recovered from the connection config.
 */
final class InfluxDbMonitoring
{
    private Database $database;

    public function __construct(Client $influxDb, string $database)
    {
        $this->database = $influxDb->selectDB($database);
    }

    public function addEvent(string $metric, float $value, array $tags = []): void
    {
        $points = [
            new \InfluxDB\Point($metric, $value, $tags),
        ];
        $this->database->writePoints($points);
    }
}
