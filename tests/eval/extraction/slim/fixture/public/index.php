<?php

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;
use Slim\Routing\RouteCollectorProxy;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

// Top-level verb routes (Slim 4 $app->get / $app->post).
$app->get('/orders/{id}', function (Request $request, Response $response, array $args): Response {
    $response->getBody()->write(json_encode(['id' => $args['id'], 'status' => 'pending']));
    return $response->withHeader('Content-Type', 'application/json');
});

$app->post('/orders', function (Request $request, Response $response): Response {
    $response->getBody()->write(json_encode(['id' => 'ord_1', 'created' => true]));
    return $response->withHeader('Content-Type', 'application/json');
});

// Group with a '/prefix' — the closure body is recursed and the prefix is
// concatenated onto each nested route ('/' resolves to the group root).
$app->group('/inventory', function (RouteCollectorProxy $group) {
    $group->get('/', function (Request $request, Response $response): Response {
        $response->getBody()->write(json_encode(['items' => []]));
        return $response->withHeader('Content-Type', 'application/json');
    });

    $group->get('/{sku}', function (Request $request, Response $response, array $args): Response {
        $response->getBody()->write(json_encode(['sku' => $args['sku'], 'inStock' => true]));
        return $response->withHeader('Content-Type', 'application/json');
    });
});

$app->run();
