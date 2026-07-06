<?php
// Connection config sourced from env. The getenv() references are what make the
// INFLUXDB_*/DB_*/MEMCACHED_* vars "code-referenced" so the connection extractor
// consumes them (deployment-only vars are otherwise excluded).
return [
    'environment' => \getenv('APP_ENV'),
    'influxdb' => [
        'host'     => \getenv('INFLUXDB_HOST'),
        'port'     => (int) \getenv('INFLUXDB_PORT'),
        'username' => \getenv('INFLUXDB_USER'),
        'password' => \getenv('INFLUXDB_PASSWORD'),
        'database' => \getenv('INFLUXDB_SCHEMA'),
    ],
    // Contrast: a classic RDBMS resolved via the DB_HOST/DB_SCHEMA trio.
    'database' => [
        'host'   => \getenv('DB_HOST'),
        'port'   => (int) \getenv('DB_PORT'),
        'dbname' => \getenv('DB_SCHEMA'),
    ],
    // Contrast: a kv cache resolved via the MEMCACHED_* trio.
    'cache' => [
        'host' => \getenv('MEMCACHED_HOST'),
        'port' => (int) \getenv('MEMCACHED_PORT'),
    ],
];
