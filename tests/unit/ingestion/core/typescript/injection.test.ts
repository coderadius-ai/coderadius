import { describe, it, expect } from 'vitest';
import { typescriptRecognizesInjectedToken } from '../../../../../src/ingestion/core/languages/typescript/injection.js';

describe('typescriptRecognizesInjectedToken', () => {
    it('matches an @Inject(token) parameter decorator', () => {
        expect(
            typescriptRecognizesInjectedToken(
                'CLIENT$TOKEN',
                'constructor(@Inject(CLIENT$TOKEN) private readonly client: GraphQLClient) {}',
                [],
            ),
        ).toBe(true);
    });

    it('does not match an unrelated token in the same constructor', () => {
        expect(
            typescriptRecognizesInjectedToken(
                'OTHER_TOKEN',
                'constructor(@Inject(CLIENT$TOKEN) private readonly client: GraphQLClient) {}',
                [],
            ),
        ).toBe(false);
    });

    it('handles tokens with regex-special characters', () => {
        expect(
            typescriptRecognizesInjectedToken(
                'CLIENT.PROVIDER',
                'constructor(@Inject(CLIENT.PROVIDER) c) {}',
                [],
            ),
        ).toBe(true);
        expect(
            typescriptRecognizesInjectedToken(
                'CLIENT.PROVIDER',
                'constructor(@Inject(CLIENTXPROVIDER) c) {}',
                [],
            ),
        ).toBe(false);
    });

    it('returns false when constructorSource is empty', () => {
        expect(typescriptRecognizesInjectedToken('TOKEN', '', [])).toBe(false);
    });

    it('returns false when token is empty', () => {
        expect(typescriptRecognizesInjectedToken('', 'constructor(@Inject(TOKEN) c) {}', [])).toBe(false);
    });
});
