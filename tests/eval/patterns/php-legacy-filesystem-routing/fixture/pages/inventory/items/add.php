<?php

require_once __DIR__ . '/../../../src/bootstrap.php';

$sku = $_GET['sku'] ?? '';
$warehouse = $_GET['warehouse'] ?? 'main';

$item = inventory_lookup($sku, $warehouse);

echo '<h1>Add inventory item</h1>';
echo '<p>SKU: ' . htmlspecialchars($sku) . '</p>';
echo render_item_form($item);
