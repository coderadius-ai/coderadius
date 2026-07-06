import { describe, it, expect } from 'vitest';
import { detectTyposquat } from '../../../../src/ai/agents/sink-classifier/typosquat.js';

describe('typosquat detector', () => {
    it('detects common 1-edit typosquats of known sinks', () => {
        expect(detectTyposquat('expreess')).toBe('express');
        expect(detectTyposquat('axioos')).toBe('axios');
        expect(detectTyposquat('lodahs')).toBeNull(); // 2-edit (transposition counts as 2) — too far
        expect(detectTyposquat('stripee')).toBe('stripe');
        expect(detectTyposquat('reddis')).toBe('redis');
    });

    it('returns null for the well-known package itself', () => {
        expect(detectTyposquat('axios')).toBeNull();
        expect(detectTyposquat('express')).toBeNull();
    });

    it('returns null for unrelated names', () => {
        expect(detectTyposquat('@acme-corp/internal-billing')).toBeNull();
        expect(detectTyposquat('@google-cloud/pubsub')).toBeNull();
    });

    it('skips names ≤ 3 chars (too noisy)', () => {
        expect(detectTyposquat('pg')).toBeNull();
        expect(detectTyposquat('ws')).toBeNull();
    });

    it('case-insensitive match', () => {
        expect(detectTyposquat('AXIOOS')).toBe('axios');
    });
});
