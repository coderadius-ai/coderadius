<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

// Doctrine entity (PHP 8 attributes): #[ORM\Entity] + #[ORM\Table(name: 'orders')]
// map the class to the `orders` table; #[ORM\Column] declares columns.
#[ORM\Entity]
#[ORM\Table(name: 'orders')]
class Order
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: 'integer')]
    private int $id;

    #[ORM\Column(name: 'reference', type: 'string')]
    private string $reference;

    #[ORM\Column(name: 'total_amount', type: 'integer', nullable: true)]
    private ?int $totalAmount;

    #[ORM\Column(type: 'string')]
    private string $status;
}
