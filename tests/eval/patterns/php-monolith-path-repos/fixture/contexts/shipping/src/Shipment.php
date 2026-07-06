<?php

namespace Acme\Shipping;

class Shipment
{
    public function track(): string
    {
        return 'in-transit';
    }
}
