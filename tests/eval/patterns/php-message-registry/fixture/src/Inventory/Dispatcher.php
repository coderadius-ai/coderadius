<?php
namespace Acme\Inventory;

use Symfony\Component\Messenger\MessageBusInterface;

class Dispatcher
{
    private MessageBusInterface $bus;

    public function __construct(MessageBusInterface $bus)
    {
        $this->bus = $bus;
    }

    public function publishQuote(string $payload): void
    {
        $this->bus->dispatch(new QuoteMessage($payload));
    }

    public function publishProductQuote(string $payload): void
    {
        $this->bus->dispatch(new ProductQuoteMessage($payload));
    }
}
