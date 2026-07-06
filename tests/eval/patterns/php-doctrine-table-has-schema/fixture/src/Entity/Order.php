<?php

namespace Acme\Orders\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Doctrine entity for the `acme_orders` table.
 *
 * Mirrors the real-world scenario: an entity file lives under a deep path
 * (`src/Entity/Order.php`) whose first segment ("src") is NOT the
 * qualifiedRepoName. The pipeline must derive the SourceFile URN from
 * the FileContext.repo (qualifiedRepoName = "acme/orders"), NOT from
 * `relativePath.split('/')[0]`, or the SourceFile gets shadow-merged
 * under an orphan URN and `linkDataContainerSchemas` produces no
 * HAS_SCHEMA edge.
 */
#[ORM\Entity]
#[ORM\Table(name: 'acme_orders')]
class Order
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(type: 'string', length: 64)]
    private string $customerId;

    #[ORM\Column(type: 'decimal', precision: 10, scale: 2)]
    private string $amount;

    public function getId(): ?int { return $this->id; }
    public function getCustomerId(): string { return $this->customerId; }
    public function getAmount(): string { return $this->amount; }
}
