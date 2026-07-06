import { describe, expect, it } from 'vitest';
import {
    canonicalizeBaseUrl,
    joinBaseUrlAndPath,
    parseBaseUrl,
} from '../../../src/utils/url-normalizer';

describe('parseBaseUrl', () => {
    it('parses scheme/host/port/basePath', () => {
        const p = parseBaseUrl('https://API.acme.COM:8443/v2/');
        expect(p).toEqual({ scheme: 'https', host: 'api.acme.com', port: 8443, basePath: '/v2' });
    });

    it('strips default ports (https:443, http:80)', () => {
        expect(parseBaseUrl('https://api.acme.com:443/v2')!.port).toBeUndefined();
        expect(parseBaseUrl('http://api.acme.com:80/v2')!.port).toBeUndefined();
    });

    it('strips trailing slash from basePath', () => {
        expect(parseBaseUrl('https://api.acme.com/v2/')!.basePath).toBe('/v2');
    });

    it('strips credentials', () => {
        const p = parseBaseUrl('https://user:secret@api.acme.com/v2');
        expect(p!.host).toBe('api.acme.com');
        expect(JSON.stringify(p)).not.toContain('secret');
        expect(JSON.stringify(p)).not.toContain('user:');
    });

    it('returns null for non-URL input', () => {
        expect(parseBaseUrl('not a url')).toBeNull();
        expect(parseBaseUrl('')).toBeNull();
    });

    it('handles base without basePath', () => {
        expect(parseBaseUrl('https://api.acme.com')).toEqual({ scheme: 'https', host: 'api.acme.com' });
    });
});

describe('canonicalizeBaseUrl', () => {
    it('round-trips parsed components', () => {
        expect(canonicalizeBaseUrl('https://API.acme.COM:443/v2/')).toBe('https://api.acme.com/v2');
        expect(canonicalizeBaseUrl('http://localhost:80/')).toBe('http://localhost');
        expect(canonicalizeBaseUrl('https://api.acme.com:8443/v2')).toBe('https://api.acme.com:8443/v2');
    });
});

describe('joinBaseUrlAndPath', () => {
    it('case 1: base with basePath + path without basePath prefix → concatenate', () => {
        expect(joinBaseUrlAndPath('https://api.acme.com/v2', '/orders'))
            .toBe('https://api.acme.com/v2/orders');
    });

    it('case 2: base with basePath + path that already includes basePath → no duplication', () => {
        expect(joinBaseUrlAndPath('https://api.acme.com/v2', '/v2/orders'))
            .toBe('https://api.acme.com/v2/orders');
        expect(joinBaseUrlAndPath('https://api.acme.com/v2', '/v2'))
            .toBe('https://api.acme.com/v2');
    });

    it('case 3: base without basePath + absolute path', () => {
        expect(joinBaseUrlAndPath('https://api.acme.com', '/orders'))
            .toBe('https://api.acme.com/orders');
    });

    it('case 4: base with trailing slash + relative path', () => {
        expect(joinBaseUrlAndPath('https://api.acme.com/', 'orders'))
            .toBe('https://api.acme.com/orders');
    });

    it('case 2 robust: only segment-boundary prefix match (path starting with /v2other should NOT dedup)', () => {
        // basePath '/v2', path '/v2other/x' — does NOT match /v2 + segment boundary
        expect(joinBaseUrlAndPath('https://api.acme.com/v2', '/v2other/x'))
            .toBe('https://api.acme.com/v2/v2other/x');
    });

    it('preserves explicit port', () => {
        expect(joinBaseUrlAndPath('https://api.acme.com:8443/v2', '/orders'))
            .toBe('https://api.acme.com:8443/v2/orders');
    });

    it('degrades gracefully on non-URL base', () => {
        expect(joinBaseUrlAndPath('not-a-url', '/orders'))
            .toBe('not-a-url/orders');
    });
});
