<?php

namespace Acme\Inventory;

/**
 * Same-namespace consumer: depends on OrdersClientInterface (no `use`
 * statement because it's co-located in the same namespace). The taint
 * engine must:
 *   1. Recognise the bare `OrdersClientInterface` type-hint as an
 *      implicit local import (extractPhpSameNamespaceImplicitImports).
 *   2. Back-propagate I/O taint from OrdersClient (Patient Zero) onto
 *      OrdersClientInterface (which it implements).
 *   3. Mark OrdersService as tainted because it imports the now-tainted
 *      interface.
 */
class OrdersService
{
    private OrdersClientInterface $client;

    public function __construct(OrdersClientInterface $client)
    {
        $this->client = $client;
    }

    public function quotation(array $request, string $requestId): array
    {
        $response = $this->client->callQuotationMethod(
            OrdersClient::QUOTATION_SERVICE,
            json_encode($request),
            $requestId,
            []
        );
        return json_decode($response, true);
    }

    public function proposal(array $proposal, string $requestId): array
    {
        $response = $this->client->callProposalMethod(
            OrdersClient::PROPOSAL_SERVICE,
            json_encode($proposal),
            $requestId
        );
        return json_decode($response, true);
    }
}
