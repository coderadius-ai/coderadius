<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

$app = \Slim\Factory\AppFactory::create();
$app->run();
