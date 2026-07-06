<?php

namespace Acme\Inventory;

use GuzzleHttp\Exception\BadResponseException;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Psr\Http\Message\UriFactoryInterface;

class InventoryGqlClient
{
    private ClientInterface $httpClient;

    private RequestFactoryInterface $httpRequestFactory;

    private UriFactoryInterface $uriFactory;

    private StreamFactoryInterface $streamFactory;

    private string $uri;

    private string $apiKey;

    public function __construct(
        ClientInterface $httpClient,
        RequestFactoryInterface $httpRequestFactory,
        UriFactoryInterface $uriFactory,
        StreamFactoryInterface $streamFactory,
        string $apiKey,
        string $uri
    ) {
        $this->httpClient = $httpClient;
        $this->httpRequestFactory = $httpRequestFactory;
        $this->uriFactory = $uriFactory;
        $this->streamFactory = $streamFactory;
        $this->uri = $uri;
        $this->apiKey = $apiKey;
    }

    public function getToken(): string
    {
        $uri = $this->uriFactory->createUri($this->uri . '/login');
        $request = $this->httpRequestFactory->createRequest('POST', $uri)
            ->withHeader('Authorization', 'Basic ' . $this->apiKey);
        $response = $this->httpClient->sendRequest($request);
        if ($response->getStatusCode() >= 400) {
            throw new BadResponseException('Auth error', $request, $response);
        }
        return $response->getBody()->getContents();
    }

    public function post(string $token, string $query, array $variables): string
    {
        $uri = $this->uriFactory->createUri($this->uri . '/api');
        $request = $this->httpRequestFactory->createRequest('POST', $uri)
            ->withHeader('Authorization', $token)
            ->withHeader('Content-Type', 'application/json')
            ->withBody($this->streamFactory->createStream(json_encode([
                'query' => $query,
                'variables' => $variables,
            ])));
        $response = $this->httpClient->sendRequest($request);
        if ($response->getStatusCode() >= 400) {
            throw new BadResponseException('GraphQL error', $request, $response);
        }
        return $response->getBody()->getContents();
    }
}
