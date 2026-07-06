import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../src/ingestion/processors/parser/jsc-compat.js';
import { extractMessageClassRoutingTable } from '../src/ingestion/core/languages/php/message-class-routing-extractor.js';
const parser = new Parser();
parser.setLanguage(patchLanguage(phpExport.php));
const src = `<?php
class A {
    private const ROUTE = 'topic.a.placed';
    public function map(): array {
        return [ MessageA::class => ['routing_key' => self::ROUTE] ];
    }
}
class B {
    private const ROUTE = 'topic.b.placed';
    public function map(): array {
        return [ MessageB::class => ['routing_key' => self::ROUTE] ];
    }
}`;
const tree = parser.parse(src);
const result = extractMessageClassRoutingTable(tree.rootNode);
console.log("Result:", [...result.entries()]);

// Also single-class works case 1:
const src2 = `<?php
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
const tree2 = parser.parse(src2);
const result2 = extractMessageClassRoutingTable(tree2.rootNode);
console.log("Single class result:", [...result2.entries()]);
