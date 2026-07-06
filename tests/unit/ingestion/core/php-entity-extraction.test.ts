import { describe, it, expect } from 'vitest';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { likelyHasIOWithTaint } from '../../../../src/ingestion/core/heuristic-filter.js';
import type { CodeChunk } from '../../../../src/graph/types.js';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const plugin = new PHPPlugin();
const parser = plugin.createParser();

function parseAndExtract(code: string, filepath = 'test.php'): CodeChunk[] {
    const tree = parser.parse(code);
    return plugin.extractFunctions(tree, code, filepath);
}

function findChunk(chunks: CodeChunk[], namePart: string): CodeChunk | undefined {
    return chunks.find(c => c.name.includes(namePart));
}

// ─── Fixture Code ────────────────────────────────────────────────────────────

const DOCTRINE_DOCBLOCK = `<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Table(name="order_records")
 * @ORM\\Entity(repositoryClass="ClaimRepository")
 * @ORM\\HasLifecycleCallbacks()
 */
class OrderRecord
{
    /**
     * @ORM\\Id
     * @ORM\\Column(name="id", type="bigint")
     * @ORM\\GeneratedValue()
     */
    protected $id;

    /**
     * @ORM\\Column(name="customer_id", type="integer")
     */
    protected $customerId;

    const STATUS_PENDING = 'pending';

    public function getId()
    {
        return $this->id;
    }

    public function setCustomerId($customerId)
    {
        $this->customerId = $customerId;
    }

    public function isPending()
    {
        return $this->status === self::STATUS_PENDING;
    }
}
`;

const DOCTRINE_PHP8 = `<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Table(name: "order_records")]
#[ORM\\Entity(repositoryClass: ClaimRepository::class)]
#[ORM\\HasLifecycleCallbacks]
class OrderRecordModern
{
    #[ORM\\Id]
    #[ORM\\Column(name: "id", type: "bigint")]
    #[ORM\\GeneratedValue]
    protected int $id;

    #[ORM\\Column(name: "customer_id", type: "integer")]
    protected int $customerId;

    public function getId(): int
    {
        return $this->id;
    }

    public function setCustomerId(int $customerId): void
    {
        $this->customerId = $customerId;
    }
}
`;

const LARAVEL_MODEL = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class DeliveryOrder extends Model
{
    protected $table = 'delivery_orders';
    protected $fillable = ['customer_id', 'total'];
    protected $casts = ['total' => 'decimal:2'];

    public function getTotalAmount()
    {
        return $this->total_amount;
    }

    public function isPaid()
    {
        return $this->status === 'paid';
    }
}
`;

const MONGODB_ODM = `<?php
namespace App\\Document;

/**
 * @MongoDB\\Document(collection="sessions")
 */
class Session
{
    protected $sessionId;

    public function getSessionId()
    {
        return $this->sessionId;
    }
}
`;

const API_PLATFORM = `<?php
namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;
use Doctrine\\ORM\\Mapping as ORM;

#[ApiResource]
#[ORM\\Entity]
class Product
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    public function getId(): ?int
    {
        return $this->id;
    }
}
`;

const PURE_POPO = `<?php
namespace App\\Config;

class AppConfig
{
    private $debug = false;
    private $version = '1.0.0';

    public function isDebug()
    {
        return $this->debug;
    }

    public function getVersion()
    {
        return $this->version;
    }
}
`;

const PURE_REPO = `<?php
namespace App\\Repository;

class UserRepository
{
    private $connection;

