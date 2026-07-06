<?php

namespace Acme\Inventory;

interface OrdersClientInterface
{
    public function callQuotationMethod(string $methodToCall, string $message, string $requestId, array $headers): string;

    public function callProposalMethod(string $methodToCall, string $message, string $requestId): string;
}
