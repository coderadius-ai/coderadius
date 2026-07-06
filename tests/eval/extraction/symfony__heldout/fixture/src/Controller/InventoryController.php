<?php

declare(strict_types=1);

namespace Acme\Inventory\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/inventory')]
final class InventoryController extends AbstractController
{
    // Multi-method route expands to one endpoint per verb (GET + POST).
    #[Route('', methods: ['GET', 'POST'])]
    public function collection(): JsonResponse
    {
        return new JsonResponse(['items' => []]);
    }

    #[Route('/{sku}', methods: ['GET'])]
    public function show(string $sku): JsonResponse
    {
        return new JsonResponse(['sku' => $sku, 'onHand' => 0]);
    }

    #[Route('/{sku}', methods: ['PATCH'])]
    public function adjust(string $sku): JsonResponse
    {
        return new JsonResponse(['sku' => $sku, 'adjusted' => true]);
    }
}
