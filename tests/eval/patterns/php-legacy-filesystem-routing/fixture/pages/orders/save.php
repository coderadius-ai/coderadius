<?php

require_once __DIR__ . '/../../src/bootstrap.php';

$orderId = $_POST['order_id'] ?? null;
$lines = $_POST['lines'] ?? [];

if ($orderId === null) {
    header('HTTP/1.1 400 Bad Request');
    echo 'missing order_id';
    exit;
}

order_save($orderId, $lines);

header('Location: /pages/orders/view.php?id=' . urlencode($orderId));
