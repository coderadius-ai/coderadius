<?php

declare(strict_types=1);

namespace Acme\Inventory\Messaging;

use Acme\Inventory\Messaging\Message\OrderPlacedMessage;
use Acme\Inventory\Messaging\Message\OrderShippedMessage;

/**
 * PHP-factory configuration for Symfony Messenger.
 *
 * Pinned pattern: an application that uses symfony/messenger but does NOT
 * have a `config/packages/messenger.yaml`. The routing map lives in a PHP
 * class returning an array of `MessageClass::class => ['queue_name' => '...']`
 * entries. A factory consumes the array to build the transport list at
 * runtime.
 */
class MessageMap
{
    private string $environment;

    public function __construct(string $environment)
    {
        $this->environment = $environment;
    }

    public function getMessageMap(): array
    {
        $envSuffix = $this->getEnvSuffix();

        return [
            OrderPlacedMessage::class => [
                'queue_name' => 'acme.inventory.order.placed',
                'routing_key' => 'acme.inventory.order.placed',
                'handle' => true,
            ],
            OrderShippedMessage::class => [
                'queue_name' => 'acme.inventory' . $envSuffix . '.order.shipped',
                'routing_key' => 'acme.inventory' . $envSuffix . '.order.shipped',
                'handle' => true,
            ],
        ];
    }

    private function getEnvSuffix(): string
    {
        return $this->environment === 'staging' ? '-staging' : '';
    }
}
