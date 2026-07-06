import { describe, it, expect } from 'vitest';
import type Parser from 'tree-sitter';
import type { CodeChunk } from '../../../../src/graph/types.js';
import type { ImportContext } from '../../../../src/ingestion/core/languages/types.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';

const plugin = new PHPPlugin();
const parser = plugin.createParser();

function parseTree(source: string) {
    return parser.parse(source);
}

function parseRoot(source: string): Parser.SyntaxNode {
    return parseTree(source).rootNode;
}

function makeContext(
    filePath: string,
    allFilePaths: string[],
    dependencyMappings: Array<{ prefix: string; directory: string }> = [],
): ImportContext {
    return {
        filePath,
        allFilePaths: new Set(allFilePaths),
        dependencyMappings,
    };
}

function makeChunk(name: string, sourceCode: string): CodeChunk {
    return {
        name,
        filepath: 'test.php',
        sourceCode,
        language: 'php',
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
    };
}

describe('PHPPlugin facade smoke', () => {
    it('returns stable promptHints markers', () => {
        const hints = plugin.promptHints();
        expect(hints).toContain('<php_rules>');
        expect(hints).toContain('HTTP CLIENTS');
        expect(hints).toContain('WORDPRESS');
    });
});

describe('PHPPlugin.extractFunctions', () => {
    it('includes preceding comments on namespaced functions and methods', () => {
        const source = `<?php
namespace App\\Service;

// function docs
function runTask() {
    return true;
}

class Worker {
    /* method docs */
    public function process() {
        return true;
    }
}`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/Worker.php');
        const functionChunk = chunks.find(chunk => chunk.name === 'App\\Service\\runTask');
        const methodChunk = chunks.find(chunk => chunk.name === 'App\\Service\\Worker.process');

        expect(functionChunk?.sourceCode.startsWith('// function docs')).toBe(true);
        expect(methodChunk?.sourceCode.startsWith('/* method docs */')).toBe(true);
    });

    it('emits ::main chunk with deduped env vars for top-level IO scripts', () => {
        const source = `<?php
$payload = mysqli_query($db, 'SELECT * FROM users');
$env = getenv('APP_ENV');
$host = $_SERVER['HTTP_HOST'];
$dup = getenv('APP_ENV');
echo $payload . $env . $host . $dup;
`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'scripts/bootstrap.php');
        const mainChunk = chunks.find(chunk => chunk.name === 'bootstrap::main');

        expect(mainChunk).toBeDefined();
        expect(mainChunk?.envVars).toEqual(['APP_ENV', 'HTTP_HOST']);
    });

    it('skips ::main chunk when top-level procedural code has no IO signal', () => {
        const source = `<?php
$x = 1;
$y = 2;
echo $x + $y;
`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'scripts/math.php');
        expect(chunks.find(chunk => chunk.name === 'math::main')).toBeUndefined();
    });

    it('emits legacy filesystem route chunk when no framework route exists', () => {
        const source = `<?php
$id = $_GET['id'] ?? null;
header('Content-Type: application/json');
echo json_encode(['id' => $id, 'ok' => true, 'message' => 'legacy endpoint']);
`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'legacy.php');
        expect(chunks.map(chunk => chunk.name)).toContain('GET /legacy.php::__route_handler');
    });

    it('does not emit legacy route chunk when legacy detector returns null', () => {
        const source = `<?php
$payload = mysqli_query($db, 'SELECT * FROM jobs');
$env = getenv('APP_ENV');
$result = [$payload, $env, 'cli-like script with no request or response signals'];
`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'jobs.php');
        expect(chunks.find(chunk => chunk.name === 'GET /jobs.php::__route_handler')).toBeUndefined();
    });

    it('suppresses legacy filesystem route when framework routes already exist', () => {
        const source = `<?php
use Slim\\Factory\\AppFactory;
$app = AppFactory::create();
$app->get('/ping', PingHandler::class);
$id = $_GET['id'] ?? null;
echo json_encode(['id' => $id, 'ok' => true, 'message' => 'should not become legacy']);
`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'index.php');
        expect(chunks.map(chunk => chunk.name)).toContain('GET /ping::__route_handler');
        expect(chunks.map(chunk => chunk.name)).not.toContain('GET /index.php::__route_handler');
    });

    it('does not create metadata chunk for non-ORM class with plain preceding comment', () => {
        const source = `<?php
/** Plain docs, no ORM */
class UtilityService {
    public function handle() {
        return true;
    }
}`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/UtilityService.php');
        expect(chunks.find(chunk => chunk.name.endsWith('::__class_metadata'))).toBeUndefined();
    });

    it('includes interface clause in ORM metadata chunk source', () => {
        const source = `<?php
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class PersistedJob extends Model implements JsonSerializable
{
    protected $table = 'persisted_jobs';
    const TYPE = 'job';
}`;

        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/PersistedJob.php');
        const metadataChunk = chunks.find(chunk => chunk.name.endsWith('::__class_metadata'));

        expect(metadataChunk?.sourceCode).toContain('implements JsonSerializable');
        expect(metadataChunk?.sourceCode).toContain("const TYPE = 'job';");
    });
});

