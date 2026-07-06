/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit Tests — Type Definition Extraction (Deep Mode)
 *
 * Tests for the new LanguagePlugin methods:
 *   - extractTypeDefinitions: Extracts class/interface/type property schemas
 *   - extractReferencedTypes: Extracts type references per function (params, return, new)
 *
 * These are pure AST tests — no LLM, no I/O, no network.
 *
 * Run with:
 *   npx vitest run tests/unit/type-definition-extraction.test.ts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import phpExport from 'tree-sitter-php';
import ts from 'tree-sitter-typescript';
import { PHPPlugin } from '../../src/ingestion/core/languages/php.js';
import { TypeScriptPlugin } from '../../src/ingestion/core/languages/typescript.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const php = (phpExport as any).php ?? phpExport;

function parsePHP(code: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(php as unknown as Parser.Language);
    const tree = parser.parse(`<?php\n${code}`);
    return tree.rootNode;
}

function parseTS(code: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(ts.typescript as unknown as Parser.Language);
    const tree = parser.parse(code);
    return tree.rootNode;
}

const phpPlugin = new PHPPlugin();
const tsPlugin = new TypeScriptPlugin();

// ═══════════════════════════════════════════════════════════════════════════════
// PHP: extractTypeDefinitions
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHP: extractTypeDefinitions', () => {
    it('extracts typed properties from a class', () => {
        const root = parsePHP(`
class QuoteRequestDTO {
    private string $plateNumber;
    private int $companyId;
    private \\DateTime $quoteDate;
}
`);
        const defs = phpPlugin.extractTypeDefinitions!(root);
        expect(defs.size).toBe(1);

        const dto = defs.get('QuoteRequestDTO');
        expect(dto).toBeDefined();
        expect(dto!.kind).toBe('class');
        expect(dto!.properties).toEqual(
            expect.arrayContaining([
                { name: 'plateNumber', type: 'string' },
                { name: 'companyId', type: 'int' },
            ]),
        );
        // Namespace-stripped: \DateTime → DateTime
        expect(dto!.properties.find(p => p.name === 'quoteDate')?.type).toBe('DateTime');
    });

    it('extracts constructor promoted properties', () => {
        const root = parsePHP(`
class UserDTO {
    public function __construct(
        private string $name,
        private int $age,
        private UserRole $role
    ) {}
}
`);
        const defs = phpPlugin.extractTypeDefinitions!(root);
        expect(defs.size).toBe(1);

        const dto = defs.get('UserDTO');
        expect(dto).toBeDefined();
        expect(dto!.properties).toHaveLength(3);
        expect(dto!.properties).toEqual(
            expect.arrayContaining([
                { name: 'name', type: 'string' },
                { name: 'age', type: 'int' },
                { name: 'role', type: 'UserRole' },
            ]),
        );
    });

    it('skips classes with no properties (only methods)', () => {
        const root = parsePHP(`
class ServiceHandler {
    public function handle(): void {
        echo "hello";
    }
}
`);
        const defs = phpPlugin.extractTypeDefinitions!(root);
        expect(defs.size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHP: extractReferencedTypes
// ═══════════════════════════════════════════════════════════════════════════════

describe('PHP: extractReferencedTypes', () => {
    it('extracts parameter types (filtering primitives)', () => {
        const root = parsePHP(`
class OrderService {
    public function saveQuote(QuoteRequestDTO $request, string $note): void {
        // body
    }
}
`);
        const refs = phpPlugin.extractReferencedTypes!(root);
        const funcRefs = refs.get('OrderService.saveQuote');
        expect(funcRefs).toBeDefined();
        expect(funcRefs).toContain('QuoteRequestDTO');
        // string and void are primitives — must NOT appear
        expect(funcRefs).not.toContain('string');
        expect(funcRefs).not.toContain('void');
    });

    it('extracts new expression targets', () => {
        const root = parsePHP(`
class Factory {
    public function create(): void {
        $dto = new QuoteResponse();
        $service = new PartnerApiClient();
    }
}
`);
        const refs = phpPlugin.extractReferencedTypes!(root);
        const funcRefs = refs.get('Factory.create');
        expect(funcRefs).toBeDefined();
        expect(funcRefs).toContain('QuoteResponse');
        expect(funcRefs).toContain('PartnerApiClient');
    });

    it('returns empty for functions using only primitives', () => {
        const root = parsePHP(`
function calculate(int $x, float $y): string {
    return (string)($x + $y);
}
`);
        const refs = phpPlugin.extractReferencedTypes!(root);
        expect(refs.has('calculate')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TypeScript: extractTypeDefinitions
// ═══════════════════════════════════════════════════════════════════════════════

describe('TypeScript: extractTypeDefinitions', () => {
    it('extracts interface property signatures', () => {
        const root = parseTS(`
export interface OrderPayload {
    orderId: string;
    customerId: number;
    items: OrderItem[];
    metadata: Record<string, unknown>;
}
`);
        const defs = tsPlugin.extractTypeDefinitions!(root);
        expect(defs.size).toBe(1);

        const iface = defs.get('OrderPayload');
        expect(iface).toBeDefined();
        expect(iface!.kind).toBe('interface');
        expect(iface!.properties.length).toBeGreaterThanOrEqual(3);
        expect(iface!.properties.find(p => p.name === 'orderId')?.type).toBe('string');
    });

    it('extracts type alias with object shape', () => {
        const root = parseTS(`
type CreateUserInput = {
    email: string;
    name: string;
    role: UserRole;
};
`);
        const defs = tsPlugin.extractTypeDefinitions!(root);
        expect(defs.size).toBe(1);

        const typeDef = defs.get('CreateUserInput');
        expect(typeDef).toBeDefined();
        expect(typeDef!.kind).toBe('type');
        expect(typeDef!.properties).toHaveLength(3);
    });

    it('extracts class fields', () => {
        const root = parseTS(`
class UserEntity {
    id: string;
    email: string;
    createdAt: Date;
}
`);
        const defs = tsPlugin.extractTypeDefinitions!(root);
        const cls = defs.get('UserEntity');
        expect(cls).toBeDefined();
        expect(cls!.kind).toBe('class');
        expect(cls!.properties.length).toBeGreaterThanOrEqual(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TypeScript: extractReferencedTypes
// ═══════════════════════════════════════════════════════════════════════════════

describe('TypeScript: extractReferencedTypes', () => {
    it('extracts parameter type annotations', () => {
        const root = parseTS(`
class OrderService {
    async processOrder(order: OrderPayload): Promise<OrderResult> {
        return new OrderResult();
    }
}
`);
        const refs = tsPlugin.extractReferencedTypes!(root);
        const funcRefs = refs.get('OrderService.processOrder');
        expect(funcRefs).toBeDefined();
        expect(funcRefs).toContain('OrderPayload');
        expect(funcRefs).toContain('OrderResult');
    });

    it('filters out built-in constructors', () => {
        const root = parseTS(`
function buildResponse() {
    const date = new Date();
    const map = new Map();
    const dto = new ResponseDTO();
}
`);
        const refs = tsPlugin.extractReferencedTypes!(root);
        const funcRefs = refs.get('buildResponse');
        expect(funcRefs).toBeDefined();
        expect(funcRefs).toContain('ResponseDTO');
        expect(funcRefs).not.toContain('Date');
        expect(funcRefs).not.toContain('Map');
    });

    it('returns empty for functions using only primitives', () => {
        const root = parseTS(`
function add(a: number, b: number): number {
    return a + b;
}
`);
        const refs = tsPlugin.extractReferencedTypes!(root);
        expect(refs.has('add')).toBe(false);
    });
});
