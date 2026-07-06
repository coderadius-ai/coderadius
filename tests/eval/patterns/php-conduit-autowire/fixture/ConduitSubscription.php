<?php
namespace Acme\Conduit;

interface ConduitSubscription {
    public function pull(): iterable;
    public function ack(object $envelope): void;
}
