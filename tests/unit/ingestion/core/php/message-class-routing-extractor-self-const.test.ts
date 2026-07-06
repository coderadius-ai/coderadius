import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { extractMessageClassRoutingTable } from '../../../../../src/ingestion/core/languages/php/message-class-routing-extractor.js';
import { patchLanguage } from '../../../../../src/ingestion/processors/parser/jsc-compat.js';

// ═════════════════════════════════════════════════════════════════════════════
// Fix B (v8) — class-name bridge: resolve `self::CONST` and `$this->prop`
//
// AmqpConfig.php-style routing tables in many PHP codebases (orchestrator
// included) build routing keys via concatenation with class constants or
// `$this` properties, not raw string literals. Without resolving those, the
// LLM-emitted placeholder channel (named after the CQRS class, e.g.
// `NotPurchasableEvent`) is never bridged to the canonical routing key.
//
// Scope: same-class lookup only. Cross-class / `Other::CONST` / `$obj->prop`
// remain unresolved (return null, no crash). v8 P0-1 also pinned: skip in
// extractRoutingKey is now `::class` only, not all `class_constant_access`.
// ═════════════════════════════════════════════════════════════════════════════

let parser: Parser;
beforeAll(() => {
    parser = new Parser();
    parser.setLanguage(patchLanguage(phpExport.php));
});

function parse(src: string): Parser.SyntaxNode {
    return parser.parse(src).rootNode;
}

describe('extractMessageClassRoutingTable — self::CONST / $this->prop resolution', () => {
    it('Caso 1 (RED v8 P0-1): direct self::CONST as routing key (no concatenation)', () => {
        const src = `<?php
        class AmqpConfig {
            private const ORDER_PLACED = 'acme.inventory.order.placed';
            public function getMessageMap(): array {
                return [
                    OrderPlacedEvent::class => [
                        'routing_key' => self::ORDER_PLACED,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedEvent')).toBe('acme.inventory.order.placed');
    });

    it('Caso 1b: direct $this->prop as routing key (no concatenation)', () => {
        const src = `<?php
        class AmqpConfig {
            private string $orderRouteKey = 'acme.inventory.order.placed';
            public function getMessageMap(): array {
                return [
                    OrderPlacedEvent::class => [
                        'routing_key' => $this->orderRouteKey,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedEvent')).toBe('acme.inventory.order.placed');
    });

    it('Caso 2: concatenation literal + self::CONST', () => {
        const src = `<?php
        class AmqpConfig {
            private const ORDER_PLACED = 'order.placed';
            public function topics(): array {
                return [
                    OrderPlacedEvent::class => [
                        'routing_key' => 'acme.inventory' . '.' . self::ORDER_PLACED,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedEvent')).toBe('acme.inventory.order.placed');
    });

    it('Caso 3: $this->prefix . . self::SUFFIX both literal', () => {
        const src = `<?php
        class AmqpConfig {
            private string $routingPrefix = 'acme.inventory';
            private const SUFFIX = 'order.placed';
            public function topics(): array {
                return [
                    OrderPlacedEvent::class => [
                        'routing_key' => $this->routingPrefix . '.' . self::SUFFIX,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedEvent')).toBe('acme.inventory.order.placed');
    });

    it('Caso 4 (v5+v8 P1-5): two class declarations with same const name — nearest-ancestor scope', () => {
        const src = `<?php
        class AmqpConfigA {
            private const ROUTE = 'topic.a.placed';
            public function map(): array {
                return [ ChannelAMessage::class => ['routing_key' => self::ROUTE] ];
            }
        }
        class AmqpConfigB {
            private const ROUTE = 'topic.b.placed';
            public function map(): array {
                return [ ChannelBMessage::class => ['routing_key' => self::ROUTE] ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('ChannelAMessage')).toBe('topic.a.placed');
        expect(result.get('ChannelBMessage')).toBe('topic.b.placed');
    });

    it('Caso 5 (::class skip preserved): handler FQCN value is not interpreted as routing key', () => {
        const src = `<?php
        class HandlerMap {
            public function map(): array {
                return [
                    OrderPlacedMessage::class => [
                        'handler' => OrderPlacedHandler::class,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrderPlacedMessage')).toBeUndefined();
    });

    it('Caso 6 (self::CONST not declared): null, no crash', () => {
        const src = `<?php
        class AmqpConfig {
            public function map(): array {
                return [
                    OrphanEvent::class => [
                        'routing_key' => self::NOT_THERE,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('OrphanEvent')).toBeUndefined();
    });

    it('Caso 7 (cross-class out of scope): OtherClass::FOO returns null', () => {
        const src = `<?php
        class OtherClass {
            public const FOO = 'a.b.c';
        }
        class AmqpConfig {
            public function map(): array {
                return [
                    SomeEvent::class => [
                        'routing_key' => OtherClass::FOO,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        // OtherClass::FOO resolves to a literal in a OTHER class — out of scope.
        expect(result.get('SomeEvent')).toBeUndefined();
    });

    it('Caso 8 (cross-object out of scope): $other->prop returns null', () => {
        const src = `<?php
        class AmqpConfig {
            private OtherCfg $other;
            public function map(): array {
                return [
                    SomeEvent::class => [
                        'routing_key' => $this->other->prefix,
                    ],
                ];
            }
        }`;
        const result = extractMessageClassRoutingTable(parse(src));
        expect(result.get('SomeEvent')).toBeUndefined();
    });
});