    public function findById($id)
    {
        return $this->connection->query("SELECT * FROM users WHERE id = ?", [$id]);
    }
}
`;

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═════════════════════════════════════════════════════════════════════════════

describe('ORM Entity — Synthetic Class Metadata Chunk', () => {

    // ─── Synthetic Chunk Generation ──────────────────────────────────────

    describe('Synthetic chunk creation', () => {
        it('should create a synthetic __class_metadata chunk for Doctrine DocBlock entity', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.name).toContain('OrderRecord::__class_metadata');
        });

        it('should create a synthetic __class_metadata chunk for PHP 8 attribute entity', () => {
            const chunks = parseAndExtract(DOCTRINE_PHP8);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.name).toContain('OrderRecordModern::__class_metadata');
        });

        it('should create a synthetic __class_metadata chunk for Laravel Eloquent model', () => {
            const chunks = parseAndExtract(LARAVEL_MODEL);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.name).toContain('DeliveryOrder::__class_metadata');
        });

        it('should create a synthetic __class_metadata chunk for MongoDB ODM entity', () => {
            const chunks = parseAndExtract(MONGODB_ODM);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.name).toContain('Session::__class_metadata');
        });

        it('should create a synthetic __class_metadata chunk for API Platform entity', () => {
            const chunks = parseAndExtract(API_PLATFORM);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.name).toContain('Product::__class_metadata');
        });

        it('should NOT create a synthetic chunk for a pure POPO class (no ORM annotations)', () => {
            const chunks = parseAndExtract(PURE_POPO);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeUndefined();
        });

        it('should NOT create a synthetic chunk for a repository class (not an entity)', () => {
            const chunks = parseAndExtract(PURE_REPO);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeUndefined();
        });
    });

    // ─── Synthetic Chunk Content ─────────────────────────────────────────

    describe('Synthetic chunk content', () => {
        it('should include class-level annotations in the synthetic chunk (DocBlock)', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('@ORM\\Table(name="order_records")');
            expect(metaChunk.sourceCode).toContain('@ORM\\Entity');
        });

        it('should include PHP 8 attributes in the synthetic chunk', () => {
            const chunks = parseAndExtract(DOCTRINE_PHP8);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('#[ORM\\Table(name: "order_records")]');
            expect(metaChunk.sourceCode).toContain('#[ORM\\Entity');
        });

        it('should include property declarations in the synthetic chunk', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('protected $id');
            expect(metaChunk.sourceCode).toContain('protected $customerId');
        });

        it('should include property-level ORM annotations in the synthetic chunk', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('@ORM\\Column(name="customer_id"');
        });

        it('should include constants in the synthetic chunk', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain("const STATUS_PENDING = 'pending'");
        });

        it('should include class declaration with extends and implements', () => {
            const chunks = parseAndExtract(LARAVEL_MODEL);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('class DeliveryOrder extends Model');
        });

        it('should include Laravel $table property in the synthetic chunk', () => {
            const chunks = parseAndExtract(LARAVEL_MODEL);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain("protected $table = 'delivery_orders'");
        });

        it('should NOT include method bodies in the synthetic chunk', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).not.toContain('function getId()');
            expect(metaChunk.sourceCode).not.toContain('return $this->id');
            expect(metaChunk.sourceCode).not.toContain('function setCustomerId');
        });

        it('should include the ORM marker comment for Gate 1 matching', () => {
            const chunks = parseAndExtract(LARAVEL_MODEL);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.sourceCode).toContain('// ORM entity');
        });
    });

    // ─── Namespace Qualification ─────────────────────────────────────────

    describe('Namespace qualification', () => {
        it('should qualify the synthetic chunk name with the PHP namespace', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.name).toBe('App\\Entity\\OrderRecord::__class_metadata');
        });

        it('should handle classes without a namespace', () => {
            const noNamespace = `<?php
/**
 * @ORM\\Entity
 * @ORM\\Table(name="legacy_items")
 */
