<?php
namespace Acme\Inventory\Service;

use Acme\Inventory\Daily\DailyDigest;

/**
 * Negative control: a regular service class with an __invoke method whose
 * parameter does NOT match the CQRS suffix pattern. Without registry
 * cross-check, the legacy heuristic should NOT classify this as a handler.
 */
class Utility
{
    public function __invoke(DailyDigest $digest): void
    {
    }
}
