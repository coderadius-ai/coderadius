import { describe, it, expect } from 'vitest';
import { slugifyTenant } from '../../../src/config/tenant.js';

describe('slugifyTenant', () => {
    it('lowercases and hyphenates words', () => {
        expect(slugifyTenant('Acme Inc')).toBe('acme-inc');
    });

    it('treats punctuation as separators', () => {
        expect(slugifyTenant('Acme.example')).toBe('acme-example');
        expect(slugifyTenant('A / B & C')).toBe('a-b-c');
    });

    it('trims surrounding whitespace and stray separators', () => {
        expect(slugifyTenant('  Acme.example  ')).toBe('acme-example');
        expect(slugifyTenant('--Acme--')).toBe('acme');
    });

    it('strips diacritics', () => {
        expect(slugifyTenant('Già Fatto')).toBe('gia-fatto');
    });

    it('returns empty string when nothing slug-able remains', () => {
        expect(slugifyTenant('!!!')).toBe('');
    });

    it('preserves an already-canonical slug', () => {
        expect(slugifyTenant('coderadius-ai')).toBe('coderadius-ai');
    });
});
