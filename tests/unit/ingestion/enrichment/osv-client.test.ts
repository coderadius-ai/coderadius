import { describe, it, expect } from 'vitest';
import {
    extractSeverity,
    extractFixedVersion,
    extractIntroducedVersion,
    cvssScoreToSeverity,
    chunkArray,
    hydrateResults,
    makeCacheKey,
    type OsvVulnerability,
} from '../../../../src/ingestion/enrichment/osv-client.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const GHSA_FIXTURE: OsvVulnerability = {
    id: 'GHSA-abcd-1234-efgh',
    aliases: ['CVE-2023-29197'],
    summary: 'HTTP multipart parsing vulnerability in Guzzle',
    severity: [
        // Real OSV vectors carry no numeric score suffix.
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H' },
    ],
    database_specific: { severity: 'HIGH' },
    affected: [{
        package: { ecosystem: 'Packagist', name: 'guzzlehttp/guzzle' },
        ranges: [{
            type: 'ECOSYSTEM',
            events: [{ introduced: '7.0.0' }, { fixed: '7.5.1' }],
        }],
        versions: ['7.0.0', '7.1.0', '7.2.0', '7.3.0', '7.4.0', '7.5.0'],
    }],
    references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-abcd-1234-efgh' }],
    published: '2023-04-12T00:00:00Z',
    modified: '2023-04-15T00:00:00Z',
};

const NO_CVSS_FIXTURE: OsvVulnerability = {
    id: 'PYSEC-2024-001',
    summary: 'Deserialization vulnerability',
    affected: [{
        package: { ecosystem: 'PyPI', name: 'pyyaml' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '3.0' }, { fixed: '6.0.1' }] }],
    }],
};

const WITHDRAWN_FIXTURE: OsvVulnerability = {
    id: 'GO-2024-0001',
    summary: 'False positive withdrawn advisory',
    withdrawn: '2024-01-15T00:00:00Z',
    affected: [{
        package: { ecosystem: 'Go', name: 'github.com/example/pkg' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
    }],
};

const MULTI_RANGE_FIXTURE: OsvVulnerability = {
    id: 'GHSA-multi-range',
    summary: 'Multiple affected ranges',
    affected: [
        {
            package: { ecosystem: 'npm', name: 'lodash' },
            ranges: [
                { type: 'ECOSYSTEM', events: [{ introduced: '4.0.0' }] },
                { type: 'ECOSYSTEM', events: [{ introduced: '3.0.0' }, { fixed: '3.10.2' }] },
            ],
        },
        {
            package: { ecosystem: 'npm', name: 'lodash' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.4.3' }] }],
        },
    ],
};

// ─── extractSeverity ────────────────────────────────────────────────────────

describe('extractSeverity', () => {
    it('prefers the advisory-declared severity and computes the score from the CVSS_V3 vector', () => {
        const result = extractSeverity(GHSA_FIXTURE);
        expect(result.severity).toBe('HIGH');
        expect(result.cvssScore).toBe(8.1);
        expect(result.cvssVector).toContain('CVSS:3.1');
    });

    it('maps GHSA MODERATE to MEDIUM', () => {
        const result = extractSeverity({ id: 'test', database_specific: { severity: 'MODERATE' } });
        expect(result.severity).toBe('MEDIUM');
    });

    it('falls back to the computed CVSS_V3 base score when no declared severity exists', () => {
        const vuln: OsvVulnerability = {
            id: 'test',
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        };
        const result = extractSeverity(vuln);
        expect(result.cvssScore).toBe(9.8);
        expect(result.severity).toBe('CRITICAL');
    });

    it('returns UNKNOWN when no severity data', () => {
        const result = extractSeverity(NO_CVSS_FIXTURE);
        expect(result.severity).toBe('UNKNOWN');
        expect(result.cvssScore).toBeUndefined();
        expect(result.cvssVector).toBeUndefined();
    });

    it('returns UNKNOWN for a CVSS_V4-only record without declared severity', () => {
        const vuln: OsvVulnerability = {
            id: 'test',
            severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }],
        };
        const result = extractSeverity(vuln);
        expect(result.severity).toBe('UNKNOWN');
        expect(result.cvssVector).toContain('CVSS:4.0');
    });
});

// ─── hydrateResults ─────────────────────────────────────────────────────────

describe('hydrateResults', () => {
    it('replaces querybatch skeletons with hydrated records by id', () => {
        const skeleton: OsvVulnerability = { id: 'GHSA-abcd-1234-efgh', modified: '2023-04-15T00:00:00Z' };
        const results = new Map([['composer:guzzlehttp/guzzle:7.5.0', [skeleton]]]);
        const details = new Map([[GHSA_FIXTURE.id, GHSA_FIXTURE]]);

        const hydrated = hydrateResults(results, details);
        expect(hydrated.get('composer:guzzlehttp/guzzle:7.5.0')).toEqual([GHSA_FIXTURE]);
    });

    it('keeps the skeleton when hydration is missing for an id', () => {
        const skeleton: OsvVulnerability = { id: 'GHSA-miss-ing0-0000', modified: '2023-04-15T00:00:00Z' };
        const results = new Map([['npm:lodash:4.17.21', [skeleton]]]);

        const hydrated = hydrateResults(results, new Map());
        expect(hydrated.get('npm:lodash:4.17.21')).toEqual([skeleton]);
    });
});

