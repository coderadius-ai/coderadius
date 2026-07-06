<?php

$timeStart = time();
define('PROVIDER_BASE_ID', 42);

if (!isset($provider_id)) {
    $provider_id = 42;
}

define('TRIP_TYPE', $argv[2] ?? $_REQUEST['TYPE'] ?? 'F'); // F=Flight, H=Hotel

require_once __DIR__ . '/../classes/TravelGlobal.php';
$global = \TravelApp\Classes\TravelGlobal::getInstance();
$db = $global->getDb();

$isQuotation = ($_REQUEST['SAVE_BOOKING'] ?? $argv[3] ?? 'N') === 'N';
$isBooking = !$isQuotation;
$isTesting = false;

$traceRequestId = uniqid();
$tripId = (int)($argv[1] ?? $_REQUEST['ID_TRIP'] ?? 0);

// Log start
error_log("Process Start $tripId $provider_id $traceRequestId");

$tripData = $db->query("SELECT * FROM trips WHERE id = $tripId")->fetch_assoc();
if (!$tripData) {
    die("Dati viaggio non trovati");
}

// Environment overrides (simulated)
$_SESSION = json_decode($tripData['session_data'], true) ?? [];

// Blocchi specifici
if ($provider_id === 42 && $_SESSION['destination'] === 'Bermuda') {
    die("Destinazione non abilitata per SkyFly");
}

$user = (int)$tripData['user_id'];
$isVipUser = $user > 10000;

$_SESSION = correzioniCampi($_SESSION, false);

$businessTravel = false;
if (TRIP_TYPE === 'F') {
    if ($_SESSION['passenger_type'] === 'B') {
        $businessTravel = true;
    }
}

// Fix aeroporti
$airports = ['departure', 'arrival', 'layover'];
foreach ($airports as $airport) {
    if (isset($_SESSION[$airport])) {
        switch ($_SESSION[$airport]) {
            case 'NEW YORK - JFK':
                $_SESSION[$airport] = 'JFK';
                break;
            case 'MILANO - MXP':
                $_SESSION[$airport] = 'MXP';
                break;
        }
    }
}

if (isset($_REQUEST['DEBUG'])) {
    echo "<pre>\n";
    print_r($_SESSION);
    echo "</pre><hr>\n";
}

if (!isset($_SESSION['travel_year'])) {
    $_SESSION['travel_year'] = date('Y');
}

// Controllo passeggeri uguali
if ($_SESSION['payer_is_passenger'] == 'N' && $_SESSION['payer_ssn'] != '' && $_SESSION['payer_ssn'] == $_SESSION['passenger_ssn']) {
    $_SESSION['payer_is_passenger'] = 'Y';
    if (isset($_REQUEST['DEBUG'])) {
        echo "<h3>Passeggero impostato uguale a pagatore</h3><hr>\n";
    }
}

$_GET = $_SESSION;

if ($isBooking) {
    define('METHOD_WS', 'BookTrip');
} else {
    define('METHOD_WS', 'GetTripQuote');
}

$departure_date = $_GET['dep-dd'] . '/' . $_GET['dep-mm'] . '/' . $_GET['dep-yyyy'];

$class_map = [
    1 => 'Economy',
    2 => 'Premium Economy',
    3 => 'Business',
    4 => 'First',
];

$factors = [];
if (isset($extraFactors) && !empty($extraFactors)) {
    $factors = $extraFactors;
}

// Gestione sconti
if ($_GET['promo_code'] != 'NONE') {
    $factors[] = ['PRMO', '101', 3, '1.0'];
    $factors[] = ['PCODE', '102', 5, $_GET['promo_code']];
}

// Dati anagrafici
$factors[] = ['FNAME', '-7', 5, htmlspecialchars($_GET['first_name'], ENT_QUOTES)];
$factors[] = ['LNAME', '-6', 5, htmlspecialchars($_GET['last_name'], ENT_QUOTES)];

$email = $_GET['email'];
$phone = $_GET['phone'];
if ($isVipUser) {
    $email = 'vip-' . substr($user, 1) . '@travelapp.com';
    $phone = '555-0199';
}

$factors[] = ['EMAIL', '-17', 5, $email];
$factors[] = ['PHONE', '-18', 5, $phone];

$xml_request = createXmlRequest($factors);

if (isset($_REQUEST['DEBUG'])) {
    echo '<pre>';
    echo htmlspecialchars($xml_request);
    echo '</pre>';
}

$curl = curl_init();
curl_setopt($curl, CURLOPT_URL, "https://api.skyfly.com/soap");
curl_setopt($curl, CURLOPT_POST, true);
curl_setopt($curl, CURLOPT_POSTFIELDS, $xml_request);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
curl_setopt($curl, CURLOPT_TIMEOUT, 30);

$startDateTime = new \DateTime();
$response = curl_exec($curl);
$httpCode = curl_getinfo($curl, CURLINFO_HTTP_CODE);
$endDateTime = new \DateTime();

// Trace communication simulating the courier API
$db->query("INSERT INTO api_traces (provider, req_id, http_code) VALUES ('skyfly', '$traceRequestId', $httpCode)");

curl_close($curl);

if (isset($_REQUEST['DEBUG'])) {
    echo '<h3>Response:</h3><pre>';
    echo htmlspecialchars($response);
    echo '</pre><hr>';
}

if (!in_array($httpCode, [200, 500])) {
    die("HTTP ERROR $httpCode");
}

if (preg_match('/Seat unavailable/i', $response)) {
    die("SEAT_UNAVAILABLE - errore definitivo");
}

if ($isBooking) {
    preg_match('/<BookingId>(.*?)<\/BookingId>/', $response, $matches);
    $bookingId = $matches[1] ?? null;
    
    if (!$bookingId) {
        die("CODICE PRENOTAZIONE NON VALIDO");
    }

    $db->query("UPDATE trips SET status = 'BOOKED', external_id = '$bookingId' WHERE id = $tripId");
    
    // Invia notifica async
    // notifySave()
} else {
    // Quotation
    preg_match('/<QuoteId>(.*?)<\/QuoteId>/', $response, $matches);
    $quoteId = $matches[1] ?? null;
    preg_match('/<TotalPrice>(.*?)<\/TotalPrice>/', $response, $matchesPrice);
    $price = $matchesPrice[1] ?? 0;

    if ($price < 10) {
        die("PREZZO TROPPO BASSO ($price)");
    }

    $db->query("UPDATE trip_quotes SET price = $price, quote_id = '$quoteId' WHERE trip_id = $tripId");
}

error_log("Process Completion $quotationLogId");

function createXmlRequest($factors) {
    global $departure_date;
    $xml = '<?xml version="1.0"?><SOAP-ENV:Envelope><SOAP-ENV:Body><Request>';
    $xml .= '<Method>' . METHOD_WS . '</Method>';
    $xml .= '<DepartureDate>' . $departure_date . '</DepartureDate>';
    $xml .= '<Factors>';
    foreach ($factors as $f) {
        $xml .= "<Factor code=\"{$f[0]}\" type=\"{$f[2]}\">{$f[3]}</Factor>";
    }
    $xml .= '</Factors></Request></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    return $xml;
}

function correzioniCampi($session, $param) {
    if (!isset($session['luggage'])) {
        $session['luggage'] = 0;
    }
    return $session;
}
