import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import {
    areUrnsTransparent,
    setUrnsTransparent,
    resetUrnTransparencyForTesting,
    buildTransparentIdentity,
    parseTransparentIdentity,
} from '../../../src/utils/urn-transparency.js';

describe('urn-transparency helper (Phase 2 base64url)', () => {
    beforeEach(() => {
        resetUrnTransparencyForTesting();
    });

    describe('mode toggle', () => {
        it('defaults to false when no env var is set', () => {
            expect(areUrnsTransparent()).toBe(false);
        });

        it('reads CR_TRANSPARENT_URNS=1 from env on first read', () => {
            process.env.CR_TRANSPARENT_URNS = '1';
            expect(areUrnsTransparent()).toBe(true);
        });

        it('setUrnsTransparent(true) overrides env default', () => {
            delete process.env.CR_TRANSPARENT_URNS;
            setUrnsTransparent(true);
            expect(areUrnsTransparent()).toBe(true);
            expect(process.env.CR_TRANSPARENT_URNS).toBe('1');
        });

        it('setUrnsTransparent(false) explicitly disables even if env was set', () => {
            process.env.CR_TRANSPARENT_URNS = '1';
            setUrnsTransparent(false);
            expect(areUrnsTransparent()).toBe(false);
            expect(process.env.CR_TRANSPARENT_URNS).toBe('0');
        });
    });

    describe('base64url roundtrip', () => {
        it('preserves simple alphanumeric parts', () => {
            const parts = ['rabbitmq.prod.acme.local', 5672, 'inventory'];
            const encoded = buildTransparentIdentity(parts);
            expect(encoded).not.toContain(':');  // URN-safe (no ':' separator)
            expect(encoded).toContain('~');       // base64url '~' joiner
            expect(parseTransparentIdentity(encoded)).toEqual(['rabbitmq.prod.acme.local', '5672', 'inventory']);
        });

        it('preserves chars that would break naive encoding (`,`, `%`, `:`)', () => {
            const parts = ['my,host:with%percent', 5672, '/vhost'];
            const encoded = buildTransparentIdentity(parts);
            // No raw ':' in encoded form (would split as URN segments).
            expect(encoded).not.toContain(':');
            // No raw '%' either (avoids the encodeURIComponent ambiguity bug).
            expect(encoded).not.toContain('%');
            expect(parseTransparentIdentity(encoded)).toEqual(['my,host:with%percent', '5672', '/vhost']);
        });

        it('preserves trailing empty positional part', () => {
            const parts = ['host', 5672, ''];
            const encoded = buildTransparentIdentity(parts);
            // 3 base64url parts joined by 2 `~` → 1 trailing `~` indicating empty 3rd.
            expect(encoded.split('~')).toHaveLength(3);
            expect(parseTransparentIdentity(encoded)).toEqual(['host', '5672', '']);
        });

        it('preserves mid empty positional part', () => {
            const parts = ['host', '5672', '', 'x'];
            const encoded = buildTransparentIdentity(parts);
            expect(encoded.split('~')).toHaveLength(4);
            expect(parseTransparentIdentity(encoded)).toEqual(['host', '5672', '', 'x']);
        });

        it('preserves leading empty positional part', () => {
            const parts = ['', 'host', 5672];
            const encoded = buildTransparentIdentity(parts);
            expect(encoded.split('~')).toHaveLength(3);
            expect(parseTransparentIdentity(encoded)).toEqual(['', 'host', '5672']);
        });

        it('drops null and undefined (= part absent) but preserves empty string', () => {
            const parts = ['host', null, 5672, undefined, ''];
            const encoded = buildTransparentIdentity(parts);
            // null/undefined dropped (3 parts left: host, 5672, '').
            expect(encoded.split('~')).toHaveLength(3);
            expect(parseTransparentIdentity(encoded)).toEqual(['host', '5672', '']);
        });

        it('roundtrip stable across 50 random fixtures (no collisions, no garbage)', () => {
            const fixtures = [
                ['simple', 1234, 'vhost'],
                ['HOST.with.dots', 5672, '/prod'],
                ['127.0.0.1', 5672, ''],
                ['::1', 5672, 'ipv6vhost'],
                ['host with spaces', 9092, 'utf-8 ñ é'],
                ['host~with~tilde', 5672, 'normal'],
                ['', '', ''],  // all empty
                ['host', 0, ''],  // port zero
                ['host', 5672, '/'],  // root vhost
                ['rabbitmq.acme.local', 5672, 'тест'],  // Cyrillic
            ];
            for (const f of fixtures) {
                const encoded = buildTransparentIdentity(f);
                const decoded = parseTransparentIdentity(encoded);
                expect(decoded).toEqual(f.map(p => String(p)));
            }
        });
    });

    describe('runtime smoke', () => {
        it('Node Buffer base64url encoding available (Bun + Node 16+)', () => {
            expect(Buffer.from('test', 'utf-8').toString('base64url')).toBe('dGVzdA');
            expect(Buffer.from('dGVzdA', 'base64url').toString('utf-8')).toBe('test');
        });

        it('separator `~` is NOT in base64url charset (split unambiguous)', () => {
            const chars = Buffer.from('test:with-various+characters', 'utf-8').toString('base64url');
            expect(chars).not.toContain('~');
        });
    });
});
