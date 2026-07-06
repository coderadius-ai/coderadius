<?php
namespace Acme\Inventory\Messenger {
    use Symfony\Component\Messenger\MessageBusInterface;

    /**
     * Bracketed-namespace syntax (PHP 5.3+). The extractor must recognise the
     * namespace correctly and emit both FQCN and short-name facts.
     */
    class BracketedConfig
    {
        public function routes(): array
        {
            return [
                ShipmentDispatchedEvent::class => [
                    'topic' => 'acme.inventory.shipment.dispatched',
                ],
            ];
        }
    }
}
