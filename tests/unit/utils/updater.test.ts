import { describe, it, expect } from 'vitest';
import { parseLatestReleaseTag } from '../../../src/utils/updater.js';

describe('parseLatestReleaseTag', () => {
    it('extracts the tag from a GitHub releases/latest response', () => {
        const body = JSON.stringify({ tag_name: 'v0.2.0', name: 'v0.2.0', draft: false });
        expect(parseLatestReleaseTag(body)).toBe('v0.2.0');
    });

    it('accepts tags without the v prefix', () => {
        expect(parseLatestReleaseTag(JSON.stringify({ tag_name: '1.4.2' }))).toBe('1.4.2');
    });

    it('returns null when tag_name is not a semver', () => {
        expect(parseLatestReleaseTag(JSON.stringify({ tag_name: 'nightly' }))).toBeNull();
    });

    it('returns null when tag_name is missing', () => {
        expect(parseLatestReleaseTag(JSON.stringify({ message: 'Not Found' }))).toBeNull();
    });

    it('returns null on malformed JSON', () => {
        expect(parseLatestReleaseTag('<!doctype html>')).toBeNull();
    });
});
