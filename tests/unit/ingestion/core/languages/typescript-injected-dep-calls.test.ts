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
        if (child.type === 'class_declaration' || child.type === 'class') {
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

function funcRange(root: Parser.SyntaxNode, funcName: string): { start: number; end: number } | null {
    for (const child of root.children) {
        if (child.type === 'function_declaration' || child.type === 'export_statement') {
            const fn = child.type === 'export_statement' ? child.children.find(c => c.type === 'function_declaration') : child;
            if (!fn) continue;
            const name = fn.childForFieldName('name');
            if (name?.text === funcName) {
                return { start: fn.startPosition.row + 1, end: fn.endPosition.row + 1 };
            }
        }
    }
    return null;
}

describe('hasInjectedDependencyCallsInRange (P3 io-caller vs io-adjacent)', () => {
    it('passes: this.repo.findOne() — direct injected call', () => {
        const root = parse(`
class QuoteService {
    async findById(id: string) {
        return this.repo.findOne({ where: { id } });
    }
}
        `);
        const range = methodRange(root, 'findById')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('passes: this.httpService.get() — non-TypeORM injected call', () => {
        const root = parse(`
class PricingRepository {
    async getPrice(id: string) {
        return this.httpService.get('/prices/' + id);
    }
}
        `);
        const range = methodRange(root, 'getPrice')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('passes: this.emitter.publish() — broker call', () => {
        const root = parse(`
class EventService {
    async emit(event: any) {
        await this.emitter.publish('topic', event);
    }
}
        `);
        const range = methodRange(root, 'emit')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('passes: this.cache.manager.get() — deep this chain', () => {
        const root = parse(`
class CacheService {
    async getCached(key: string) {
        return this.cache.manager.get(key);
    }
}
        `);
        const range = methodRange(root, 'getCached')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(true);
    });

    it('rejects: quote.price.toFixed() — local variable member call', () => {
        const root = parse(`
class QuoteService {
    formatPrice(quote: Quote) {
        return quote.price.toFixed(2);
    }
}
        `);
        const range = methodRange(root, 'formatPrice')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('rejects: date.toISOString() — built-in method on local', () => {
        const root = parse(`
class QuoteService {
    formatDate(date: Date) {
        return date.toISOString();
    }
}
        `);
        const range = methodRange(root, 'formatDate')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('rejects: pure arithmetic with no calls', () => {
        const root = parse(`
class Calculator {
    discount(price: number, pct: number) {
        return price * (1 - pct / 100);
    }
}
        `);
        const range = methodRange(root, 'discount')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('rejects: standalone function with param member calls', () => {
        const root = parse(`
export function validateQuote(quote: Quote): boolean {
    return quote.price > 0 && quote.id.length > 0;
}
        `);
        const range = funcRange(root, 'validateQuote')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('rejects: array.map/filter on local data', () => {
        const root = parse(`
class QuoteService {
    getIds(quotes: Quote[]) {
        return quotes.map(q => q.id).filter(id => id !== null);
    }
}
        `);
        const range = methodRange(root, 'getIds')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(false);
    });

    it('passes: mixed local + this calls (conservative)', () => {
        const root = parse(`
class QuoteService {
    async process(quote: Quote) {
        const formatted = quote.price.toFixed(2);
        await this.repo.save({ ...quote, formatted });
    }
}
        `);
        const range = methodRange(root, 'process')!;
        expect(plugin.hasInjectedDependencyCallsInRange(root, range.start, range.end)).toBe(true);
    });
});
