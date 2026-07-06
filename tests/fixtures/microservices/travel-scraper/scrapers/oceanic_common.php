<?php

$timeStart = time();
define('PROVIDER_BASE_ID', 99);

if (!isset($provider_id)) {
    $provider_id = 99; // Oceanic Airlines
}

define('TRIP_TYPE', $argv[2] ?? $_REQUEST['TYPE'] ?? 'F'); // F=Flight, H=Hotel

require_once __DIR__ . '/../classes/TravelGlobal.php';
$global = \TravelApp\Classes\TravelGlobal::getInstance();
$db = $global->getDb();

$isQuotation = ($_REQUEST['SAVE_BOOKING'] ?? $argv[3] ?? 'N') === 'N';
$isBooking = !$isQuotation;
$isTesting = true;

$traceRequestId = uniqid();
$tripId = (int)($argv[1] ?? $_REQUEST['ID_TRIP'] ?? 0);

$tripData = $db->query("SELECT * FROM trips WHERE id = $tripId")->fetch_assoc();
if (!$tripData) {
    die("Dati viaggio non trovati");
}

$_SESSION = json_decode($tripData['session_data'], true) ?? [];

if ($provider_id === 99 && $_SESSION['destination'] === 'Sydney') {
    die("Destinazione Oceanic Airlines momentaneamente sospesa");
}

$user = (int)$tripData['user_id'];

$_GET = $_SESSION;

// Costruzione payload JSON
$payload = [
    'header' => [
        'partnerId' => 'TRAV_APP_123',
        'reqId' => $traceRequestId,
        'action' => $isBooking ? 'BOOK' : 'QUOTE'
    ],
    'trip' => [
        'depDate' => $_GET['dep-yyyy'] . '-' . $_GET['dep-mm'] . '-' . $_GET['dep-dd'],
        'retDate' => $_GET['ret-yyyy'] . '-' . $_GET['ret-mm'] . '-' . $_GET['ret-dd'],
        'passengers' => []
    ]
];

$passenger = [
    'name' => $_GET['first_name'],
    'surname' => $_GET['last_name'],
    'type' => $_GET['passenger_type'] === 'B' ? 'BUSINESS' : 'LEISURE',
];

$payload['trip']['passengers'][] = $passenger;

$json_request = json_encode($payload);

if (isset($_REQUEST['DEBUG'])) {
    echo '<pre>';
    echo htmlspecialchars($json_request);
    echo '</pre>';
}

$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, "https://api.oceanic-airlines.com/v2/shipment");
curl_setopt($curl, CURLOPT_POST, true);
curl_setopt($curl, CURLOPT_POSTFIELDS, $json_request);
curl_setopt($curl, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
curl_setopt($curl, CURLOPT_TIMEOUT, 60);

$response = curl_exec($curl);
$httpCode = curl_getinfo($curl, CURLINFO_HTTP_CODE);

curl_close($curl);

if (isset($_REQUEST['DEBUG'])) {
    echo '<h3>Response:</h3><pre>';
    echo htmlspecialchars($response);
    echo '</pre><hr>';
}

if ($httpCode !== 200) {
    die("HTTP ERROR $httpCode: $response");
}

$responseData = json_decode($response, true);

if (isset($responseData['error'])) {
    die("API ERROR: " . $responseData['error']['message']);
}

if ($isBooking) {
    $bookingId = $responseData['booking']['id'] ?? null;
    
    if (!$bookingId) {
        die("CODICE PRENOTAZIONE NON VALIDO");
    }

    $db->query("UPDATE trips SET status = 'BOOKED', external_id = '$bookingId' WHERE id = $tripId");
} else {
    // Quotation
    $quoteId = $responseData['shipment']['id'] ?? null;
    $price = $responseData['shipment']['totalAmount'] ?? 0;

    if ($price < 10) {
        die("PREZZO TROPPO BASSO ($price)");
    }

    $db->query("UPDATE trip_quotes SET price = $price, quote_id = '$quoteId' WHERE trip_id = $tripId");
}
