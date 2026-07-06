<?php

namespace TravelApp\Classes;

class TravelGlobal
{
    private static $instance = null;
    private $db;
    private $config;
    public $siteId;

    private function __construct()
    {
        $this->siteId = 1;
        $this->db = new \mysqli('localhost', 'user', 'pass', 'travel_db');
        $this->config = [
            'skyfly' => ['url' => 'https://api.skyfly.com/v1/book'],
            'oceanic' => ['url' => 'https://api.oceanic-airlines.com/v2/shipment']
        ];
    }

    public static function getInstance()
    {
        if (self::$instance === null) {
            self::$instance = new TravelGlobal();
        }
        return self::$instance;
    }

    public function getDb()
    {
        return $this->db;
    }

    public function runScrapers($tripId, $type, $providerId = null)
    {
        if (is_null($providerId)) {
            // If no specific provider is given, launch all the ones enabled for this trip
            $providers = ['skyfly', 'oceanic'];
            foreach ($providers as $provider) {
                $this->runScraper($provider, $tripId, $type, 'N');
            }
        } else {
            $this->runScraper($providerId, $tripId, $type, 'N');
        }
    }

    public function runScraper($providerId, $tripId, $type, $isBooking = 'N')
    {
        // Parallel execution via exec with output redirection, courier-style
        // RINT-2355 enables concurrent execution and log visibility
        $scriptPath = __DIR__ . "/../scrapers/{$providerId}_common.php";
        
        $command = "/usr/bin/php {$scriptPath} {$tripId} {$type} {$isBooking} > /dev/stderr 2>&1 &";
        
        // Esegue in background
        exec($command);
    }
}