class LegacyItem
{
    protected $id;
    public function getId() { return $this->id; }
}`;
            const chunks = parseAndExtract(noNamespace);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;

            expect(metaChunk.name).toBe('LegacyItem::__class_metadata');
        });
    });

    // ─── Heuristic Filter Integration ────────────────────────────────────

    describe('Heuristic filter integration', () => {
        it('should pass Gate 6 for Doctrine DocBlock entity metadata', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;
            const verdict = likelyHasIOWithTaint(metaChunk);

            expect(verdict.passed).toBe(true);
            if (verdict.passed) {
                expect(verdict.gate).toBe(3);
                expect(verdict.reason).toBe('synthetic-chunk:orm-metadata');
            }
        });

        it('should pass Gate 6 for PHP 8 attribute entity metadata', () => {
            const chunks = parseAndExtract(DOCTRINE_PHP8);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;
            const verdict = likelyHasIOWithTaint(metaChunk);

            expect(verdict.passed).toBe(true);
            if (verdict.passed) {
                expect(verdict.gate).toBe(3);
                expect(verdict.reason).toBe('synthetic-chunk:orm-metadata');
            }
        });

        it('should pass Gate 6 for Laravel Eloquent model metadata', () => {
            const chunks = parseAndExtract(LARAVEL_MODEL);
            const metaChunk = findChunk(chunks, '::__class_metadata')!;
            const verdict = likelyHasIOWithTaint(metaChunk);

            expect(verdict.passed).toBe(true);
            if (verdict.passed) {
                expect(verdict.gate).toBe(3);
                expect(verdict.reason).toBe('synthetic-chunk:orm-metadata');
            }
        });

        it('should still reject individual getter methods (no context bleeding)', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const getIdChunk = findChunk(chunks, '.getId');

            expect(getIdChunk).toBeDefined();
            const verdict = likelyHasIOWithTaint(getIdChunk!);
            expect(verdict.passed).toBe(false);
        });

        it('should still reject individual setter methods', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const setChunk = findChunk(chunks, '.setCustomerId');

            expect(setChunk).toBeDefined();
            const verdict = likelyHasIOWithTaint(setChunk!);
            expect(verdict.passed).toBe(false);
        });

        it('should still reject pure boolean check methods', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const isPendingChunk = findChunk(chunks, '.isPending');

            expect(isPendingChunk).toBeDefined();
            const verdict = likelyHasIOWithTaint(isPendingChunk!);
            expect(verdict.passed).toBe(false);
        });
    });

    // ─── Coexistence ─────────────────────────────────────────────────────

    describe('Synthetic + method chunks coexistence', () => {
        it('should produce both synthetic metadata and individual method chunks', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);

            // Synthetic chunk exists
            const metaChunk = findChunk(chunks, '::__class_metadata');
            expect(metaChunk).toBeDefined();

            // Method chunks also exist (even though they'll be filtered downstream)
            const getIdChunk = findChunk(chunks, '.getId');
            const setChunk = findChunk(chunks, '.setCustomerId');
            expect(getIdChunk).toBeDefined();
            expect(setChunk).toBeDefined();
        });

        it('should correctly count: 1 synthetic + N methods for a Doctrine entity', () => {
            const chunks = parseAndExtract(DOCTRINE_DOCBLOCK);
            const syntheticChunks = chunks.filter(c => c.name.includes('::__class_metadata'));
            const methodChunks = chunks.filter(c => !c.name.includes('::'));

            expect(syntheticChunks.length).toBe(1);
            // getId, setCustomerId, isPending, __construct = at least 3 methods (constructor may vary)
            expect(methodChunks.length).toBeGreaterThanOrEqual(3);
        });
    });

    // ─── Edge Cases ──────────────────────────────────────────────────────

    describe('Edge cases', () => {
        it('should handle a class with only properties and no methods', () => {
            const onlyProps = `<?php
/**
 * @ORM\\Entity
 * @ORM\\Table(name="metadata")
 */
class Metadata
{
    /** @ORM\\Column(type="string") */
    protected $key;

    /** @ORM\\Column(type="text") */
    protected $value;
}`;
            const chunks = parseAndExtract(onlyProps);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.sourceCode).toContain('protected $key');
            expect(metaChunk!.sourceCode).toContain('protected $value');
        });

        it('should handle Laravel model with fully qualified base class', () => {
            const fqcn = `<?php