// ─── cvssScoreToSeverity (boundary values) ──────────────────────────────────

describe('cvssScoreToSeverity', () => {
    it('returns UNKNOWN for undefined', () => expect(cvssScoreToSeverity(undefined)).toBe('UNKNOWN'));
    it('returns UNKNOWN for 0', () => expect(cvssScoreToSeverity(0)).toBe('UNKNOWN'));
    it('returns LOW for 0.1', () => expect(cvssScoreToSeverity(0.1)).toBe('LOW'));
    it('returns LOW for 3.9', () => expect(cvssScoreToSeverity(3.9)).toBe('LOW'));
    it('returns MEDIUM for 4.0', () => expect(cvssScoreToSeverity(4.0)).toBe('MEDIUM'));
    it('returns MEDIUM for 6.9', () => expect(cvssScoreToSeverity(6.9)).toBe('MEDIUM'));
    it('returns HIGH for 7.0', () => expect(cvssScoreToSeverity(7.0)).toBe('HIGH'));
    it('returns HIGH for 8.9', () => expect(cvssScoreToSeverity(8.9)).toBe('HIGH'));
    it('returns CRITICAL for 9.0', () => expect(cvssScoreToSeverity(9.0)).toBe('CRITICAL'));
    it('returns CRITICAL for 10.0', () => expect(cvssScoreToSeverity(10.0)).toBe('CRITICAL'));
});

// ─── extractFixedVersion ────────────────────────────────────────────────────

describe('extractFixedVersion', () => {
    it('extracts earliest fixed version from ranges', () => expect(extractFixedVersion(GHSA_FIXTURE)).toBe('7.5.1'));
    it('returns null when no fixed event', () => expect(extractFixedVersion(WITHDRAWN_FIXTURE)).toBeNull());
    it('extracts fix from ECOSYSTEM range type', () => expect(extractFixedVersion(NO_CVSS_FIXTURE)).toBe('6.0.1'));
    it('returns first fixed across multiple ranges', () => expect(extractFixedVersion(MULTI_RANGE_FIXTURE)).toBe('3.10.2'));
    it('returns null for empty vuln', () => expect(extractFixedVersion({ id: 'empty' })).toBeNull());
});

// ─── extractIntroducedVersion ───────────────────────────────────────────────

describe('extractIntroducedVersion', () => {
    it('extracts introduced version, skipping "0"', () => expect(extractIntroducedVersion(GHSA_FIXTURE)).toBe('7.0.0'));
    it('returns null when only "0" is introduced', () => expect(extractIntroducedVersion(WITHDRAWN_FIXTURE)).toBeNull());
    it('extracts introduced from non-zero value', () => expect(extractIntroducedVersion(NO_CVSS_FIXTURE)).toBe('3.0'));
    it('returns first non-zero introduced across ranges', () => expect(extractIntroducedVersion(MULTI_RANGE_FIXTURE)).toBe('4.0.0'));
    it('returns null for empty vuln', () => expect(extractIntroducedVersion({ id: 'empty' })).toBeNull());
});

// ─── chunkArray ─────────────────────────────────────────────────────────────

describe('chunkArray', () => {
    it('returns empty array for empty input', () => expect(chunkArray([], 10)).toEqual([]));
    it('returns single chunk when input fits', () => expect(chunkArray([1, 2, 3], 5)).toEqual([[1, 2, 3]]));
    it('splits evenly', () => expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]));
    it('handles remainder', () => expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
    it('handles chunk size of 1', () => expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]]));
    it('handles chunk size equal to length', () => expect(chunkArray([1, 2], 2)).toEqual([[1, 2]]));
});

// ─── makeCacheKey ───────────────────────────────────────────────────────────

describe('makeCacheKey', () => {
    it('joins ecosystem:name:version', () => expect(makeCacheKey('npm', 'lodash', '4.17.21')).toBe('npm:lodash:4.17.21'));
    it('preserves slashes in scoped packages', () => expect(makeCacheKey('npm', '@types/node', '20.0.0')).toBe('npm:@types/node:20.0.0'));
    it('preserves slashes in composer packages', () => expect(makeCacheKey('composer', 'guzzlehttp/guzzle', '7.5.0')).toBe('composer:guzzlehttp/guzzle:7.5.0'));
    it('handles go module paths', () => expect(makeCacheKey('go', 'github.com/aws/aws-sdk-go', 'v2.1.0')).toBe('go:github.com/aws/aws-sdk-go:v2.1.0'));
});
