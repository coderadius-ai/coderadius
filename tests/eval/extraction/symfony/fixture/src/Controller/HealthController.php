<?php

declare(strict_types=1);

namespace Acme\Orders\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

final class HealthController extends AbstractController
{
    // No methods: argument — Symfony route extractor defaults this to GET.
    #[Route('/health')]
    public function health(): JsonResponse
    {
        return new JsonResponse(['status' => 'ok']);
    }
}