describe('PHPPlugin.extractStaticInfra', () => {
    it('returns null for malformed route handler chunk names', () => {
        expect(plugin.extractStaticInfra(parseRoot('<?php'), makeChunk('BROKEN::__route_handler', '/* php route: GET /broken */'))).toBeNull();
    });

    it('defaults route framework to php when source comment has no framework label', () => {
        const result = plugin.extractStaticInfra(parseRoot('<?php'), makeChunk('GET /fallback::__route_handler', '/* comment without route marker */'));
        expect(result?.emergent_api_calls[0].framework).toBe('php');
    });

    it('extracts MongoDB collection names from metadata chunks', () => {
        const source = `<?php
use Doctrine\\ODM\\MongoDB\\Mapping\\Annotations as MongoDB;

#[MongoDB\\Document(collection: 'sessions')]
class SessionDocument
{
    protected string $id;
}`;
        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/SessionDocument.php');
        const metadataChunk = chunks.find(chunk => chunk.name.endsWith('::__class_metadata'));
        const result = plugin.extractStaticInfra(parseRoot(source), metadataChunk!);

        expect(result?.infrastructure[0].name).toBe('sessions');
        expect(result?.intent).toContain('MongoDB ODM');
    });

    it('extracts Eloquent collection names from $collection properties', () => {
        const source = `<?php
use Illuminate\\Database\\Eloquent\\Model;

class PaymentDocument extends Model
{
    protected $collection = 'payments';
}`;
        const chunks = plugin.extractFunctions(parseTree(source), source, 'src/PaymentDocument.php');
        const metadataChunk = chunks.find(chunk => chunk.name.endsWith('::__class_metadata'));
        const result = plugin.extractStaticInfra(parseRoot(source), metadataChunk!);

        expect(result?.infrastructure[0].name).toBe('payments');
        expect(result?.intent).toContain('Eloquent');
    });

    it('uses naive pluralization fallback for es and s suffixes', () => {
        const busSource = `<?php
use Illuminate\\Database\\Eloquent\\Model;
class Bus extends Model {}`;
        const busChunk = plugin.extractFunctions(parseTree(busSource), busSource, 'src/Bus.php')
            .find(chunk => chunk.name.endsWith('::__class_metadata'))!;
        expect(plugin.extractStaticInfra(parseRoot(busSource), busChunk)?.infrastructure[0].name).toBe('buses');

        const orderSource = `<?php
use Illuminate\\Database\\Eloquent\\Model;
class Order extends Model {}`;
        const orderChunk = plugin.extractFunctions(parseTree(orderSource), orderSource, 'src/Order.php')
            .find(chunk => chunk.name.endsWith('::__class_metadata'))!;
        expect(plugin.extractStaticInfra(parseRoot(orderSource), orderChunk)?.infrastructure[0].name).toBe('orders');
    });
});

describe('PHPPlugin.extractEnvVars', () => {
    it('extracts getenv, $_ENV, $_SERVER and ignores dynamic access', () => {
        const root = parseRoot(`<?php
function config(string $key) {
    $a = getenv('APP_ENV');
    $b = $_ENV['CACHE_DRIVER'];
    $c = $_SERVER['HTTP_HOST'];
    $d = getenv($key);
    $e = $_ENV[$key];
}
`);

        const functionNode = root.children.find(child => child.type === 'function_definition')!;
        const envVars = plugin.extractEnvVars(functionNode);

        expect(envVars).toEqual(['APP_ENV', 'CACHE_DRIVER', 'HTTP_HOST']);
    });
});

