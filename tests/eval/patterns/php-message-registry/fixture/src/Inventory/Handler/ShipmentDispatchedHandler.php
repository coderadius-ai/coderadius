<?php
namespace Acme\Inventory\Handler;

use Acme\Inventory\Messenger\ShipmentDispatchedEvent;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Modern Symfony Messenger handler (PHP 8+, Symfony 6+).
 * Recognised by: #[AsMessageHandler] attribute. Method name is free; first
 * parameter type doesn't need a CQRS suffix because the attribute is the
 * explicit handler signal.
 */
class ShipmentDispatchedHandler
{
    #[AsMessageHandler]
    public function handleShipment(ShipmentDispatchedEvent $event): void
    {
    }
}
