<?php

declare(strict_types=1);

namespace Acme\Orders\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

// Class-level prefix is concatenated onto every method route.
#[Route('/orders')]
final class OrderController extends AbstractController
{
    #[Route('', methods: ['GET'])]
    public function index(): JsonResponse
    {
        return new JsonResponse(['orders' => []]);
    }

    #[Route('', methods: ['POST'])]
    public function create(): JsonResponse
    {
        return new JsonResponse(['id' => 'ord_1'], 201);
    }

    #[Route('/{id}', methods: ['GET'])]
    public function show(string $id): JsonResponse
    {
        return new JsonResponse(['id' => $id, 'status' => 'pending']);
    }

    #[Route('/{id}', methods: ['PUT'])]
    public function update(string $id): JsonResponse
    {
        return new JsonResponse(['id' => $id, 'updated' => true]);
    }

    #[Route('/{id}', methods: ['DELETE'])]
    public function delete(string $id): JsonResponse
    {
        return new JsonResponse(null, 204);
    }
}
