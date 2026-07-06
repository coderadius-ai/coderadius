import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../../../../../../src/ingestion/processors/parser/jsc-compat.js';
import {
    extractPhpComponentDefinitions,
    extractPhpDependencyRequirements,
} from '../../../../../../src/ingestion/core/languages/php/component-extraction.js';

const parser = new Parser();
parser.setLanguage(patchLanguage(phpExport.php));

function parse(src: string) {
    return parser.parse(src).rootNode;
}

describe('extractPhpComponentDefinitions', () => {
    it('extracts a class with namespace', () => {
        const root = parse(`<?php
namespace Acme\\Messaging;

class NotificationPublisher {
    public function publish(string $payload): void {}
    public function retry(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/NotificationPublisher.php');
        expect(defs).toHaveLength(1);
        expect(defs[0].fqcn).toBe('Acme\\Messaging\\NotificationPublisher');
        expect(defs[0].file).toBe('src/NotificationPublisher.php');
        expect(defs[0].operations.map(o => o.name)).toEqual(['publish', 'retry']);
    });

    it('normalizes method names to lowercase (PHP case-insensitivity)', () => {
        const root = parse(`<?php
class Publisher {
    public function PUBLISH(): void {}
    public function Retry(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/Publisher.php');
        expect(defs[0].operations.map(o => o.name)).toEqual(['publish', 'retry']);
    });

    it('captures ordered constructor parameter names (all params, incl. scalars)', () => {
        // The ordered names let the DI resolver map a positional ctor scalar
        // (e.g. arg index 1 = a topic literal) to the param it fills ($topic).
        const root = parse(`<?php
namespace Acme\\Streaming;

class StreamingPublisher {
    private string $topic;
    public function __construct(
        \\Google\\Cloud\\PubSub\\PubSubClient $pubSubClient,
        string $topic,
        \\Psr\\Log\\LoggerInterface $logger
    ) {
        $this->topic = $topic;
    }
    public function publish(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/StreamingPublisher.php');
        expect(defs).toHaveLength(1);
        expect(defs[0].constructorParameterNames).toEqual(['pubSubClient', 'topic', 'logger']);
    });

    it('handles a class in the global namespace', () => {
        const root = parse(`<?php
class GlobalThing {
    public function go(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/GlobalThing.php');
        expect(defs).toHaveLength(1);
        expect(defs[0].fqcn).toBe('GlobalThing');
    });

    it('extracts declared interfaces (implements clause)', () => {
        const root = parse(`<?php
namespace Acme\\Messaging;

use Acme\\Contracts\\PublisherInterface;

class NotificationPublisher implements PublisherInterface {
    public function publish(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/X.php');
        // Plan v10 P1 fix #5: declaredInterfaces are now resolved through
        // `use` aliases. `PublisherInterface` imports `Acme\Contracts\...`,
        // so the resolved FQCN is the imported one, not the current ns.
        expect(defs[0].declaredInterfaces).toContain('Acme\\Contracts\\PublisherInterface');
    });

    it('records source line ranges per operation', () => {
        const root = parse(`<?php
class Publisher {
    public function publish(): void {
    }

    public function retry(): void {}
}
`);
        const defs = extractPhpComponentDefinitions(root, 'src/Publisher.php');
        const pub = defs[0].operations.find(o => o.name === 'publish')!;
        expect(pub.range.startLine).toBeGreaterThan(0);
        expect(pub.range.endLine).toBeGreaterThanOrEqual(pub.range.startLine);
    });

    it('handles interface and trait declarations', () => {
        const root = parse(`<?php
namespace Acme;
interface Producer { public function emit(): void; }
trait HasLogger { public function log(string $msg): void {} }
`);
        const defs = extractPhpComponentDefinitions(root, 'src/X.php');
        const names = defs.map(d => d.fqcn);
        expect(names).toContain('Acme\\Producer');
        expect(names).toContain('Acme\\HasLogger');
    });

    it('returns [] when no class/interface/trait is present', () => {
        const root = parse(`<?php
$x = 1;
function foo() { return 2; }
`);
        const defs = extractPhpComponentDefinitions(root, 'src/X.php');
        expect(defs).toEqual([]);
    });
});

describe('extractPhpDependencyRequirements', () => {
    it('extracts constructor parameter with FQCN type', () => {
        const root = parse(`<?php
namespace Acme\\Messaging;

class NotificationPublisher {
    public function __construct(
        \\Psr\\Log\\LoggerInterface $logger,
    ) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs).toHaveLength(1);
        expect(reqs[0]).toMatchObject({
            ownerComponent: 'Acme\\Messaging\\NotificationPublisher',
            parameterName: 'logger',
            requiredType: 'Psr\\Log\\LoggerInterface',
            isAbstractType: true,
        });
    });

    it('qualifies bare type names to the current namespace', () => {
        const root = parse(`<?php
namespace Acme\\Messaging;

class NotificationPublisher {
    public function __construct(PublisherInterface $pub) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs[0].requiredType).toBe('Acme\\Messaging\\PublisherInterface');
        expect(reqs[0].isAbstractType).toBe(true);
    });

    it('skips untyped parameters', () => {
        const root = parse(`<?php
class Publisher {
    public function __construct($name, $thing) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs).toEqual([]);
    });

    it('skips primitive types', () => {
        const root = parse(`<?php
class Publisher {
    public function __construct(string $name, int $port) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs).toEqual([]);
    });

    it('extracts multiple parameters from one constructor', () => {
        const root = parse(`<?php
namespace Acme;

class Service {
    public function __construct(
        LoggerInterface $logger,
        Mailer $mailer,
    ) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs.map(r => r.parameterName).sort()).toEqual(['logger', 'mailer']);
        const logger = reqs.find(r => r.parameterName === 'logger')!;
        const mailer = reqs.find(r => r.parameterName === 'mailer')!;
        expect(logger.isAbstractType).toBe(true);
        expect(mailer.isAbstractType).toBe(false);  // concrete class name
    });

    it('extracts promoted constructor properties', () => {
        const root = parse(`<?php
namespace Acme;

class Service {
    public function __construct(
        private LoggerInterface $logger,
        public Mailer $mailer,
    ) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs).toHaveLength(2);
    });

    it('returns [] when the class has no constructor', () => {
        const root = parse(`<?php
class Plain {
    public function do(): void {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs).toEqual([]);
    });

    it('marks Abstract* / *Contract types as abstract', () => {
        const root = parse(`<?php
namespace Acme;

class Service {
    public function __construct(
        AbstractGateway $gateway,
        PaymentContract $payment,
    ) {}
}
`);
        const reqs = extractPhpDependencyRequirements(root, 'src/X.php');
        expect(reqs.every(r => r.isAbstractType)).toBe(true);
    });
});
