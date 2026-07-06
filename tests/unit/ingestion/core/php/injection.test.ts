import { describe, it, expect } from 'vitest';
import { phpRecognizesInjectedToken } from '../../../../../src/ingestion/core/languages/php/injection.js';

describe('phpRecognizesInjectedToken', () => {
    it('matches a property typed with the bare class name (same-namespace case)', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                '',
                ['this->client: InventoryGqlClient', 'this->token: string'],
            ),
        ).toBe(true);
    });

    it('matches a property typed with the leading-backslash FQCN', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                '',
                ['this->client: \\Acme\\Inventory\\InventoryGqlClient'],
            ),
        ).toBe(true);
    });

    it('matches a property whose type is a multi-segment qualified name', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                '',
                ['this->client: Inventory\\InventoryGqlClient'],
            ),
        ).toBe(true);
    });

    it('does not match a property typed with an unrelated class', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                '',
                ['this->client: SomethingElse', 'this->logger: LoggerInterface'],
            ),
        ).toBe(false);
    });

    it('does not match when classProperties is empty', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                'public function __construct() {}',
                [],
            ),
        ).toBe(false);
    });

    it('does not match a primitive type with the same short suffix', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\Client',
                '',
                ['this->name: string', 'this->id: int'],
            ),
        ).toBe(false);
    });

    it('rejects empty token gracefully', () => {
        expect(phpRecognizesInjectedToken('', '', ['this->client: InventoryGqlClient'])).toBe(false);
    });

    it('matches a bare-token (no namespace) configuration', () => {
        expect(
            phpRecognizesInjectedToken(
                'InventoryGqlClient',
                '',
                ['this->client: InventoryGqlClient'],
            ),
        ).toBe(true);
    });

    it('does not match a partial substring of the type', () => {
        // `Foo` should not match `FooFactory`
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Foo',
                '',
                ['this->factory: FooFactory'],
            ),
        ).toBe(false);
    });

    it('matches the first of multiple typed properties', () => {
        expect(
            phpRecognizesInjectedToken(
                'Acme\\Inventory\\InventoryGqlClient',
                '',
                [
                    'this->logger: LoggerInterface',
                    'this->cache: CacheItemPoolInterface',
                    'this->client: InventoryGqlClient',
                ],
            ),
        ).toBe(true);
    });
});
