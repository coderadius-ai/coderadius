<?php

declare(strict_types=1);

namespace Fulfillment\Messenger\Middleware;

use Fulfillment\Messenger\AmqpConfig;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\Middleware\MiddlewareInterface;
use Symfony\Component\Messenger\Middleware\StackInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;

/**
 * Middleware that stamps outbound AMQP messages with the correct routing key.
 *
 * Reads the message class name from the envelope, looks it up in AmqpConfig::getMessageMap(),
 * and attaches an AmqpStamp with the physical routing key before handing off to the transport.
 *
 * This is an INFRASTRUCTURE WRAPPER — it does not define which queues exist,
 * only wires them. The queue definitions live in AmqpConfig::getMessageMap().
 *
 * @see AmqpConfig::getMessageMap()
 */
class AmqpRoutingMiddleware implements MiddlewareInterface
{
    private AmqpConfig $amqpConfig;

    public function __construct(AmqpConfig $amqpConfig)
    {
        $this->amqpConfig = $amqpConfig;
    }

    public function handle(Envelope $envelope, StackInterface $stack): Envelope
    {
        if (empty($envelope->all(ReceivedStamp::class))) {
            $routingKey = $this->mapMessageToRoutingKey(get_class($envelope->getMessage()));
            if ($routingKey !== null) {
                $envelope = $envelope->with(
                    new \Symfony\Component\Messenger\Bridge\Amqp\Transport\AmqpStamp($routingKey)
                );
            }
        }

        return $stack->next()->handle($envelope, $stack);
    }

    private function mapMessageToRoutingKey(string $messageClass): ?string
    {
        return $this->amqpConfig->getMessageMap()[$messageClass]['routing_key'] ?? null;
    }
}
