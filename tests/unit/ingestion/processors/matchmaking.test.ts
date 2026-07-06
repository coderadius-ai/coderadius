import { describe, it, expect } from 'vitest';
import { cosineSimilarity, extractClassBaseName } from '../../../../src/ingestion/processors/matchmaking.js';

describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
        const vec = [1, 2, 3, 4, 5];
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
        const a = [1, 0, 0];
        const b = [0, 1, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it('should return -1 for anti-parallel vectors', () => {
        const a = [1, 2, 3];
        const b = [-1, -2, -3];
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it('should return 0 for zero-length vectors', () => {
        const a = [0, 0, 0];
        const b = [1, 2, 3];
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('should handle high-dimensional vectors (typical embedding size)', () => {
        // Simulate 768-dim embeddings
        const a = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1));
        const b = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1 + 0.01)); // Slightly shifted
        const similarity = cosineSimilarity(a, b);
        // Should be very close to 1 (vectors are almost identical)
        expect(similarity).toBeGreaterThan(0.99);
    });
});

describe('extractClassBaseName', () => {
    // — PHP Controller patterns (Slim, Symfony, Laravel) —
    it('should extract class base from PHP FQN OrderController.handle', () => {
        expect(extractClassBaseName('Billing\\OrderController.handle')).toBe('order');
    });

    it('should extract class base from PHP FQN CompanyOrderController.handle', () => {
        expect(extractClassBaseName('Billing\\CompanyOrderController.handle')).toBe('companyorder');
    });

    it('should extract class base from PHP FQN UpdateSaveController.handle', () => {
        expect(extractClassBaseName('Billing\\UpdateSaveController.handle')).toBe('updatesave');
    });

    it('should extract class base from PHP FQN MarkCompanyOrderController.handle', () => {
        expect(extractClassBaseName('Billing\\MarkCompanyOrderController.handle')).toBe('markcompanyorder');
    });

    // — Handler suffix —
    it('should strip Handler suffix', () => {
        expect(extractClassBaseName('Acme\\Crm\\Core\\UpdateOrder\\Handler\\UpdateOrderHandler.handle')).toBe('updateorder');
    });

    // — Command suffix —
    it('should strip Command suffix for execute method', () => {
        expect(extractClassBaseName('Acme\\Crm\\Core\\Sync\\DynamicSyncCommand.execute')).toBe('dynamicsync');
    });

    // — Non-entry-point methods should return null —
    it('should return null for non-entry-point method (parseXml)', () => {
        expect(extractClassBaseName('Acme\\Crm\\Core\\Utility.parseXml')).toBeNull();
    });

    it('should return null for non-entry-point method (save)', () => {
        expect(extractClassBaseName('Platform\\Persistence.save')).toBeNull();
    });

    it('should return null for non-entry-point method (sanitize)', () => {
        expect(extractClassBaseName('Platform_Global.sanitize')).toBeNull();
    });

    // — Global functions (no class) —
    it('should return null for global functions without class', () => {
        expect(extractClassBaseName('some_global_function')).toBeNull();
    });

    it('should return null for PHP-style global function main', () => {
        expect(extractClassBaseName('shared_common::main')).toBeNull();
    });

    // — __invoke —
    it('should match __invoke as entry method', () => {
        expect(extractClassBaseName('App\\Controller\\OrderController.__invoke')).toBe('order');
    });

    // — Action suffix —
    it('should strip Action suffix', () => {
        expect(extractClassBaseName('App\\Controller\\CreateUserAction.execute')).toBe('createuser');
    });

    // — Edge case: class name is entirely the suffix —
    it('should return null when class name is entirely the suffix', () => {
        expect(extractClassBaseName('App\\Controller.handle')).toBeNull();
    });
});
