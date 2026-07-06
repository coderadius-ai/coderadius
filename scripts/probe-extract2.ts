import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../src/ingestion/processors/parser/jsc-compat.js';
import { extractMessageClassRoutingTable } from '../src/ingestion/core/languages/php/message-class-routing-extractor.js';
const parser = new Parser();
parser.setLanguage(patchLanguage(phpExport.php));
// Just class A alone:
const srcAOnly = `<?php
class A {
    private const ROUTE = 'topic.a.placed';
    public function map(): array {
        return [ MessageA::class => ['routing_key' => self::ROUTE] ];
    }
}`;
console.log("A only:", [...extractMessageClassRoutingTable(parser.parse(srcAOnly).rootNode).entries()]);

// Two classes minimal:
const srcAB = `<?php
class A {
    private const ROUTE = 'topic.a.placed';
    public function map(): array {
        return [ MessageA::class => ['routing_key' => self::ROUTE] ];
    }
}
class B {}`;
console.log("AB:", [...extractMessageClassRoutingTable(parser.parse(srcAB).rootNode).entries()]);

// Two classes both with content:
const srcBoth = `<?php
class A {
    private const ROUTE = 'topic.a.placed';
    public function map(): array {
        return [ MessageA::class => ['routing_key' => self::ROUTE] ];
    }
}
class B {
    private const ROUTE = 'topic.b.placed';
}`;
console.log("Both:", [...extractMessageClassRoutingTable(parser.parse(srcBoth).rootNode).entries()]);
