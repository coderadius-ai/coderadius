<?php

declare(strict_types=1);

namespace Acme\Inventory\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Annotation\Route;

// Legacy Symfony DocBlock @Route annotations (no class-level prefix).
final class ShippingController extends AbstractController
{
    /**
     * @Route("/shipping/{id}", methods={"GET"})
     */
    public function track(string $id): JsonResponse
    {
        return new JsonResponse(['id' => $id, 'status' => 'in_transit']);
    }

    /**
     * @Route("/shipping", methods={"POST"})
     */
    public function dispatch(): JsonResponse
    {
        return new JsonResponse(['dispatched' => true], 201);
    }
}
