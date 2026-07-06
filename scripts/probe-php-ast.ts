import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import { patchLanguage } from '../src/ingestion/processors/parser/jsc-compat.js';
const parser = new Parser();
parser.setLanguage(patchLanguage(phpExport.php));
const src = `<?php
class A {
    private const ROUTE = 'topic.a.placed';
    public function map(): array {
        return [ MessageA::class => ['routing_key' => self::ROUTE] ];
    }
}`;
const tree = parser.parse(src);
function dump(node: any, depth = 0): void {
    console.log(' '.repeat(depth*2) + node.type + (node.childCount === 0 ? ' :: ' + JSON.stringify(node.text.slice(0,40)) : ''));
    for (const c of node.children) dump(c, depth+1);
}
dump(tree.rootNode);
