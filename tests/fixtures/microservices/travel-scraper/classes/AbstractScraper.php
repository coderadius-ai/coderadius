<?php

namespace TravelApp\Classes;

use Exception;

abstract class AbstractScraper
{
    const ERROR_TEMPORARY = 1;
    const ERROR_DEFINITIVE = 2;

    protected $curl;
    protected $params;
    protected $isBookingParam = false;
    protected $timeStart;
    protected $db;
    protected $global;
    protected $requestId;

    abstract protected function scrapePrice();
    abstract protected function performBooking();
    abstract protected function setHost();

    public function __construct(string $requestId = '')
    {
        $this->requestId = $requestId;
        $this->timeStart = microtime(true);
        try {
            $this->init();
            
            if ($this->isBooking()) {
                $this->runBooking();
            } else {
                $this->runScraping();
            }
        } catch (\Throwable $e) {
            $this->showDebug($e->getMessage());
            // Simulates a critical log call as in the courier API client
            error_log('[AbstractScraper] Fatal Error in scraper execution: ' . $e->getMessage());
        }

        $this->getDb()->close();
    }

    protected function init()
    {
        $this->getParams();
        $this->setHost();
        $this->curl = curl_init();
    }

    protected function getParams()
    {
        if (php_sapi_name() === 'cli') {
            $this->params = $_SERVER['argv'];
            if (isset($_SERVER['argv'][3]) && $_SERVER['argv'][3] === 'Y') {
                $this->isBookingParam = true;
            }
        } else {
            $this->params = $_REQUEST;
            if (isset($_REQUEST['SAVE_BOOKING']) && $_REQUEST['SAVE_BOOKING'] === 'Y') {
                $this->isBookingParam = true;
            }
        }
    }

    protected function isBooking()
    {
        return $this->isBookingParam;
    }

    protected function runScraping()
    {
        $maxRetries = 3;
        for ($i = 1; $i <= $maxRetries; $i++) {
            try {
                $this->scrapePrice();
                $this->trackCommunication(true);
                break;
            } catch (Exception $e) {
                $this->trackCommunication(false, $e->getCode());
                if ($i < $maxRetries && $e->getCode() === self::ERROR_TEMPORARY) {
                    sleep(2);
                    continue;
                }
                $this->getDb()->query("UPDATE trip_quotes SET error = 'Definitive error' WHERE id = " . $this->params['ID_TRIP']);
                break;
            }
        }
    }

    protected function runBooking()
    {
        try {
            $this->performBooking();
            $this->trackCommunication(true);
        } catch (Exception $e) {
            $this->trackCommunication(false, $e->getCode());
            $this->getDb()->query("UPDATE bookings SET error = '" . $e->getMessage() . "' WHERE id = " . $this->params['ID_TRIP']);
        }
    }

    protected function trackCommunication(bool $success, int $errorCode = 0)
    {
        // Simulates tracking on influx or db
        $time = microtime(true) - $this->timeStart;
        $this->getDb()->query("INSERT INTO telemetry (request_id, success, time_taken, error_code) VALUES ('{$this->requestId}', " . ($success ? 1 : 0) . ", {$time}, {$errorCode})");
    }

    protected function showDebug($msg)
    {
        if (isset($_REQUEST['DEBUG'])) {
            echo "<pre>" . print_r($msg, true) . "</pre><hr>";
        }
    }

    protected function getDb()
    {
        if (!$this->db) {
            $this->db = new \mysqli('localhost', 'user', 'pass', 'travel_db');
        }
        return $this->db;
    }

    protected function callApi($url, $body)
    {
        curl_setopt($this->curl, CURLOPT_URL, $url);
        curl_setopt($this->curl, CURLOPT_POST, true);
        curl_setopt($this->curl, CURLOPT_POSTFIELDS, $body);
        curl_setopt($this->curl, CURLOPT_RETURNTRANSFER, true);
        return curl_exec($this->curl);
    }
}
