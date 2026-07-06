<?php

namespace Acme\Inventory;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\UriFactoryInterface;

/**
 * Patient Zero: imports PSR-18 ClientInterface directly.
 * The taint engine must seed this file as I/O-tainted.
 */
class OrdersClient implements OrdersClientInterface
{
    public const QUOTATION_SERVICE = 'quotes-batch';
    public const PROPOSAL_SERVICE = 'saved-quote';

    private ClientInterface $client;
    private RequestFactoryInterface $requestFactory;
    private UriFactoryInterface $uriFactory;
    private string $uri;

    public function __construct(
        ClientInterface $client,
        RequestFactoryInterface $requestFactory,
        UriFactoryInterface $uriFactory,
        string $uri
    ) {
        $this->client = $client;
        $this->requestFactory = $requestFactory;
        $this->uriFactory = $uriFactory;
        $this->uri = $uri;
    }

    public function callQuotationMethod(string $methodToCall, string $message, string $requestId, array $headers): string
    {
        $uri = $this->uriFactory->createUri($this->uri . '/' . $methodToCall);
        $request = $this->requestFactory->createRequest('POST', $uri);
        $response = $this->client->sendRequest($request);
        return $response->getBody()->getContents();
    }

    public function callProposalMethod(string $methodToCall, string $message, string $requestId): string
    {
        $uri = $this->uriFactory->createUri($this->uri . '/' . $methodToCall);
        $request = $this->requestFactory->createRequest('POST', $uri);
        $response = $this->client->sendRequest($request);
        return $response->getBody()->getContents();
    }
}
