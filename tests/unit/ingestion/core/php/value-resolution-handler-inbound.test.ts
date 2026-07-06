import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { extractPhpCriticalInvocations } from '../../../../../src/ingestion/core/languages/php/value-resolution.js';
import { patchLanguage } from '../../../../../src/ingestion/processors/parser/jsc-compat.js';

// Handler-parameter messageClass critical-invocation extraction (Fix 1).
//
// Without this signal, the LLM has no canonical-routing-key context for
// Messenger handlers and falls back to extracting from log message strings
// ("Consuming save.requested" → wrong canonical). With it, the handler's
// typed parameter triggers SymfonyMessenger.routing.<Class> lookup just
// like dispatch sites do.

let parser: Parser;

beforeAll(() => {
    parser = new Parser();
    parser.setLanguage(patchLanguage(phpExport.php));
});

function parse(src: string): Parser.SyntaxNode {
    return parser.parse(src).rootNode;
}

function findHandlerInvocation(facts: ReturnType<typeof extractPhpCriticalInvocations>) {
    return facts.find(f => f.resourceRole === 'messageClass' && f.operation === 'READS');
}

describe('extractPhpCriticalInvocations — handler-inbound', () => {
    it('emits messageClass READS for legacy __invoke(QuoteMessage)', () => {
        const src = `<?php
        namespace Acme\\Inventory\\Handler;
        use Acme\\Inventory\\Message\\QuoteMessage;
        class QuoteHandler {
            public function __invoke(QuoteMessage $message): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/Handler/QuoteHandler.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('QuoteMessage');
        expect(handler!.operation).toBe('READS');
        expect(handler!.resourceType).toBe('MessageChannel');
    });

    it('emits messageClass READS for modern method with #[AsMessageHandler]', () => {
        const src = `<?php
        namespace Acme\\Inventory\\Handler;
        use Acme\\Inventory\\Message\\OrderShipped;
        use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;
        class ShipmentHandler {
            #[AsMessageHandler]
            public function handle(OrderShipped $event): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/Handler/ShipmentHandler.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('OrderShipped');
    });

    it('emits for any method name when #[AsMessageHandler] is present (handle, process, anything)', () => {
        const src = `<?php
        namespace Acme;
        use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;
        class CustomHandler {
            #[AsMessageHandler]
            public function processMessage(QuoteCommand $cmd): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/CustomHandler.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('QuoteCommand');
    });

    it('does NOT emit for __invoke when parameter type lacks CQRS suffix (legacy heuristic guard)', () => {
        const src = `<?php
        namespace Acme;
        class NotAHandler {
            public function __invoke(SomeDomainObject $obj): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/NotAHandler.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeUndefined();
    });

    it('does NOT emit for non-__invoke methods without #[AsMessageHandler]', () => {
        const src = `<?php
        namespace Acme;
        class Service {
            public function handle(QuoteMessage $msg): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/Service.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeUndefined();
    });

    it('does NOT emit when __invoke has no typed first parameter', () => {
        const src = `<?php
        namespace Acme;
        class C {
            public function __invoke($untypedMessage): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/C.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeUndefined();
    });

    it('extracts the bare class name even when the parameter type uses a FQCN backslash form', () => {
        const src = `<?php
        namespace Acme\\Inventory\\Handler;
        class SaveHandler {
            public function __invoke(\\Acme\\Inventory\\Message\\SaveMessage $message): void {}
        }`;
        const facts = extractPhpCriticalInvocations(parse(src), src, 'src/Handler/SaveHandler.php');
        const handler = findHandlerInvocation(facts);
        expect(handler).toBeDefined();
        expect(handler!.resourceExpression).toBe('SaveMessage');
    });
});