describe('PHPPlugin import/export helpers', () => {
    it('extracts PSR-4 and legacy imports while skipping vendor, dynamic, and missing files', () => {
        const source = `<?php
use App\\Services\\HttpClient;
use Vendor\\Remote\\Service as RemoteService;
require_once __DIR__ . '/../Support/bootstrap.php';
require_once __DIR__ . '/../Support/missing.php';
require_once 'local.php';
include dirname(__FILE__) . '/helpers.php';
include 'vendor/autoload.php';
include './missing.php';
require_once $base . '/runtime.php';
require_once __DIR__ . $suffix;
require_once $dynamic;
`;
        const root = parseRoot(source);
        const imports = plugin.extractImports(root, makeContext(
            'src/Controller/UserController.php',
            ['src/Services/HttpClient.php', 'src/Support/bootstrap.php', 'src/Controller/helpers.php', 'src/Controller/local.php'],
            [{ prefix: 'App\\', directory: 'src' }],
        ));

        expect(imports).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'src/Services/HttpClient.php', specifiers: ['HttpClient'], isExternal: false }),
            expect.objectContaining({ source: 'Vendor\\Remote\\Service', specifiers: ['RemoteService'], isExternal: true }),
            expect.objectContaining({ source: 'src/Support/bootstrap.php', specifiers: ['*'], isExternal: false }),
            expect.objectContaining({ source: 'src/Controller/local.php', specifiers: ['*'], isExternal: false }),
            expect.objectContaining({ source: 'src/Controller/helpers.php', specifiers: ['*'], isExternal: false }),
        ]));
        expect(imports).toHaveLength(5);
    });

    it('returns empty import list for require statement with no resolvable argument', () => {
        const root = parseRoot('<?php require_once;');
        expect(plugin.extractImports(root, makeContext('broken.php', []))).toEqual([]);
    });

    it('extracts exports, raw import statements, aliases, and constructors from a class file', () => {
        const source = `<?php
use App\\Services\\HttpClient;
use Psr\\Log\\LoggerInterface;

function topLevelHelper() {}

class CheckoutService {
    private HttpClient $client;
    private string $label;

    public function __construct(
        private LoggerInterface $logger,
        private int $attempts,
        string $ignored
    ) {}
}`;
        const root = parseRoot(source);

        expect(plugin.extractExports(root)).toEqual(['topLevelHelper', 'CheckoutService']);
        expect(plugin.extractImportStatements(root)).toEqual([
            'use App\\Services\\HttpClient;',
            'use Psr\\Log\\LoggerInterface;',
        ]);
        expect(plugin.extractClassPropertyAliases(root)).toEqual([
            { propertyAccess: 'this->client', typeName: 'HttpClient' },
            { propertyAccess: 'this->logger', typeName: 'LoggerInterface' },
        ]);
        expect(plugin.extractConstructorSources(root).get('CheckoutService')).toContain('private LoggerInterface $logger');
    });

    it('extracts aliases for fully-qualified types and skips primitives', () => {
        const root = parseRoot(`<?php
class Mailer {
    private \\App\\Services\\Transport $transport;

    public function __construct(private \\App\\Contracts\\Logger $logger, private bool $verbose) {}
}`);

        expect(plugin.extractClassPropertyAliases(root)).toEqual([
            { propertyAccess: 'this->transport', typeName: 'Transport' },
            { propertyAccess: 'this->logger', typeName: 'Logger' },
        ]);
    });
});

describe('PHPPlugin type and constant helpers', () => {
    it('extracts mixed fallback properties and optional custom referenced types', () => {
        const root = parseRoot(`<?php
class PayloadBuilder {
    private $data;

    public function __construct(private $config, private ?FooResult $result, string $ignored) {}

    public function build(): ?FooResult {
        return $this->result;
    }
}`);

        const defs = plugin.extractTypeDefinitions(root);
        expect(defs.get('PayloadBuilder')?.properties).toEqual(expect.arrayContaining([
            { name: 'data', type: 'mixed' },
            { name: 'config', type: 'mixed' },
            { name: 'result', type: 'FooResult' },
        ]));

        const refs = plugin.extractReferencedTypes(root);
        expect(refs.get('PayloadBuilder.build')).toContain('FooResult');
    });

    it('extracts numeric constants and skips unsupported literal expressions', () => {
        const root = parseRoot(`<?php
const RETRIES = 3;
const LATENCY = 1.5;
const BAD = someCall();
class Cfg {
    const BACKOFF = 2;
    const ALSO_BAD = OTHER::VALUE;
}`);

        const constants = plugin.extractFileConstants(root);
        expect(constants).toContainEqual({ scope: '', name: 'RETRIES', value: '3' });
        expect(constants).toContainEqual({ scope: '', name: 'LATENCY', value: '1.5' });
        expect(constants).toContainEqual({ scope: 'Cfg', name: 'BACKOFF', value: '2' });
        expect(constants.find(item => item.name === 'BAD')).toBeUndefined();
        expect(constants.find(item => item.name === 'ALSO_BAD')).toBeUndefined();
    });

    it('skips double-quoted strings with complex interpolation syntax', () => {
        const root = parseRoot(`<?php
const TOPIC = "{$env}.result";
`);

        expect(plugin.extractFileConstants(root)).toEqual([]);
    });
});

describe('PHPPlugin.validateInboundPath', () => {
    it('accepts GraphQL field evidence from Webonyx-style field maps', () => {
        expect(plugin.validateInboundPath(
            'GRAPHQL QUERY userList',
            `FieldDefinition::create(['name' => 'userList', 'type' => $queryType]);`,
        )).toBe(true);
    });
});
