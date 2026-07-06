<?php
namespace Acme\Inventory\Handler;

use Acme\Inventory\QuoteMessage;
use Symfony\Component\Messenger\MessageBusInterface;

/**
 * Legacy-style Symfony Messenger handler (PHP 7 / 8 without attribute).
 * Recognised by: method name == __invoke AND first parameter type matches
 * CQRS suffix pattern (Message|Event|Command|Query).
 */
class QuoteHandler
{
    public function __invoke(QuoteMessage $message): void
    {
        // Log line that the LLM would extract from as a fallback. The handler
        // extractor must produce the canonical routing key as a critical
        // invocation so this log string is NOT used.
        // logger->info('Consuming acme.inventory.quote.requested ...');
    }
}
