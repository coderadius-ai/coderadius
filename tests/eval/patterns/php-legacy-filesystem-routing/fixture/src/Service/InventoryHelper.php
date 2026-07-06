<?php

namespace Acme\Storefront\Service;

// Framework-managed code: included by the autoloader, never served directly.
// It still reads request state and echoes — the directory exclusion must win.
$debug = $_GET['debug'] ?? false;
if ($debug) {
    echo 'debug mode';
}

class InventoryHelper
{
    public function formatSku(string $sku): string
    {
        return strtoupper(trim($sku));
    }
}
