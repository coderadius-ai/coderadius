<?php
namespace Acme\Conduit;

interface ConduitTopic {
    public function publish(object $event): void;
}
