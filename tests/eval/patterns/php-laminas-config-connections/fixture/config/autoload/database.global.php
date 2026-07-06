<?php

declare(strict_types=1);

use Acme\Platform\EnvVault;
use Doctrine\DBAL\Driver\PDOMySql\Driver as MySqlDriver;

/**
 * doctrine-orm-module connection map. Three logical databases, each with its
 * host/port/dbname read through the declared EnvVault::fetch accessor wrapper
 * (literal defaults harvested by the env-accessor scanner). The driverClass
 * form is varied on purpose:
 *   - orm_default   : use-aliased ::class
 *   - orm_reporting : fully-qualified \Doctrine\... ::class
 *   - orm_archive   : 'driver' => 'pdo_mysql' PDO token inside params
 */
return [
    'doctrine' => [
        'connection' => [
            'orm_default' => [
                'driverClass' => MySqlDriver::class,
                'params' => [
                    'host'   => EnvVault::fetch('ORDERS_DB_HOST', 'mysql'),
                    'port'   => EnvVault::fetch('ORDERS_DB_PORT', 3306),
                    'user'   => EnvVault::fetch('ORDERS_DB_USER', 'orders'),
                    'dbname' => EnvVault::fetch('ORDERS_DB_NAME', 'orders_main'),
                ],
            ],
            'orm_reporting' => [
                'driverClass' => \Doctrine\DBAL\Driver\PDOMySql\Driver::class,
                'params' => [
                    'host'   => EnvVault::fetch('REPORTING_DB_HOST', 'mysql'),
                    'dbname' => EnvVault::fetch('REPORTING_DB_NAME', 'reporting'),
                ],
            ],
            'orm_archive' => [
                'params' => [
                    'driver' => 'pdo_mysql',
                    'host'   => EnvVault::fetch('ARCHIVE_DB_HOST', 'mysql'),
                    'dbname' => EnvVault::fetch('ARCHIVE_DB_NAME', 'archive'),
                ],
            ],
        ],
    ],
];
