<?php
// DI container wiring. The InfluxDB client is constructed with POSITIONAL
// host/port args (not a DSN URI) and handed to a monitoring wrapper, so the
// actual write I/O lives one hop away in InfluxDbMonitoring::addEvent. This is
// the topology that defeats per-function taint, so the datastore must be
// recovered from the connection config and the standard write-method sink.

return [
    Acme\Monitoring\InfluxDbMonitoring::class => static function (): Acme\Monitoring\InfluxDbMonitoring {
        $client = new \InfluxDB\Client(
            \getenv('INFLUXDB_HOST') ?: '',
            (int) (\getenv('INFLUXDB_PORT') ?: 8086),
            \getenv('INFLUXDB_USER') ?: '',
            \getenv('INFLUXDB_PASSWORD') ?: ''
        );
        return new Acme\Monitoring\InfluxDbMonitoring($client, \getenv('INFLUXDB_SCHEMA') ?: '');
    },
];
