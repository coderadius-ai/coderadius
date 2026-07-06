<?php
namespace Acme\Orders;

use Acme\Conduit\ConduitTopic;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

class PublishOrderCommand {
    public function __construct(
        #[Autowire(service: 'conduit.topics.order_created')]
        private ConduitTopic $topic,
    ) {}

    public function execute(string $orderId): void {
        $event = new \stdClass();
        $event->orderId = $orderId;
        $this->topic->publish($event);
    }
}
