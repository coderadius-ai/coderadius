<?php

require_once __DIR__ . '/../../../src/bootstrap.php';

$carrier = $_GET['carrier'] ?? '';
$day = $_GET['day'] ?? date('Y-m-d');

$slots = shipping_available_slots($carrier, $day);

echo '<h1>Add shipping slot</h1>';
echo render_slot_picker($slots);
