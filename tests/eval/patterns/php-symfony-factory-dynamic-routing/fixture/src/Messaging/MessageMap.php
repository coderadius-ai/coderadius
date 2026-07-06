<?php

declare(strict_types=1);

namespace Acme\Orders\Messaging;

use Symfony\Component\Messenger\MessageBusInterface;

/**
 * Dynamic-routing edge case (G7).
 *
 * The factory shape is present (`getMessageMap()` method returning an array)
 * but the array is constructed at runtime from an external loader. The static
 * extractor cannot resolve `MessageClass::class => 'routing.key'` pairs.
 *
 * Expected behaviour: the structural plugin recognises the file as messaging-
 * shaped, observes that `extractMessageClassRoutingTable` returns an empty
 * map, and stamps `needsReview=true` on the SourceFile so the user sees it
 * in `cr review pending`. No MessageChannel / MessageBroker emitted (would
 * be worse than the silent miss).
 */
class MessageMap
{
    private MessageBusInterface $messageBus;

    public function __construct(MessageBusInterface $messageBus)
    {
        $this->messageBus = $messageBus;
    }

    public function getMessageMap(): array
    {
        $loaded = $this->loadExternalRoutingConfig();

        $map = [];
        foreach ($loaded as $entry) {
            $map[$entry['class']] = [
                'queue_name' => $entry['queue'],
                'handle' => $entry['handle'] ?? true,
            ];
        }

        return $map;
    }

    private function loadExternalRoutingConfig(): array
    {
        // In production this would read from a YAML file or a config service.
        // For the fixture we simply return an empty array; what matters is
        // that the AST shape is non-literal so the extractor cannot resolve.
        return [];
    }
}
