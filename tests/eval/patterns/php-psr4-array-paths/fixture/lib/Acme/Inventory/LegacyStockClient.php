<?php

namespace Acme\Inventory;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;

class LegacyStockClient
{
    private $http;

    private $requestFactory;

    private $auditLog;

    public function __construct(
        ClientInterface $http,
        RequestFactoryInterface $requestFactory,
        StockAuditLog $auditLog
    ) {
        $this->http = $http;
        $this->requestFactory = $requestFactory;
        $this->auditLog = $auditLog;
    }

    public function fetchStockLevel(string $sku): int
    {
        $request = $this->requestFactory->createRequest('GET', '/stock/' . $sku);
        $response = $this->http->sendRequest($request);
        $this->auditLog->record($sku);

        return (int) (string) $response->getBody();
    }
}
