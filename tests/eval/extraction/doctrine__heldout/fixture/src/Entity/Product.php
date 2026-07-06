<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Doctrine entity using DOCBLOCK annotations (the pre-attribute syntax) — a
 * generalization check: same mapper, different declaration syntax.
 *
 * @ORM\Entity
 * @ORM\Table(name="products")
 */
class Product
{
    /**
     * @ORM\Id
     * @ORM\GeneratedValue
     * @ORM\Column(type="integer")
     */
    private int $id;

    /**
     * @ORM\Column(name="sku", type="string")
     */
    private string $sku;

    /**
     * @ORM\Column(name="stock_level", type="integer", nullable=true)
     */
    private ?int $stockLevel;
}
