<?php

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;
use Slim\Routing\RouteCollectorProxy;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

// Top-level verbs other than GET/POST — exercises PUT and DELETE resolution.
$app->put('/payment/{id}', function (Request $request, Response $response, array $args): Response {
    $response->getBody()->write(json_encode(['id' => $args['id'], 'captured' => true]));
    return $response->withHeader('Content-Type', 'application/json');
});

$app->delete('/payment/{id}', function (Request $request, Response $response, array $args): Response {
    $response->getBody()->write(json_encode(['id' => $args['id'], 'voided' => true]));
    return $response->withHeader('Content-Type', 'application/json');
});

// Group with non-root nested paths and a distinct param name ({trackingId}).
$app->group('/shipping', function (RouteCollectorProxy $group) {
    $group->get('/labels', function (Request $request, Response $response): Response {
        $response->getBody()->write(json_encode(['labels' => []]));
        return $response->withHeader('Content-Type', 'application/json');
    });

    $group->post('/labels/{trackingId}', function (Request $request, Response $response, array $args): Response {
        $response->getBody()->write(json_encode(['trackingId' => $args['trackingId']]));
        return $response->withHeader('Content-Type', 'application/json');
    });
});

// Multi-method route — $app->map(['GET','POST'], ...) expands to one endpoint
// per listed verb.
$app->map(['GET', 'POST'], '/notification/dispatch', function (Request $request, Response $response): Response {
    $response->getBody()->write(json_encode(['dispatched' => true]));
    return $response->withHeader('Content-Type', 'application/json');
});

$app->run();
