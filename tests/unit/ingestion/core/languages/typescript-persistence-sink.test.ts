import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

import { TypeScriptPlugin } from '../../../../../src/ingestion/core/languages/typescript.js';

const plugin = new TypeScriptPlugin();

function parse(code: string) {
    return tsParser.parse(code).rootNode;
}

function methodRange(root: Parser.SyntaxNode, methodName: string): { start: number; end: number } | null {
    for (const child of root.children) {
        if (child.type === 'class_declaration') {
            const body = child.childForFieldName('body');
            if (!body) continue;
            for (const member of body.children) {
                if (member.type === 'method_definition') {
                    const name = member.childForFieldName('name');
                    if (name?.text === methodName) {
                        return { start: member.startPosition.row + 1, end: member.endPosition.row + 1 };
                    }
                }
            }
        }
    }
    return null;
}

describe('Gate 2 AST override: hasServiceCallsInRange on repository methods', () => {
    it('passes a method calling this.repository.save()', () => {
        const root = parse(`
class QuoteRepository {
    createQuote(data: any) {
        return this.repository.save(data);
    }
}
        `);
        const range = methodRange(root, 'createQuote')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('passes a method calling this.httpService.get() (non-TypeORM I/O)', () => {
        const root = parse(`
class PricingRepository {
    getPrice(id: string) {
        return this.httpService.get('/api/prices/' + id);
    }
}
        `);
        const range = methodRange(root, 'getPrice')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('passes a method calling this.emitter.publish() (broker I/O)', () => {
        const root = parse(`
class EventStore {
    publishEvent(event: any) {
        return this.emitter.publish('topic', event);
    }
}
        `);
        const range = methodRange(root, 'publishEvent')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('rejects a pure function with only standalone calls (no member expressions)', () => {
        const root = parse(`
class QuoteRepository {
    computeHash(data: string) {
        return parseInt(data, 16);
    }
}
        `);
        const range = methodRange(root, 'computeHash')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('rejects a method with only arithmetic and returns', () => {
        const root = parse(`
class QuoteRepository {
    calculateDiscount(price: number, pct: number) {
        return price * (1 - pct / 100);
    }
}
        `);
        const range = methodRange(root, 'calculateDiscount')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('passes any member expression call (catches all injected dependency patterns)', () => {
        const root = parse(`
class CacheStore {
    getCached(key: string) {
        return this.cacheManager.get(key);
    }
}
        `);
        const range = methodRange(root, 'getCached')!;
        expect(plugin.hasServiceCallsInRange(root, range.start, range.end)).toBe(true);
    });
});
