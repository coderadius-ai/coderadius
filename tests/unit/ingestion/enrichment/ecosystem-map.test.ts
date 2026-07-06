import { describe, it, expect } from 'vitest';
import { toOsvEcosystem } from '../../../../src/ingestion/enrichment/ecosystem-map.js';

describe('toOsvEcosystem', () => {
    it('maps npm to npm', () => {
        expect(toOsvEcosystem('npm')).toBe('npm');
    });

    it('maps composer to Packagist', () => {
        expect(toOsvEcosystem('composer')).toBe('Packagist');
    });

    it('maps go to Go', () => {
        expect(toOsvEcosystem('go')).toBe('Go');
    });

    it('maps pypi to PyPI', () => {
        expect(toOsvEcosystem('pypi')).toBe('PyPI');
    });

    it('returns undefined for unknown ecosystems', () => {
        expect(toOsvEcosystem('maven')).toBeUndefined();
        expect(toOsvEcosystem('rubygems')).toBeUndefined();
    });
});
