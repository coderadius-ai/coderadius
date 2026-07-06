<?php

namespace Acme\Inventory;

/**
 * Top-level wrapper: depends on OrdersService (also same-namespace).
 * The taint engine must reach this file via:
 *   OrdersClient (PSR-18 patient zero)
 *     → OrdersClientInterface (back-prop via implements)
 *     → OrdersService (forward-prop via constructor type-hint)
 *     → OrdersAdapter (forward-prop via constructor type-hint)
 */
class OrdersAdapter
{
    private OrdersService $service;

    public function __construct(OrdersService $service)
    {
        $this->service = $service;
    }

    public function quote(array $request, string $requestId): array
    {
        return $this->service->quotation($request, $requestId);
    }

    public function save(array $proposal, string $requestId): array
    {
        return $this->service->proposal($proposal, $requestId);
    }
}