class Order extends \\Illuminate\\Database\\Eloquent\\Model
{
    protected $table = 'orders';
    public function getTotal() { return $this->total; }
}`;
            const chunks = parseAndExtract(fqcn);
            const metaChunk = findChunk(chunks, '::__class_metadata');

            expect(metaChunk).toBeDefined();
            expect(metaChunk!.sourceCode).toContain('extends');
            expect(metaChunk!.sourceCode).toContain("$table = 'orders'");
        });
    });

    // ─── extractStaticInfra — Deterministic Table Extraction ─────────────

    describe('extractStaticInfra()', () => {
        function extractStatic(code: string) {
            const tree = parser.parse(code);
            const chunks = plugin.extractFunctions(tree, code, 'test.php');
            const metaChunk = findChunk(chunks, '::__class_metadata');
            if (!metaChunk) return { chunk: null, result: null };
            return { chunk: metaChunk, result: plugin.extractStaticInfra(tree.rootNode, metaChunk) };
        }

        it('should extract table name from single-line @ORM\\Table(name="...")', () => {
            const { result } = extractStatic(DOCTRINE_DOCBLOCK);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('order_records');
            expect(result!.infrastructure[0].type).toBe('Database');
            expect(result!.infrastructure[0].operation).toBe('MAPS_TO');
            expect(result!.intent).toContain('order_records');
            expect(result!.intent).toContain('Doctrine');
        });

        it('should extract table name from multiline @ORM\\Table DocBlock (anonymised real-world fixture, acme.example)', () => {
            // This is the EXACT pattern from the anonymised real-world fixture (acme.example):
            // @ORM\Table(
            //  *     name="records",
            //  *     indexes={...}
            // )
            const multiline = `<?php
namespace Acme\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
/**
 * @ORM\\Table(
 *     name="records",
 *     indexes={
 *         @ORM\\Index(name="idx_external", columns={"external_id", "slug"})
 *     }
 * )
 * @ORM\\Entity(repositoryClass="Acme\\Repository\\RecordRepository")
 * @ORM\\HasLifecycleCallbacks()
 */
class Record
{
    /** @ORM\\Column(name="id", type="bigint") */
    protected $id;
    /** @ORM\\Column(name="external_id", type="bigint") */
    protected $externalId;
    public function getId() { return $this->id; }
}`;
            const { result } = extractStatic(multiline);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('records');
            expect(result!.intent).toContain("'records'");
        });

        it('should extract table name from PHP 8 #[ORM\\Table(name: "...")] attribute', () => {
            const { result } = extractStatic(DOCTRINE_PHP8);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('order_records');
            expect(result!.intent).toContain('Doctrine');
        });

        it('should extract table name from Laravel protected $table property', () => {
            const { result } = extractStatic(LARAVEL_MODEL);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('delivery_orders');
            expect(result!.intent).toContain('Eloquent');
        });

        it('should fall back to snake_case(className) for Doctrine entity without explicit table name', () => {
            const noTableName = `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
/**
 * @ORM\\Entity
 */
class OrderItem
{
    /** @ORM\\Column(type="integer") */
    protected $quantity;
}`;
            const { result } = extractStatic(noTableName);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('order_item');
        });

        it('should fall back to snake_case + pluralize for Eloquent model without $table', () => {
            const noTableProp = `<?php
use Illuminate\\Database\\Eloquent\\Model;
class OrderPolicy extends Model
{
    protected $fillable = ['name'];
}`;
            const { result } = extractStatic(noTableProp);
            expect(result).not.toBeNull();
            expect(result!.infrastructure[0].name).toBe('order_policies');
            expect(result!.intent).toContain('Eloquent');
        });

        it('should return null for non-metadata chunks', () => {
            const tree = parser.parse(DOCTRINE_DOCBLOCK);
            const chunks = plugin.extractFunctions(tree, DOCTRINE_DOCBLOCK, 'test.php');
            const getIdChunk = findChunk(chunks, '.getId');
            expect(getIdChunk).toBeDefined();
            const result = plugin.extractStaticInfra(tree.rootNode, getIdChunk!);
            expect(result).toBeNull();
        });

        it('should return null for a pure POPO class (no ORM)', () => {
            const tree = parser.parse(PURE_POPO);
            const chunks = plugin.extractFunctions(tree, PURE_POPO, 'test.php');
            const metaChunk = findChunk(chunks, '::__class_metadata');
            // No metadata chunk should exist for a POPO
            expect(metaChunk).toBeUndefined();
        });

        it('should include orm-entity capability and NOT include database-writer', () => {
            const { result } = extractStatic(DOCTRINE_DOCBLOCK);
            expect(result).not.toBeNull();
            expect(result!.capabilities).toContain('orm-entity');
            expect(result!.capabilities).not.toContain('database-writer');
        });

        it('should set has_io to true', () => {
            const { result } = extractStatic(DOCTRINE_DOCBLOCK);
            expect(result).not.toBeNull();
            expect(result!.has_io).toBe(true);
        });
    });
});

