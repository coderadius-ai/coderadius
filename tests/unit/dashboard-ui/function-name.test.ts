import { describe, expect, it } from 'vitest';
import { splitQualifiedName } from '../../../packages/dashboard-ui/src/components/blast-radius/lib/function-name';

describe('splitQualifiedName', () => {
    it('returns the whole name as tail when there is no namespace separator', () => {
        expect(splitQualifiedName('OrdersService.create')).toEqual({ prefix: '', tail: 'OrdersService.create' });
        expect(splitQualifiedName('index::main')).toEqual({ prefix: '', tail: 'index::main' });
        expect(splitQualifiedName('POST /api/orders::__route_handler')).toEqual({ prefix: '', tail: 'POST /api/orders::__route_handler' });
    });

    it('splits a PHP FQCN at the last backslash', () => {
        expect(splitQualifiedName('Acme\\Inventory\\Repository\\OrderRepository.trace')).toEqual({
            prefix: 'Acme\\Inventory\\Repository\\',
            tail: 'OrderRepository.trace',
        });
    });

    it('keeps a leading backslash inside the dimmed prefix', () => {
        expect(splitQualifiedName('\\OrderRepository.find')).toEqual({
            prefix: '\\',
            tail: 'OrderRepository.find',
        });
    });

    it('does not split when the tail would be empty (trailing backslash)', () => {
        expect(splitQualifiedName('Acme\\Inventory\\')).toEqual({ prefix: '', tail: 'Acme\\Inventory\\' });
    });

    it('preserves the full name byte-for-byte across the split (copy/paste safety)', () => {
        const names = [
            'Acme\\Inventory\\Repository\\OrderRepository.findByIdBetweenDates',
            '\\Acme\\X.y',
            'plain_function',
            'Acme\\Inventory\\',
        ];
        for (const n of names) {
            const { prefix, tail } = splitQualifiedName(n);
            expect(prefix + tail).toBe(n);
        }
    });
});
