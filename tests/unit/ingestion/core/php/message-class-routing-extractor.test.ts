import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { extractMessageClassRoutingTable } from '../../../../../src/ingestion/core/languages/php/message-class-routing-extractor.js';
import { patchLanguage } from '../../../../../src/ingestion/processors/parser/jsc-compat.js';

let parser: Parser;

beforeAll(() => {
    parser = new Parser();
    parser.setLanguage(patchLanguage(phpExport.php));
});

function parse(src: string): Parser.SyntaxNode {
    return parser.parse(src).rootNode;
}

describe('extractMessageClassRoutingTable', () => {
    it('extracts CQRS class -> topic from an inner array with routing_key', () => {
        const src = `<?php
        class AmqpConfig {
            public function getMessageMap(): array {
                return [
                    QuoteMessage::class => [
                        'routing_key' => 'acme.inventory.quote.requested',
                        'queue_name' => 'acme.inventory.quote.requested',
                    ],
                    SaveMessage::class => [
                        'queue_name' => 'acme.inventory.save.requested',
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('QuoteMessage')).toBe('acme.inventory.quote.requested');
        expect(result.get('SaveMessage')).toBe('acme.inventory.save.requested');
    });

    it('extracts CQRS class -> topic from a direct string value (no inner array)', () => {
        const src = `<?php
        class AmqpConfig {
            public function topics(): array {
                return [
                    OrderPlacedEvent::class => 'acme.orders.placed',
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedEvent')).toBe('acme.orders.placed');
    });

    it('resolves binary concatenation with environment variable as {var} placeholder', () => {
        const src = `<?php
        class AmqpConfig {
            public function getMessageMap(): array {
                $envSuffix = $this->getEnvSuffix();
                return [
                    QuoteMessage::class => [
                        'routing_key' => 'acme.inventory' . $envSuffix . '.quote.requested',
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('QuoteMessage')).toBe('acme.inventory{envSuffix}.quote.requested');
    });

    it('skips entries where inner value is a class reference (DI handler map)', () => {
        const src = `<?php
        class HandlerMap {
            public function map(): array {
                return [
                    QuoteMessage::class => [
                        'handler' => QuoteMessageHandler::class,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.has('QuoteMessage')).toBe(false);
    });

    it('skips array keys that are NOT CQRS-named classes', () => {
        const src = `<?php
        class GenericMap {
            public function map(): array {
                return [
                    Logger::class => 'log.audit.write',
                    HttpClient::class => 'http.client.outbound',
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.size).toBe(0);
    });

    it('returns empty when no return-array maps CQRS classes', () => {
        const src = `<?php
        class Service {
            public function doSomething(): void {}
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.size).toBe(0);
    });

    it('handles multiple env vars in concatenation chain', () => {
        const src = `<?php
        class AmqpConfig {
            public function map(): array {
                return [
                    FooEvent::class => [
                        'routing_key' => 'prefix.' . $env . '.middle.' . $tenant . '.suffix',
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('FooEvent')).toBe('prefix.{env}.middle.{tenant}.suffix');
    });

    it('returns bare class name even when key uses backslash-prefixed FQCN', () => {
        const src = `<?php
        class AmqpConfig {
            public function map(): array {
                return [
                    \\Acme\\Message\\QuoteCommand::class => [
                        'topic' => 'acme.quote.requested',
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('QuoteCommand')).toBe('acme.quote.requested');
    });

    it('rejects values without a dot (single-word strings are not topics)', () => {
        const src = `<?php
        class StatusMap {
            public function statuses(): array {
                return [
                    OrderEvent::class => 'placed',
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.has('OrderEvent')).toBe(false);
    });
});
