<?php
// Connection config sourced from env. The getenv() references make the
// MEMCACHED_*/DB_* vars "code-referenced" so the connection extractor consumes
// them (deployment-only vars are otherwise excluded).
return [
    'environment' => \getenv('APP_ENV'),
    // A kv cache resolved via the MEMCACHED_* trio. Its only I/O lives in the
    // Cache constructor below (taint-dropped), so no function ever binds it —
    // standalone promotion is the recall path.
    'cache' => [
        'host' => \getenv('MEMCACHED_HOST'),
        'port' => (int) \getenv('MEMCACHED_PORT'),
    ],
    // Contrast: a classic RDBMS resolved via the DB_HOST/DB_SCHEMA trio.
    'database' => [
        'host'   => \getenv('DB_HOST'),
        'port'   => (int) \getenv('DB_PORT'),
        'dbname' => \getenv('DB_SCHEMA'),
    ],
];
